'use strict';

var request = require("request"),
	cheerio = require("cheerio"),
	path = require('path'),
	fs = require("fs"),
	url = require("url"),
	Q = require("q"),
	extend = require('extend'),
	zlib = require('zlib');

// base options
var BASE_OPTIONS = {
	headers: {
		"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_9_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/31.0.1650.63 Safari/537.36",
		"Cache-Control": "no-cache",
		"Pragma": "no-cache"
	}
};

// define some API
var unsupported = function(fnName) {
	return function() {
		throw new Error(fnName+"() has not been implemented yet.");
	};
};

var api = {
	get: unsupported('get'),
	post: unsupported('post'),
	"get$": unsupported('get$'),
	"post$": unsupported('post$'),
	getJson: unsupported('getJson'),
	postJson: unsupported('postJson'),
	clearCookies: unsupported('clearCookies'),
	download: unsupported('download'),
	debug: unsupported('debug'),
	addHeader: unsupported('addHeader')
};

// session factory
var SessionFactory = (function() {

	return {
		session: function(customOptions) {
			return scrapeMaker(customOptions);
		},
		cookieSession: function(customOptions) {
			var cookieJar = request.jar();
			return scrapeMaker(customOptions, cookieJar);
		}
	};
}());

var betterRequest = function(options, callback) {

	// my god why doesn't mikeal just bake this shit into request
	var req = request(options);

	// adapted from http://nickfishman.com/post/49533681471/nodejs-http-requests-with-gzip-deflate-compression
	// TODO: Consider a streamed approach next time
	req.on('response', function(res) {
		var chunks = [];

		res.on('data', function(chunk) {
			chunks.push(chunk);
		});

		res.on('end', function() {
			var buffer = Buffer.concat(chunks),
				encoding = res.headers['content-encoding'];

			try {
				if (encoding === 'gzip') {
					console.log('Content is gzipped');
					zlib.gunzip(buffer, function(err, decoded) {
						callback(err, res, decoded && decoded.toString());
					});
				} else if (encoding === 'deflate') {
					console.log('Content is deflated');
					zlib.inflate(buffer, function(err, decoded) {
						callback(err, res, decoded && decoded.toString());
					});
				} else {
					// manually handle 303... bah
					if (res.statusCode === 303) {
						options.uri = res.headers.location;
						return betterRequest(options, callback);
					} else {
						return callback(null, res, buffer && buffer.toString());
					}
				}
			} catch (e) {
				callback(e);
			}

		});

	});

	req.on('error', callback);
};

// the module itself, must be created via SessionFactory
var scrapeMaker = function(customOptions, jar) {

	var impl = extend({}, api);
	customOptions = (customOptions || {});
	jar && (customOptions.jar = jar);

	var get = function(uri, params) {

		var deferred = Q.defer();

		var options = extend({}, BASE_OPTIONS, customOptions);
		options.uri = uri;
		params && (options.qs = params);

		console.log('GET ', uri);

		betterRequest(options, function(err, resp, body) {
			if (err) {
				deferred.reject(err);
			} else if (resp.statusCode !== 200) {
				console.error(options);
				deferred.reject(new Error('GET ERROR HTTP '+resp.statusCode+':'+body));
			} else {
				deferred.resolve(body);
			}
		});

		return deferred.promise;
	};

	// any way to avoid repeating myself?
	var post = function(uri, params) {

		var deferred = Q.defer();

		var options = extend({}, BASE_OPTIONS, customOptions);
		options.uri = uri;
		options.method = 'POST';
		params && (options.form = params);

		console.log('POST ', uri);

		betterRequest(options, function(err, resp, body) {
			if (err) {
				deferred.reject(err);
			} else if (resp.statusCode !== 200) {
				deferred.reject(new Error('GET ERROR HTTP '+resp.statusCode+':'+body));
			} else {
				deferred.resolve(body);
			}
		});

		return deferred.promise;
	};

	var get$ = function(uri, params) {
		return get(uri, params)
			.then(function(body) {
				return cheerio.load(body, { lowerCaseTags: true});
			});
	};

	var post$ = function(uri, params) {
		return post(uri, params)
			.then(function(body) {
				return cheerio.load(body, { lowerCaseTags: true});
			});	
	};

	var getJson = function(uri, params) {
		return get(uri, params)
			.then(function(body) {
				// fix unicode in JSON response
				var re = /\\x([0-9a-fA-F]{2})/g;
				return JSON.parse(body.replace(re, function(m, n){return String.fromCharCode(parseInt(n,16));}));
			});
	};

	var postJson = function(uri, params) {
		return post(uri, params)
			.then(function(body) {
				// fix unicode in JSON response
				var re = /\\x([0-9a-fA-F]{2})/g;
				return JSON.parse(body.replace(re, function(m, n){return String.fromCharCode(parseInt(n,16));}));
			});	
	};

	var determineFilename = function(uri, filename) {
		var deferred = Q.defer(),
			baseFilename;

		try {
			baseFilename = /[^\/]+$/.exec(url.parse(uri,true).pathname)[0];
		} catch(e) {
			console.log('WARNING Unable to determine base filename for',uri);
			baseFilename = false;
		}

		if (!filename && !baseFilename) {
			deferred.reject(new Error('Filename not given and cannot determine base name'));
		} else if (filename) {
			// if the filename is actually a folder that already exists, then download to the folder using the baseFilename
			fs.stat(filename, function(err, result) {
				var finalValue;
				try {
					if (err || !result.isDirectory()) {
						// just carry on using the filename
						finalValue = filename;
					} else {
						// we append the basefilename to the directory
						finalValue = path.join(filename, baseFilename);
					}
					deferred.resolve(finalValue);
				} catch(e) {
					deferred.reject(e);
				}
			});
		} else {
			// no filename, but we have a baseFilename
			deferred.resolve(baseFilename);
		}

		return deferred.promise;
	};

	var download = function(uri, filename) {

		return determineFilename(uri, filename).then(function(filename) {
			console.log('DOWNLOAD ',uri,' to ',filename);

			// make use of the customOptions and BASE_OPTIONS
			var options = extend({}, BASE_OPTIONS, customOptions);
			options.uri = uri;

			var writeStream = fs.createWriteStream(filename),
				req = request(options),
				deferred = Q.defer();

			// again, adapted from http://nickfishman.com/post/49533681471/nodejs-http-requests-with-gzip-deflate-compression,
			// but this time this is clearly a use case for streams
			req.on('response', function(res) {
				var encoding = res.headers['content-encoding'];

				if (res.statusCode !== 200) {
					deferred.reject(new Error('GET ERROR HTTP '+res.statusCode));
				} else {
					if (encoding === 'gzip') {
						res.pipe(zlib.createGunzip()).pipe(writeStream);
					} else if (encoding === 'deflate') {
						res.pipe(zlib.createInflate()).pipe(writeStream);
					} else {
						res.pipe(writeStream);
					}
				}
			});

			req.on('error', function(err) {
				deferred.reject(err);
			});

			writeStream.on('error', function(err) {
				deferred.reject(err);
			}).on('finish', function() {
				writeStream.close();
				deferred.resolve(filename);
			});

			return deferred.promise;

		});

	};

	var addHeader = function(key, value) {
		!customOptions.headers && (customOptions.headers = {});
		if (typeof value !== 'string' || typeof key !== 'string') {
			throw new Error('Both key and value for header must be of type string');
		}

		customOptions.headers[key] = value;
		return Q();
	};


	impl.get = get;
	impl.post = post;
	impl.get$ = get$;
	impl.post$ = post$;
	impl.getJson = getJson;
	impl.postJson = postJson;
	impl.download = download;
	impl.addHeader = addHeader;

	return impl;

};

module.exports = SessionFactory;