module.exports = {
	username: { type: String, required: true },
	role: { type: String, default: 'default', required: true },
	email: {
		verified: { type: Boolean, default: false, required: true },
		verificationToken: String,
		address: String
	},
	services: {
		password: {
			password: String
		},
		github: {
			id: Number,
		}
	},
	ban: {
		banned: { type: Boolean, default: false, required: true },
		reason: String,
		bannedAt: Date,
		bannedUntil: Date
	},
	statistics: {
		songsRequested: { type: Number, default: 0, required: true },
		songsDisliked: [{ type: String, default: '', required: true }],
		songsLiked: [{ type: String, default: '', required: true }]
	},
	liked: [{ type: String }],
	disliked: [{ type: String }],
	createdAt: { type: Date, default: Date.now() }
};
