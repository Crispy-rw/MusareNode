'use strict';

const cache = require('./cache');
const db = require('./db');
const io = require('./io');
const utils = require('./utils');
const logger = require('./logger');
const songs = require('./songs');
const notifications = require('./notifications');
const async = require('async');

//TEMP
cache.sub('station.pause', (stationId) => {
	notifications.remove(`stations.nextSong?id=${stationId}`);
});

cache.sub('station.resume', (stationId) => {
	module.exports.initializeStation(stationId)
});

cache.sub('station.queueUpdate', (stationId) => {
	module.exports.getStation(stationId, (err, station) => {
		if (!station.currentSong && station.queue.length > 0) {
			module.exports.initializeStation(stationId);
		}
	});
});

cache.sub('station.newOfficialPlaylist', (stationId) => {
	cache.hget("officialPlaylists", stationId, (err, playlistObj) => {
		if (!err && playlistObj) {
			utils.emitToRoom(`station.${stationId}`, "event:newOfficialPlaylist", playlistObj.songs);
		}
	})
});

module.exports = {

	init: function(cb) {
		async.waterfall([
			(next) => {
				cache.hgetall('stations', next);
			},

			(stations, next) => {
				if (!stations) return next();
				let stationIds = Object.keys(stations);
				async.each(stationIds, (stationId, next) => {
					db.models.station.findOne({_id: stationId}, (err, station) => {
						if (err) next(err);
						else if (!station) {
							cache.hdel('stations', stationId, next);
						} else next();
					});
				}, next);
			},

			(next) => {
				db.models.station.find({}, next);
			},

			(stations, next) => {
				async.each(stations, (station, next) => {
					async.waterfall([
						(next) => {
							cache.hset('stations', station._id, cache.schemas.station(station), next);
						},

						(station, next) => {
							this.initializeStation(station._id, next);
						}
					], (err) => {
						next(err);
					});
				}, next);
			}
		], (err) => {
			if (err) {
				console.log(`FAILED TO INITIALIZE STATIONS. ABORTING. "${err.message}"`);
				process.exit();
			} else cb();
		});
	},

	initializeStation: function(stationId, cb) {
		if (typeof cb !== 'function') cb = ()=>{};
		let _this = this;
		async.waterfall([
			(next) => {
				_this.getStation(stationId, next);
			},
			(station, next) => {
				if (!station) return next('Station not found.');
				notifications.subscribe(`stations.nextSong?id=${station._id}`, _this.skipStation(station._id), true);
				if (station.paused) {
					notifications.unschedule(`stations.nextSong?id${station._id}`);
					return next(true, station);
				}
				next(null, station);
			},
			(station, next) => {
				if (!station.currentSong) {
					return _this.skipStation(station._id)((err, station) => {
						if (err) return next(err);
						return next(true, station);
					});
				}
				let timeLeft = ((station.currentSong.duration * 1000) - (Date.now() - station.startedAt - station.timePaused));
				if (isNaN(timeLeft)) timeLeft = -1;
				if (station.currentSong.duration * 1000 < timeLeft || timeLeft < 0) {
					this.skipStation(station._id)((err, station) => {
						next(err, station);
					});
				} else {
					notifications.schedule(`stations.nextSong?id=${station._id}`, timeLeft);
					next(null, station);
				}
			}
		], (err, station) => {
			if (err && err !== true) return cb(err);
			cb(null, station);
		});
	},

	calculateSongForStation: function(station, cb) {
		let _this = this;
		let songList = [];
		async.waterfall([

			(next) => {
				let genresDone = [];
				station.genres.forEach((genre) => {
					db.models.song.find({genres: genre}, (err, songs) => {
						if (!err) {
							songs.forEach((song) => {
								if (songList.indexOf(song.songId) === -1) {
									let found = false;
									song.genres.forEach((songGenre) => {
										if (station.blacklistedGenres.indexOf(songGenre) !== -1) found = true;
									});
									if (!found) {
										songList.push(song.songId);
									}
								}
							});
						}
						genresDone.push(genre);
						if (genresDone.length === station.genres.length) next();
					});
				});
			},

			(next) => {
				let playlist = [];
				songList.forEach(function(songId) {
					if(station.playlist.indexOf(songId) === -1) playlist.push(songId);
				});
				station.playlist.filter((songId) => {
					if (songList.indexOf(songId) !== -1) playlist.push(songId);
				});

				playlist = utils.shuffle(playlist);

				_this.calculateOfficialPlaylistList(station._id, playlist, () => {
					next(null, playlist);
				});
			},

			(playlist, next) => {
				db.models.station.update({_id: station._id}, {$set: {playlist: playlist}}, {runValidators: true}, (err) => {
					_this.updateStation(station._id, () => {
						next(err, playlist);
					});
				});
			}

		], (err, newPlaylist) => {
			cb(err, newPlaylist);
		});
	},

	// Attempts to get the station from Redis. If it's not in Redis, get it from Mongo and add it to Redis.
	getStation: function(stationId, cb) {
		let _this = this;
		async.waterfall([

			(next) => {
				cache.hget('stations', stationId, next);
			},

			(station, next) => {
				if (station) return next(true, station);
				db.models.station.findOne({ _id: stationId }, next);
			},

			(station, next) => {
				if (station) {
					if (station.type === 'official') {
						_this.calculateOfficialPlaylistList(station._id, station.playlist, ()=>{});
					}
					station = cache.schemas.station(station);
					cache.hset('stations', stationId, station);
					next(true, station);
				} else next('Station not found');
			},

		], (err, station) => {
			if (err && err !== true) cb(err);
			cb(null, station);
		});
	},

	// Attempts to get the station from Redis. If it's not in Redis, get it from Mongo and add it to Redis.
	getStationByName: function(stationName, cb) {
		let _this = this;
		async.waterfall([

			(next) => {
				db.models.station.findOne({name: stationName}, next);
			},

			(station, next) => {
				if (station) {
					if (station.type === 'official') {
						_this.calculateOfficialPlaylistList(station._id, station.playlist, ()=>{});
					}
					station = cache.schemas.station(station);
					cache.hset('stations', station._id, station);
					next(true, station);
				} else next('Station not found');
			},

		], (err, station) => {
			if (err && err !== true) return cb(err);
			cb(null, station);
		});
	},

	updateStation: function(stationId, cb) {
		let _this = this;
		async.waterfall([

			(next) => {
				db.models.station.findOne({ _id: stationId }, next);
			},

			(station, next) => {
				if (!station) {
					cache.hdel('stations', stationId);
					return next('Station not found');
				}
				cache.hset('stations', stationId, station, next);
			}

		], (err, station) => {
			if (err && err !== true) return cb(err);
			cb(null, station);
		});
	},

	calculateOfficialPlaylistList: (stationId, songList, cb) => {
		let lessInfoPlaylist = [];

		async.each(songList, (song, next) => {
			songs.getSongFromId(song, (err, song) => {
				if (!err && song) {
					let newSong = {
						songId: song.songId,
						title: song.title,
						artists: song.artists,
						duration: song.duration
					};
					lessInfoPlaylist.push(newSong);
				}
				next();
			});
		}, () => {
			cache.hset("officialPlaylists", stationId, cache.schemas.officialPlaylist(stationId, lessInfoPlaylist), () => {
				cache.pub("station.newOfficialPlaylist", stationId);
				cb();
			});
		});
	},

	skipStation: function(stationId) {
		console.log("SKIP!", stationId);
		let _this = this;
		return (cb) => {
			if (typeof cb !== 'function') cb = ()=>{};

			async.waterfall([
				(next) => {
					_this.getStation(stationId, next);
				},
				(station, next) => {
					if (!station) return next('Station not found.');
					if (station.type === 'community' && station.partyMode && station.queue.length === 0) return next(null, null, -11, station); // Community station with party mode enabled and no songs in the queue
					if (station.type === 'community' && station.partyMode && station.queue.length > 0) { // Community station with party mode enabled and songs in the queue
						return db.models.station.update({_id: stationId}, {$pull: {queue: {_id: station.queue[0]._id}}}, (err) => {
							if (err) return next(err);
							next(null, station.queue[0], -12, station);
						});
					}
					if (station.type === 'community' && !station.partyMode) {
						return db.models.playlist.findOne({_id: station.privatePlaylist}, (err, playlist) => {
							if (err) return next(err);
							if (!playlist) return next(null, null, -13, station);
							playlist = playlist.songs;
							if (playlist.length > 0) {
								let currentSongIndex;
								if (station.currentSongIndex < playlist.length - 1) currentSongIndex = station.currentSongIndex + 1;
								else currentSongIndex = 0;
								let callback = (err, song) => {
									if (err) return next(err);
									if (song) return next(null, song, currentSongIndex, station);
									else {
										let song = playlist[currentSongIndex];
										let currentSong = {
											songId: song.songId,
											title: song.title,
											duration: song.duration,
											likes: -1,
											dislikes: -1
										};
										return next(null, currentSong, currentSongIndex, station);
									}
								};
								if (playlist[currentSongIndex]._id) songs.getSong(playlist[currentSongIndex]._id, callback);
								else songs.getSongFromId(playlist[currentSongIndex].songId, callback);
							} else return next(null, null, -14, station);
						});
					}
					if (station.type === 'official' && station.playlist.length === 0) {
						return _this.calculateSongForStation(station, (err, playlist) => {
							if (err) return next(err);
							if (playlist.length === 0) return next(null, _this.defaultSong, 0, station);
							else {
								songs.getSong(playlist[0], (err, song) => {
									if (err || !song) return next(null, _this.defaultSong, 0, station);
									return next(null, song, 0, station);
								});
							}
						});
					}
					if (station.type === 'official' && station.playlist.length > 0) {
						async.doUntil((next) => {
							if (station.currentSongIndex < station.playlist.length - 1) {
								songs.getSong(station.playlist[station.currentSongIndex + 1], (err, song) => {
									if (!err) return next(null, song, station.currentSongIndex + 1);
									else {
										station.currentSongIndex++;
										next(null, null);
									}
								});
							} else {
								_this.calculateSongForStation(station, (err, newPlaylist) => {
									if (err) return next(null, _this.defaultSong, 0);
									songs.getSongFromId(newPlaylist[0], (err, song) => {
										if (err || !song) return next(null, _this.defaultSong, 0);
										station.playlist = newPlaylist;
										next(null, song, 0);
									});
								});
							}
						}, (song) => {
							return !!song;
						}, (err, song, currentSongIndex) => {
							return next(err, song, currentSongIndex, station);
						});
					}
				},
				(song, currentSongIndex, station, next) => {
					let $set = {};
					if (song === null) $set.currentSong = null;
					else if (song.likes === -1 && song.dislikes === -1) {
						$set.currentSong = {
							songId: song.songId,
							title: song.title,
							duration: song.duration,
							likes: -1,
							dislikes: -1
						};
					} else {
						$set.currentSong = {
							songId: song.songId,
							title: song.title,
							artists: song.artists,
							duration: song.duration,
							likes: song.likes,
							dislikes: song.dislikes,
							skipDuration: song.skipDuration,
							thumbnail: song.thumbnail
						};
					}
					if (currentSongIndex >= 0) $set.currentSongIndex = currentSongIndex;
					$set.startedAt = Date.now();
					$set.timePaused = 0;
					if (station.paused) $set.pausedAt = Date.now();
					next(null, $set, station);
				},

				($set, station, next) => {
					db.models.station.update({_id: station._id}, {$set}, (err) => {
						_this.updateStation(station._id, (err, station) => {
							if (station.type === 'community' && station.partyMode === true)
								cache.pub('station.queueUpdate', stationId);
							next(null, station);
						});
					});
				},
			], (err, station) => {
				if (!err) {
					if (station.currentSong !== null && station.currentSong.songId !== undefined) {
						station.currentSong.skipVotes = 0;
					}
					//TODO Pub/Sub this
					utils.emitToRoom(`station.${station._id}`, "event:songs.next", {
						currentSong: station.currentSong,
						startedAt: station.startedAt,
						paused: station.paused,
						timePaused: 0
					});

					if (station.privacy === 'public') utils.emitToRoom('home', "event:station.nextSong", station._id, station.currentSong);
					else {
						let sockets = utils.getRoomSockets('home');
						for (let socketId in sockets) {
							let socket = sockets[socketId];
							let session = sockets[socketId].session;
							if (session.sessionId) {
								cache.hget('sessions', session.sessionId, (err, session) => {
									if (!err && session) {
										db.models.user.findOne({_id: session.userId}, (err, user) => {
											if (!err && user) {
												if (user.role === 'admin') socket.emit("event:station.nextSong", station._id, station.currentSong);
												else if (station.type === "community" && station.owner === session.userId) socket.emit("event:station.nextSong", station._id, station.currentSong);
											}
										});
									}
								});
							}
						}
					}
					if (station.currentSong !== null && station.currentSong.songId !== undefined) {
						utils.socketsJoinSongRoom(utils.getRoomSockets(`station.${station._id}`), `song.${station.currentSong.songId}`);
						if (!station.paused) {
							notifications.schedule(`stations.nextSong?id=${station._id}`, station.currentSong.duration * 1000);
						}
					} else {
						utils.socketsLeaveSongRooms(utils.getRoomSockets(`station.${station._id}`));
					}
					cb(null, station);
				} else {
					err = utils.getError(err);
					logger.error('SKIP_STATION', `Skipping station "${stationId}" failed. "${err}"`);
					cb(err);
				}
			});
		}
	},

	defaultSong: {
		songId: '60ItHLz5WEA',
		title: 'Faded - Alan Walker',
		duration: 212,
		likes: -1,
		dislikes: -1
	}

};
