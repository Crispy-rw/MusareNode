'use strict';

const async = require('async');
const config = require('config');
const request = require('request');
const bcrypt = require('bcrypt');

const db = require('../db');
const mail = require('../mail');
const cache = require('../cache');
const utils = require('../utils');
const hooks = require('./hooks');
const sha256 = require('sha256');
const logger = require('../logger');

cache.sub('user.updateUsername', user => {
	utils.socketsFromUser(user._id, sockets => {
		sockets.forEach(socket => {
			socket.emit('event:user.username.changed', user.username);
		});
	});
});

cache.sub('user.linkPassword', userId => {
	console.log("LINK4", userId);
	utils.socketsFromUser(userId, sockets => {
		sockets.forEach(socket => {
			socket.emit('event:user.linkPassword');
		});
	});
});

cache.sub('user.linkGitHub', userId => {
	console.log("LINK1", userId);
	utils.socketsFromUser(userId, sockets => {
		sockets.forEach(socket => {
			socket.emit('event:user.linkGitHub');
		});
	});
});

cache.sub('user.unlinkPassword', userId => {
	console.log("LINK2", userId);
	utils.socketsFromUser(userId, sockets => {
		sockets.forEach(socket => {
			socket.emit('event:user.unlinkPassword');
		});
	});
});

cache.sub('user.unlinkGitHub', userId => {
	console.log("LINK3", userId);
	utils.socketsFromUser(userId, sockets => {
		sockets.forEach(socket => {
			socket.emit('event:user.unlinkGitHub');
		});
	});
});

module.exports = {

	/**
	 * Lists all Users
	 *
	 * @param {Object} session - the session object automatically added by socket.io
	 * @param {Function} cb - gets called with the result
	 */
	index: hooks.adminRequired((session, cb) => {
		async.waterfall([
			(next) => {
				db.models.user.find({}).exec(next);
			}
		], (err, users) => {
			if (err) {
				err = utils.getError(err);
				logger.error("USER_INDEX", `Indexing users failed. "${err}"`);
				return cb({status: 'failure', message: err});
			} else {
				logger.success("USER_INDEX", `Indexing users successful.`);
				let filteredUsers = [];
				users.forEach(user => {
					filteredUsers.push({
						_id: user._id,
						username: user.username,
						role: user.role,
						liked: user.liked,
						disliked: user.disliked,
						songsRequested: user.statistics.songsRequested,
						email: {
							address: user.email.address,
							verified: user.email.verified
						},
						hasPassword: !!user.services.password,
						services: { github: user.services.github }
					});
				});
				return cb({ status: 'success', data: filteredUsers });
			}
		});
	}),

	/**
	 * Logs user in
	 *
	 * @param {Object} session - the session object automatically added by socket.io
	 * @param {String} identifier - the email of the user
	 * @param {String} password - the plaintext of the user
	 * @param {Function} cb - gets called with the result
	 */
	login: (session, identifier, password, cb) => {

		identifier = identifier.toLowerCase();

		async.waterfall([

			// check if a user with the requested identifier exists
			(next) => {
				db.models.user.findOne({
					$or: [{ 'email.address': identifier }]
				}, next)
			},

			// if the user doesn't exist, respond with a failure
			// otherwise compare the requested password and the actual users password
			(user, next) => {
				if (!user) return next('User not found');
				if (!user.services.password || !user.services.password.password) return next('The account you are trying to access uses GitHub to log in.');
				bcrypt.compare(sha256(password), user.services.password.password, (err, match) => {
					if (err) return next(err);
					if (!match) return next('Incorrect password');
					next(null, user);
				});
			},

			(user, next) => {
				let sessionId = utils.guid();
				cache.hset('sessions', sessionId, cache.schemas.session(sessionId, user._id), (err) => {
					if (err) return next(err);
					next(null, sessionId);
				});
			}

		], (err, sessionId) => {
			if (err && err !== true) {
				err = utils.getError(err);
				logger.error("USER_PASSWORD_LOGIN", `Login failed with password for user "${identifier}". "${err}"`);
				return cb({status: 'failure', message: err});
			}
			logger.success("USER_PASSWORD_LOGIN", `Login successful with password for user "${identifier}"`);
			cb({ status: 'success', message: 'Login successful', user: {}, SID: sessionId });
		});

	},

	/**
	 * Registers a new user
	 *
	 * @param {Object} session - the session object automatically added by socket.io
	 * @param {String} username - the username for the new user
	 * @param {String} email - the email for the new user
	 * @param {String} password - the plaintext password for the new user
	 * @param {Object} recaptcha - the recaptcha data
	 * @param {Function} cb - gets called with the result
	 */
	register: function(session, username, email, password, recaptcha, cb) {
		email = email.toLowerCase();
		let verificationToken = utils.generateRandomString(64);
		async.waterfall([

			// verify the request with google recaptcha
			(next) => {
				if (!db.passwordValid(password)) return next('Invalid password. Check if it meets all the requirements.');
				return next();
			},

			(next) => {
				request({
					url: 'https://www.google.com/recaptcha/api/siteverify',
					method: 'POST',
					form: {
						'secret': config.get("apis").recaptcha.secret,
						'response': recaptcha
					}
				}, next);
			},

			// check if the response from Google recaptcha is successful
			// if it is, we check if a user with the requested username already exists
			(response, body, next) => {
				let json = JSON.parse(body);
				if (json.success !== true) return next('Response from recaptcha was not successful.');
				db.models.user.findOne({ username: new RegExp(`^${username}$`, 'i') }, next);
			},

			// if the user already exists, respond with that
			// otherwise check if a user with the requested email already exists
			(user, next) => {
				if (user) return next('A user with that username already exists.');
				db.models.user.findOne({ 'email.address': email }, next);
			},

			// if the user already exists, respond with that
			// otherwise, generate a salt to use with hashing the new users password
			(user, next) => {
				if (user) return next('A user with that email already exists.');
				bcrypt.genSalt(10, next);
			},

			// hash the password
			(salt, next) => {
				bcrypt.hash(sha256(password), salt, next)
			},

			// save the new user to the database
			(hash, next) => {
				db.models.user.create({
					_id: utils.generateRandomString(12),//TODO Check if exists
					username,
					email: {
						address: email,
						verificationToken
					},
					services: {
						password: {
							password: hash
						}
					}
				}, next);
			},

			// respond with the new user
			(newUser, next) => {
				//TODO Send verification email
				mail.schemas.verifyEmail(email, username, verificationToken, () => {
					next();
				});
			}

		], (err) => {
			if (err && err !== true) {
				err = utils.getError(err);
				logger.error("USER_PASSWORD_REGISTER", `Register failed with password for user "${username}"."${err}"`);
				cb({status: 'failure', message: err});
			} else {
				module.exports.login(session, email, password, (result) => {
					let obj = {status: 'success', message: 'Successfully registered.'};
					if (result.status === 'success') {
						obj.SID = result.SID;
					}
					logger.success("USER_PASSWORD_REGISTER", `Register successful with password for user "${username}".`);
					cb(obj);
				});
			}
		});

	},

	/**
	 * Logs out a user
	 *
	 * @param {Object} session - the session object automatically added by socket.io
	 * @param {Function} cb - gets called with the result
	 */
	logout: (session, cb) => {

		async.waterfall([
			(next) => {
				cache.hget('sessions', session.sessionId, next);
			},

			(session, next) => {
				if (!session) return next('Session not found');
				next(null, session);
			},

			(session, next) => {
				cache.hdel('sessions', session.sessionId, next);
			}
		], (err) => {
			if (err && err !== true) {
				err = utils.getError(err);
				logger.error("USER_LOGOUT", `Logout failed. "${err}" `);
				cb({status: 'failure', message: err});
			} else {
				logger.success("USER_LOGOUT", `Logout successful.`);
				cb({status: 'success', message: 'Successfully logged out.'});
			}
		});

	},

	/**
	 * Gets user object from username (only a few properties)
	 *
	 * @param {Object} session - the session object automatically added by socket.io
	 * @param {String} username - the username of the user we are trying to find
	 * @param {Function} cb - gets called with the result
	 */
	findByUsername: (session, username, cb) => {
		async.waterfall([
			(next) => {
				db.models.user.findOne({ username: new RegExp(`^${username}$`, 'i') }, next);
			},

			(account, next) => {
				if (!account) return next('User not found.');
				next(null, account);
			}
		], (err, account) => {
			if (err && err !== true) {
				err = utils.getError(err);
				logger.error("FIND_BY_USERNAME", `User not found for username "${username}". "${err}"`);
				cb({status: 'failure', message: err});
			} else {
				logger.success("FIND_BY_USERNAME", `User found for username "${username}".`);
				return cb({
					status: 'success',
					data: {
						_id: account._id,
						username: account.username,
						role: account.role,
						email: account.email.address,
						createdAt: account.createdAt,
						statistics: account.statistics,
						liked: account.liked,
						disliked: account.disliked
					}
				});
			}
		});
	},

	//TODO Fix security issues
	/**
	 * Gets user info from session
	 *
	 * @param {Object} session - the session object automatically added by socket.io
	 * @param {Function} cb - gets called with the result
	 */
	findBySession: (session, cb) => {
		async.waterfall([
			(next) => {
				cache.hget('sessions', session.sessionId, next);
			},

			(session, next) => {
				if (!session) return next('Session not found.');
				next(null, session);
			},

			(session, next) => {
				db.models.user.findOne({ _id: session.userId }, next);
			},

			(user, next) => {
				if (!user) return next('User not found.');
				next(null, user);
			}
		], (err, user) => {
			if (err && err !== true) {
				err = utils.getError(err);
				logger.error("FIND_BY_SESSION", `User not found. "${err}"`);
				cb({status: 'failure', message: err});
			} else {
				let data = {
					email: {
						address: user.email.address
					},
					username: user.username
				};
				if (user.services.password && user.services.password.password) data.password = true;
				if (user.services.github && user.services.github.id) data.github = true;
				logger.success("FIND_BY_SESSION", `User found. "${user.username}".`);
				return cb({
					status: 'success',
					data
				});
			}
		});
	},

	/**
	 * Updates a user's username
	 *
	 * @param {Object} session - the session object automatically added by socket.io
	 * @param {String} updatingUserId - the updating user's id
	 * @param {String} newUsername - the new username
	 * @param {Function} cb - gets called with the result
	 * @param {String} userId - the userId automatically added by hooks
	 */
	updateUsername: hooks.loginRequired((session, updatingUserId, newUsername, cb, userId) => {
		async.waterfall([
			(next) => {
				if (updatingUserId === userId) return next(null, true);
				db.models.user.findOne({_id: userId}, next);
			},

			(user, next) => {
				if (user !== true && (!user || user.role !== 'admin')) return next('Invalid permissions.');
				db.models.user.findOne({ _id: updatingUserId }, next);
			},

			(user, next) => {
				if (!user) return next('User not found.');
				if (user.username === newUsername) return next('New username can\'t be the same as the old username.');
				next(null);
			},

			(next) => {
				db.models.user.findOne({ username: new RegExp(`^${newUsername}$`, 'i') }, next);
			},

			(user, next) => {
				if (!user) return next();
				if (user._id === updatingUserId) return next();
				next('That username is already in use.');
			},

			(next) => {
				db.models.user.update({ _id: updatingUserId }, {$set: {username: newUsername}}, {runValidators: true}, next);
			}
		], (err) => {
			if (err && err !== true) {
				err = utils.getError(err);
				logger.error("UPDATE_USERNAME", `Couldn't update username for user "${updatingUserId}" to username "${newUsername}". "${err}"`);
				cb({status: 'failure', message: err});
			} else {
				cache.pub('user.updateUsername', {
					username: newUsername,
					_id: updatingUserId
				});
				logger.success("UPDATE_USERNAME", `Updated username for user "${updatingUserId}" to username "${newUsername}".`);
				cb({ status: 'success', message: 'Username updated successfully' });
			}
		});
	}),

	/**
	 * Updates a user's email
	 *
	 * @param {Object} session - the session object automatically added by socket.io
	 * @param {String} updatingUserId - the updating user's id
	 * @param {String} newEmail - the new email
	 * @param {Function} cb - gets called with the result
	 * @param {String} userId - the userId automatically added by hooks
	 */
	updateEmail: hooks.loginRequired((session, updatingUserId, newEmail, cb, userId) => {
		newEmail = newEmail.toLowerCase();
		let verificationToken = utils.generateRandomString(64);
		async.waterfall([
			(next) => {
				if (updatingUserId === userId) return next(null, true);
				db.models.user.findOne({_id: userId}, next);
			},

			(user, next) => {
				if (user !== true && (!user || user.role !== 'admin')) return next('Invalid permissions.');
				db.models.user.findOne({ _id: updatingUserId }, next);
			},

			(user, next) => {
				if (!user) return next('User not found.');
				if (user.email.address === newEmail) return next('New email can\'t be the same as your the old email.');
				next();
			},

			(next) => {
				db.models.user.findOne({"email.address": newEmail}, next);
			},

			(user, next) => {
				if (!user) return next();
				if (user._id === updatingUserId) return next();
				next('That email is already in use.');
			},

			(next) => {
				db.models.user.update({_id: updatingUserId}, {$set: {"email.address": newEmail, "email.verified": false, "email.verificationToken": verificationToken}}, {runValidators: true}, next);
			},

			(res, next) => {
				db.models.user.findOne({ _id: updatingUserId }, next);
			},

			(user, next) => {
				mail.schemas.verifyEmail(newEmail, user.username, verificationToken, () => {
					next();
				});
			}
		], (err) => {
			if (err && err !== true) {
				err = utils.getError(err);
				logger.error("UPDATE_EMAIL", `Couldn't update email for user "${updatingUserId}" to email "${newEmail}". '${err}'`);
				cb({status: 'failure', message: err});
			} else {
				logger.success("UPDATE_EMAIL", `Updated email for user "${updatingUserId}" to email "${newEmail}".`);
				cb({ status: 'success', message: 'Email updated successfully.' });
			}
		});
	}),

	/**
	 * Updates a user's role
	 *
	 * @param {Object} session - the session object automatically added by socket.io
	 * @param {String} updatingUserId - the updating user's id
	 * @param {String} newRole - the new role
	 * @param {Function} cb - gets called with the result
	 * @param {String} userId - the userId automatically added by hooks
	 */
	updateRole: hooks.adminRequired((session, updatingUserId, newRole, cb, userId) => {
		newRole = newRole.toLowerCase();
		async.waterfall([

			(next) => {
				db.models.user.findOne({ _id: updatingUserId }, next);
			},

			(user, next) => {
				if (!user) return next('User not found.');
				else if (user.role === newRole) return next('New role can\'t be the same as the old role.');
				else return next();
			},
			(next) => {
				db.models.user.update({_id: updatingUserId}, {$set: {role: newRole}}, {runValidators: true}, next);
			}

		], (err) => {
			if (err && err !== true) {
				err = utils.getError(err);
				logger.error("UPDATE_ROLE", `User "${userId}" couldn't update role for user "${updatingUserId}" to role "${newRole}". "${err}"`);
				cb({status: 'failure', message: err});
			} else {
				logger.success("UPDATE_ROLE", `User "${userId}" updated the role of user "${updatingUserId}" to role "${newRole}".`);
				cb({
					status: 'success',
					message: 'Role successfully updated.'
				});
			}
		});
	}),

	/**
	 * Updates a user's password
	 *
	 * @param {Object} session - the session object automatically added by socket.io
	 * @param {String} newPassword - the new password
	 * @param {Function} cb - gets called with the result
	 * @param {String} userId - the userId automatically added by hooks
	 */
	updatePassword: hooks.loginRequired((session, newPassword, cb, userId) => {
		async.waterfall([
			(next) => {
				db.models.user.findOne({_id: userId}, next);
			},

			(user, next) => {
				if (!user.services.password) return next('This account does not have a password set.');
				next();
			},

			(next) => {
				if (!db.passwordValid(newPassword)) return next('Invalid password. Check if it meets all the requirements.');
				return next();
			},

			(next) => {
				bcrypt.genSalt(10, next);
			},

			// hash the password
			(salt, next) => {
				bcrypt.hash(sha256(newPassword), salt, next);
			},

			(hashedPassword, next) => {
				db.models.user.update({_id: userId}, {$set: {"services.password.password": hashedPassword}}, next);
			}
		], (err) => {
			if (err) {
				err = utils.getError(err);
				logger.error("UPDATE_PASSWORD", `Failed updating user password of user '${userId}'. '${err}'.`);
				return cb({ status: 'failure', message: err });
			}

			logger.success("UPDATE_PASSWORD", `User '${userId}' updated their password.`);
			cb({
				status: 'success',
				message: 'Password successfully updated.'
			});
		});
	}),

	/**
	 * Requests a password for a session
	 *
	 * @param {Object} session - the session object automatically added by socket.io
	 * @param {String} email - the email of the user that requests a password reset
	 * @param {Function} cb - gets called with the result
	 * @param {String} userId - the userId automatically added by hooks
	 */
	requestPassword: hooks.loginRequired((session, cb, userId) => {
		let code = utils.generateRandomString(8);
		async.waterfall([
			(next) => {
				db.models.user.findOne({_id: userId}, next);
			},

			(user, next) => {
				if (!user) return next('User not found.');
				if (user.services.password && user.services.password.password) return next('You already have a password set.');
				next(null, user);
			},

			(user, next) => {
				let expires = new Date();
				expires.setDate(expires.getDate() + 1);
				db.models.user.findOneAndUpdate({"email.address": user.email.address}, {$set: {"services.password": {set: {code: code, expires}}}}, {runValidators: true}, next);
			},

			(user, next) => {
				mail.schemas.passwordRequest(user.email.address, user.username, code, next);
			}
		], (err) => {
			if (err && err !== true) {
				err = utils.getError(err);
				logger.error("REQUEST_PASSWORD", `UserId '${userId}' failed to request password. '${err}'`);
				cb({status: 'failure', message: err});
			} else {
				logger.success("REQUEST_PASSWORD", `UserId '${userId}' successfully requested a password.`);
				cb({
					status: 'success',
					message: 'Successfully requested password.'
				});
			}
		});
	}),

	/**
	 * Verifies a password code
	 *
	 * @param {Object} session - the session object automatically added by socket.io
	 * @param {String} code - the password code
	 * @param {Function} cb - gets called with the result
	 * @param {String} userId - the userId automatically added by hooks
	 */
	verifyPasswordCode: hooks.loginRequired((session, code, cb, userId) => {
		async.waterfall([
			(next) => {
				if (!code || typeof code !== 'string') return next('Invalid code1.');
				db.models.user.findOne({"services.password.set.code": code, _id: userId}, next);
			},

			(user, next) => {
				if (!user) return next('Invalid code2.');
				if (user.services.password.set.expires < new Date()) return next('That code has expired.');
				next(null);
			}
		], (err) => {
			if (err && err !== true) {
				err = utils.getError(err);
				logger.error("VERIFY_PASSWORD_CODE", `Code '${code}' failed to verify. '${err}'`);
				cb({status: 'failure', message: err});
			} else {
				logger.success("VERIFY_PASSWORD_CODE", `Code '${code}' successfully verified.`);
				cb({
					status: 'success',
					message: 'Successfully verified password code.'
				});
			}
		});
	}),

	/**
	 * Adds a password to a user with a code
	 *
	 * @param {Object} session - the session object automatically added by socket.io
	 * @param {String} code - the password code
	 * @param {String} newPassword - the new password code
	 * @param {Function} cb - gets called with the result
	 * @param {String} userId - the userId automatically added by hooks
	 */
	changePasswordWithCode: hooks.loginRequired((session, code, newPassword, cb, userId) => {
		async.waterfall([
			(next) => {
				if (!code || typeof code !== 'string') return next('Invalid code1.');
				db.models.user.findOne({"services.password.set.code": code}, next);
			},

			(user, next) => {
				if (!user) return next('Invalid code2.');
				if (!user.services.password.set.expires > new Date()) return next('That code has expired.');
				next();
			},

			(next) => {
				if (!db.passwordValid(newPassword)) return next('Invalid password. Check if it meets all the requirements.');
				return next();
			},

			(next) => {
				bcrypt.genSalt(10, next);
			},

			// hash the password
			(salt, next) => {
				bcrypt.hash(sha256(newPassword), salt, next);
			},

			(hashedPassword, next) => {
				db.models.user.update({"services.password.set.code": code}, {$set: {"services.password.password": hashedPassword}, $unset: {"services.password.set": ''}}, {runValidators: true}, next);
			}
		], (err) => {
			if (err && err !== true) {
				err = utils.getError(err);
				logger.error("ADD_PASSWORD_WITH_CODE", `Code '${code}' failed to add password. '${err}'`);
				cb({status: 'failure', message: err});
			} else {
				logger.success("ADD_PASSWORD_WITH_CODE", `Code '${code}' successfully added password.`);
				cache.pub('user.linkPassword', userId);
				cb({
					status: 'success',
					message: 'Successfully added password.'
				});
			}
		});
	}),

	/**
	 * Unlinks password from user
	 *
	 * @param {Object} session - the session object automatically added by socket.io
	 * @param {Function} cb - gets called with the result
	 * @param {String} userId - the userId automatically added by hooks
	 */
	unlinkPassword: hooks.loginRequired((session, cb, userId) => {
		async.waterfall([
			(next) => {
				db.models.user.findOne({_id: userId}, next);
			},

			(user, next) => {
				if (!user) return next('Not logged in.');
				if (!user.services.github || !user.services.github.id) return next('You can\'t remove password login without having GitHub login.');
				db.models.user.update({_id: userId}, {$unset: {"services.password": ''}}, next);
			}
		], (err) => {
			if (err && err !== true) {
				err = utils.getError(err);
				logger.error("UNLINK_PASSWORD", `Unlinking password failed for userId '${userId}'. '${err}'`);
				cb({status: 'failure', message: err});
			} else {
				logger.success("UNLINK_PASSWORD", `Unlinking password successful for userId '${userId}'.`);
				cache.pub('user.unlinkPassword', userId);
				cb({
					status: 'success',
					message: 'Successfully unlinked password.'
				});
			}
		});
	}),

	/**
	 * Unlinks GitHub from user
	 *
	 * @param {Object} session - the session object automatically added by socket.io
	 * @param {Function} cb - gets called with the result
	 * @param {String} userId - the userId automatically added by hooks
	 */
	unlinkGitHub: hooks.loginRequired((session, cb, userId) => {
		async.waterfall([
			(next) => {
				db.models.user.findOne({_id: userId}, next);
			},

			(user, next) => {
				if (!user) return next('Not logged in.');
				if (!user.services.password || !user.services.password.password) return next('You can\'t remove GitHub login without having password login.');
				db.models.user.update({_id: userId}, {$unset: {"services.github": ''}}, next);
			}
		], (err) => {
			if (err && err !== true) {
				err = utils.getError(err);
				logger.error("UNLINK_GITHUB", `Unlinking GitHub failed for userId '${userId}'. '${err}'`);
				cb({status: 'failure', message: err});
			} else {
				logger.success("UNLINK_GITHUB", `Unlinking GitHub successful for userId '${userId}'.`);
				cache.pub('user.unlinkGitHub', userId);
				cb({
					status: 'success',
					message: 'Successfully unlinked GitHub.'
				});
			}
		});
	}),

	/**
	 * Requests a password reset for an email
	 *
	 * @param {Object} session - the session object automatically added by socket.io
	 * @param {String} email - the email of the user that requests a password reset
	 * @param {Function} cb - gets called with the result
	 */
	requestPasswordReset: (session, email, cb) => {
		let code = utils.generateRandomString(8);
		async.waterfall([
			(next) => {
				if (!email || typeof email !== 'string') return next('Invalid email.');
				email = email.toLowerCase();
				db.models.user.findOne({"email.address": email}, next);
			},

			(user, next) => {
				if (!user) return next('User not found.');
				if (!user.services.password || !user.services.password.password) return next('User does not have a password set, and probably uses GitHub to log in.');
				next(null, user);
			},

			(user, next) => {
				let expires = new Date();
				expires.setDate(expires.getDate() + 1);
				db.models.user.findOneAndUpdate({"email.address": email}, {$set: {"services.password.reset": {code: code, expires}}}, {runValidators: true}, next);
			},

			(user, next) => {
				mail.schemas.resetPasswordRequest(user.email.address, user.username, code, next);
			}
		], (err) => {
			if (err && err !== true) {
				err = utils.getError(err);
				logger.error("REQUEST_PASSWORD_RESET", `Email '${email}' failed to request password reset. '${err}'`);
				cb({status: 'failure', message: err});
			} else {
				logger.success("REQUEST_PASSWORD_RESET", `Email '${email}' successfully requested a password reset.`);
				cb({
					status: 'success',
					message: 'Successfully requested password reset.'
				});
			}
		});
	},

	/**
	 * Verifies a reset code
	 *
	 * @param {Object} session - the session object automatically added by socket.io
	 * @param {String} code - the password reset code
	 * @param {Function} cb - gets called with the result
	 */
	verifyPasswordResetCode: (session, code, cb) => {
		async.waterfall([
			(next) => {
				if (!code || typeof code !== 'string') return next('Invalid code.');
				db.models.user.findOne({"services.password.reset.code": code}, next);
			},

			(user, next) => {
				if (!user) return next('Invalid code.');
				if (!user.services.password.reset.expires > new Date()) return next('That code has expired.');
				next(null);
			}
		], (err) => {
			if (err && err !== true) {
				err = utils.getError(err);
				logger.error("VERIFY_PASSWORD_RESET_CODE", `Code '${code}' failed to verify. '${err}'`);
				cb({status: 'failure', message: err});
			} else {
				logger.success("VERIFY_PASSWORD_RESET_CODE", `Code '${code}' successfully verified.`);
				cb({
					status: 'success',
					message: 'Successfully verified password reset code.'
				});
			}
		});
	},

	/**
	 * Changes a user's password with a reset code
	 *
	 * @param {Object} session - the session object automatically added by socket.io
	 * @param {String} code - the password reset code
	 * @param {String} newPassword - the new password reset code
	 * @param {Function} cb - gets called with the result
	 */
	changePasswordWithResetCode: (session, code, newPassword, cb) => {
		async.waterfall([
			(next) => {
				if (!code || typeof code !== 'string') return next('Invalid code.');
				db.models.user.findOne({"services.password.reset.code": code}, next);
			},

			(user, next) => {
				if (!user) return next('Invalid code.');
				if (!user.services.password.reset.expires > new Date()) return next('That code has expired.');
				next();
			},

			(next) => {
				if (!db.passwordValid(newPassword)) return next('Invalid password. Check if it meets all the requirements.');
				return next();
			},

			(next) => {
				bcrypt.genSalt(10, next);
			},

			// hash the password
			(salt, next) => {
				bcrypt.hash(sha256(newPassword), salt, next);
			},

			(hashedPassword, next) => {
				db.models.user.update({"services.password.reset.code": code}, {$set: {"services.password.password": hashedPassword}, $unset: {"services.password.reset": ''}}, {runValidators: true}, next);
			}
		], (err) => {
			if (err && err !== true) {
				err = utils.getError(err);
				logger.error("CHANGE_PASSWORD_WITH_RESET_CODE", `Code '${code}' failed to change password. '${err}'`);
				cb({status: 'failure', message: err});
			} else {
				logger.success("CHANGE_PASSWORD_WITH_RESET_CODE", `Code '${code}' successfully changed password.`);
				cb({
					status: 'success',
					message: 'Successfully changed password.'
				});
			}
		});
	}
};
