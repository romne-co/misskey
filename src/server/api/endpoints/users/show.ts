/**
 * Module dependencies
 */
import $ from 'cafy'; import ID from '../../../../cafy-id';
import User, { pack } from '../../../../models/user';
import resolveRemoteUser from '../../../../remote/resolve-user';

const cursorOption = { fields: { data: false } };

/**
 * Show user(s)
 */
module.exports = (params, me) => new Promise(async (res, rej) => {
	let user;

	// Get 'userId' parameter
	const [userId, userIdErr] = $(params.userId).optional.type(ID).$;
	if (userIdErr) return rej('invalid userId param');

	// Get 'userIds' parameter
	const [userIds, userIdsErr] = $(params.userIds).optional.array($().type(ID)).$;
	if (userIdsErr) return rej('invalid userIds param');

	// Get 'username' parameter
	const [username, usernameErr] = $(params.username).optional.string().$;
	if (usernameErr) return rej('invalid username param');

	// Get 'host' parameter
	const [host, hostErr] = $(params.host).nullable.optional.string().$;
	if (hostErr) return rej('invalid host param');

	if (userIds) {
		const users = await User.find({
			_id: {
				$in: userIds
			}
		});

		res(await Promise.all(users.map(u => pack(u, me, {
			detail: true
		}))));
	} else {
		// Lookup user
		if (typeof host === 'string') {
			try {
				user = await resolveRemoteUser(username, host, cursorOption);
			} catch (e) {
				console.warn(`failed to resolve remote user: ${e}`);
				return rej('failed to resolve remote user');
			}
		} else {
			const q = userId !== undefined
				? { _id: userId }
				: { usernameLower: username.toLowerCase(), host: null };

			user = await User.findOne(q, cursorOption);

			if (user === null) {
				return rej('user not found');
			}
		}

		// Send response
		res(await pack(user, me, {
			detail: true
		}));
	}
});
