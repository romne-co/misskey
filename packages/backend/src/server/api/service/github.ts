import Koa from 'koa';
import Router from '@koa/router';
import { OAuth2 } from 'oauth';
import { v4 as uuid } from 'uuid';
import { IsNull } from 'typeorm';
import { getJson } from '@/misc/fetch.js';
import config from '@/config/index.js';
import { publishMainStream } from '@/services/stream.js';
import { fetchMeta } from '@/misc/fetch-meta.js';
import { Users, UserProfiles } from '@/models/index.js';
import { ILocalUser } from '@/models/entities/user.js';
import { redisClient } from '../../../db/redis.js';
import signin from '../common/signin.js';

function getUserToken(ctx: Koa.BaseContext): string | null {
	return ((ctx.headers['cookie'] || '').match(/igi=(\w+)/) || [null, null])[1];
}

function compareOrigin(ctx: Koa.BaseContext): boolean {
	function normalizeUrl(url?: string): string {
		return url ? url.endsWith('/') ? url.substr(0, url.length - 1) : url : '';
	}

	const referer = ctx.headers['referer'];

	return (normalizeUrl(referer) === normalizeUrl(config.url));
}

// Init router
const router = new Router();

router.get('/disconnect/github', async ctx => {
	if (!compareOrigin(ctx)) {
		ctx.throw(400, 'invalid origin');
		return;
	}

	const userToken = getUserToken(ctx);
	if (!userToken) {
		ctx.throw(400, 'signin required');
		return;
	}

	const user = await Users.findOneByOrFail({
		host: IsNull(),
		token: userToken,
	});

	const profile = await UserProfiles.findOneByOrFail({ userId: user.id });

	delete profile.integrations.github;

	await UserProfiles.update(user.id, {
		integrations: profile.integrations,
	});

	ctx.body = 'GitHubの連携を解除しました :v:';

	// Publish i updated event
	publishMainStream(user.id, 'meUpdated', await Users.pack(user, user, {
		detail: true,
		includeSecrets: true,
	}));
});

async function getOath2() {
	const meta = await fetchMeta(true);

	if (meta.enableGithubIntegration && meta.githubClientId && meta.githubClientSecret) {
		return new OAuth2(
			meta.githubClientId,
			meta.githubClientSecret,
			'https://github.com/',
			'login/oauth/authorize',
			'login/oauth/access_token');
	} else {
		return null;
	}
}

router.get('/connect/github', async ctx => {
	if (!compareOrigin(ctx)) {
		ctx.throw(400, 'invalid origin');
		return;
	}

	const userToken = getUserToken(ctx);
	if (!userToken) {
		ctx.throw(400, 'signin required');
		return;
	}

	const params = {
		redirect_uri: `${config.url}/api/gh/cb`,
		scope: ['read:user'],
		state: uuid(),
	};

	redisClient.set(userToken, JSON.stringify(params));

	const oauth2 = await getOath2();
	ctx.redirect(oauth2!.getAuthorizeUrl(params));
});

router.get('/signin/github', async ctx => {
	const sessid = uuid();

	const params = {
		redirect_uri: `${config.url}/api/gh/cb`,
		scope: ['read:user'],
		state: uuid(),
	};

	ctx.cookies.set('signin_with_github_sid', sessid, {
		path: '/',
		secure: config.url.startsWith('https'),
		httpOnly: true,
	});

	redisClient.set(sessid, JSON.stringify(params));

	const oauth2 = await getOath2();
	ctx.redirect(oauth2!.getAuthorizeUrl(params));
});

router.get('/gh/cb', async ctx => {
	const userToken = getUserToken(ctx);

	const oauth2 = await getOath2();

	if (!userToken) {
		const sessid = ctx.cookies.get('signin_with_github_sid');

		if (!sessid) {
			ctx.throw(400, 'invalid session');
			return;
		}

		const code = ctx.query.code;

		if (!code || typeof code !== 'string') {
			ctx.throw(400, 'invalid session');
			return;
		}

		const { redirect_uri, state } = await new Promise<any>((res, rej) => {
			redisClient.get(sessid, async (_, state) => {
				res(JSON.parse(state));
			});
		});

		if (ctx.query.state !== state) {
			ctx.throw(400, 'invalid session');
			return;
		}

		const { accessToken } = await new Promise<any>((res, rej) =>
			oauth2!.getOAuthAccessToken(code, {
				redirect_uri,
			}, (err, accessToken, refresh, result) => {
				if (err) {
					rej(err);
				} else if (result.error) {
					rej(result.error);
				} else {
					res({ accessToken });
				}
			}));

		const { login, id } = (await getJson('https://api.github.com/user', 'application/vnd.github.v3+json', 10 * 1000, {
			'Authorization': `bearer ${accessToken}`,
		})) as Record<string, unknown>;
		if (typeof login !== 'string' || typeof id !== 'string') {
			ctx.throw(400, 'invalid session');
			return;
		}

		const link = await UserProfiles.createQueryBuilder()
			.where('"integrations"->\'github\'->>\'id\' = :id', { id: id })
			.andWhere('"userHost" IS NULL')
			.getOne();

		if (link == null) {
			ctx.throw(404, `@${login}と連携しているMisskeyアカウントはありませんでした...`);
			return;
		}

		signin(ctx, await Users.findOneBy({ id: link.userId }) as ILocalUser, true);
	} else {
		const code = ctx.query.code;

		if (!code || typeof code !== 'string') {
			ctx.throw(400, 'invalid session');
			return;
		}

		const { redirect_uri, state } = await new Promise<any>((res, rej) => {
			redisClient.get(userToken, async (_, state) => {
				res(JSON.parse(state));
			});
		});

		if (ctx.query.state !== state) {
			ctx.throw(400, 'invalid session');
			return;
		}

		const { accessToken } = await new Promise<any>((res, rej) =>
			oauth2!.getOAuthAccessToken(
				code,
				{ redirect_uri },
				(err, accessToken, refresh, result) => {
					if (err) {
						rej(err);
					} else if (result.error) {
						rej(result.error);
					} else {
						res({ accessToken });
					}
				}));

		const { login, id } = (await getJson('https://api.github.com/user', 'application/vnd.github.v3+json', 10 * 1000, {
			'Authorization': `bearer ${accessToken}`,
		})) as Record<string, unknown>;

		if (typeof login !== 'string' || typeof id !== 'string') {
			ctx.throw(400, 'invalid session');
			return;
		}

		const user = await Users.findOneByOrFail({
			host: IsNull(),
			token: userToken,
		});

		const profile = await UserProfiles.findOneByOrFail({ userId: user.id });

		await UserProfiles.update(user.id, {
			integrations: {
				...profile.integrations,
				github: {
					accessToken: accessToken,
					id: id,
					login: login,
				},
			},
		});

		ctx.body = `GitHub: @${login} を、Misskey: @${user.username} に接続しました！`;

		// Publish i updated event
		publishMainStream(user.id, 'meUpdated', await Users.pack(user, user, {
			detail: true,
			includeSecrets: true,
		}));
	}
});

export default router;
