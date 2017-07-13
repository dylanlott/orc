'use strict';

const BusBoy = require('busboy');
const ReedSolomon = require('@ronomon/reed-solomon');
const Zcash = require('zcash');
const http = require('http');
const utils = require('./utils');
const fs = require('fs');
const merge = require('merge');
const connect = require('connect');
const auth = require('basic-auth');
const crypto = require('crypto');
const { tmpdir } = require('os');
const path = require('path');
const tiny = require('tiny');
const mkdirp = require('mkdirp');
const uuid = require('uuid');
const AuditStream = require('./audit');
const Contract = require('./contract');
const { knuthShuffle } = require('knuth-shuffle');
const stream = require('stream');
const async = require('async');
const ms = require('ms');
const rimraf = require('rimraf');


/**
 * Represents a local HTTP(s) server that abstracts the upload and download
 * of files away to a simple request. Files are encrypted to the given public
 * key, split into shards for erasure codes. Prepped for distribution and
 * queued for storing in the network. Bridge exposes a simple API for getting
 * status of transfers and previously stored objects.
 *
 * GET    /       (List objects as JSON)
 * GET    /{hash} (Download object)
 * DELETE /{hash} (Delete object)
 * POST   /       (Upload object - Multipart)
 */
class Bridge {

  static get DEFAULTS() {
    return {
      auth: {
        user: null,
        pass: null
      },
      wallet: {
        user: 'orc',
        password: 'orc',
        port: 8232,
        host: 'localhost'
      },
      store: path.join(
        tmpdir(),
        `objects.${crypto.randomBytes(16).toString('hex')}`
      ),
      stage: path.join(
        tmpdir(),
        `staging.${crypto.randomBytes(16).toString('hex')}`
      ),
      capacityCache: null,
      auditInterval: 432000000 // 5 days
    };
  }

  /**
   * @constructor
   * @param {Node} node
   */
  constructor(node, options) {
    this.options = merge(Bridge.DEFAULTS, options);
    this.objects = tiny(this.options.store);
    this.node = node;
    this.server = http.createServer(this.createRequestHandler());
    this.wallet = new Zcash(this.options.wallet);
    this.capacityCache = this.options.capacityCache;

    if (!fs.existsSync(this.options.stage)) {
      mkdirp.sync(this.options.stage);
    }

    setInterval(() => this.audit(), 21600000); // 6 hours
  }

  /**
   * Listens on the given port and hostname
   * @param {number} port
   * @param {string} hostname
   * @param {function} callback
   */
  listen() {
    this.server.listen(...arguments);
  }

  /**
   * Creates request router and handler stack
   * @returns {function}
   */
  createRequestHandler() {
    const handler = connect();

    handler.use(this.authenticate.bind(this));
    handler.use('/', this.route.bind(this));
    handler.use(this.error.bind(this));

    return handler;
  }

  /**
   * Handles request authentication if defined
   * @param {object} request
   * @param {object} response
   * @param {function} next
   */
  authenticate(req, res, next) {
    const { user, pass } = this.options.auth;
    const error = new Error('Not authorized');

    error.code = 401;

    if (user && pass) {
      const creds = auth(req);

      if (!(creds.name === user && creds.pass === pass)) {
        return next(error);
      }
    }

    next();
  }

  /**
   * Responds to requests with error code and message
   * @param {error} error
   * @param {object} request
   * @param {object} response
   * @param {function} next
   */
  error(err, req, res, next) {
    if (!err) {
      return next();
    }

    res.writeHead(err.code || 500);
    res.write(err.message);
    res.end();
  }

  /**
   * Handles routing requests to their appropriate handler
   * @param {object} request
   * @param {object} response
   * @param {function} next
   */
  route(req, res, next) {
    const { method, url } = req;

    function badRequest() {
      let error = new Error(`Cannot ${method} ${url}`);
      error.code = 400;
      next(error);
    }

    if (method === 'POST') {
      if (url !== '/') {
        badRequest();
      } else {
        this.upload(req, res, next);
      }
    } else if (method === 'GET') {
      if (url === '/') {
        console.log('HEADERS: ', req.headers);

        this.list(req, res, next);
      } else {
        this.download(req, res, next);
      }
    } else if (method === 'DELETE') {
      if (url === '/') {
        badRequest();
      } else {
        this.destroy(req, res, next);
      }
    } else {
      badRequest();
    }
  }

  /**
   * Scans the object database and returns all index entries
   * @param {object} request
   * @param {object} response
   * @param {function} next
   */
  list(req, res) {
    let written = 0;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('[');

    this.objects.each((obj) => {
      res.write((written === 0 ? '' : ',') + JSON.stringify(obj));
      written++;
    }, () => {
      res.write(']');
      res.end();
    }, true);
  }

  /**
   * Queues the object for upload to the network
   * @param {object} request
   * @param {object} response
   * @param {function} next
   */
  upload(req, res) {
    const busboy = new BusBoy({ headers: req.headers });
    const objects = [];

    /* eslint max-params: [2, 5] */
    busboy.on('file', (field, file, name, encoding, mime) => {
      const id = uuid.v4();
      const tmp = path.join(this.options.stage, id);

      mkdirp.sync(tmp);

      let size = 0;
      const hash = crypto.createHash('sha256');
      const hasher = new stream.Transform({
        transform: (data, enc, cb) => {
          size += data.length;
          hash.update(data);
          cb(null, data);
        }
      });
      const writer = fs.createWriteStream(path.join(tmp, 'ciphertext'));
      const cipher = utils.createCipher(this.node.spartacus.publicKey,
                                        this.node.spartacus.privateKey);

      objects.push({ id, name, encoding, mimetype: mime });
      file.pipe(hasher).pipe(cipher).pipe(writer).on('finish', () => {
        const digest = hash.digest('hex');
        const ciphertext = path.join(tmp, 'ciphertext');

        this.objects.set(id, {
          id,
          name,
          encoding,
          mimetype: mime,
          hash: digest,
          size,
          status: 'queued',
          shards: []
        }, () => {
          this.distribute(ciphertext, {
            hash: digest,
            encoding,
            mimetype: mime,
            id
          }, (err, object) => {
            if (err) {
              res.writeHead(500);
              return res.end(err.message);
            }

            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(object));
          });
        });
      });
    });

    req.pipe(busboy);
  }

  /**
   * Takes the supplied file path and applies erasure codes, then attempts to
   * distribute the shards across the network
   * @param {string} filepath - Path to the file to distribute
   * @param {object} metadata
   * @param {string} metadata.encoding
   * @param {string} metadata.mimetype
   * @param {string} metadata.hash
   * @param {function} callback
   * @returns {EventEmitter}
   */
  distribute(filepath, metadata, callback) {
    const stat = fs.statSync(filepath);
    const rsparams = utils.getErasureParameters(stat.size);
    const rs = new ReedSolomon(rsparams.shards, rsparams.parity);

    const encodeErasure = (callback) => {
      fs.readFile(filepath, (err, file) => {
        if (err) {
          return callback(err);
        }

        let parity = [];
        let { size } = rsparams;

        for (let i = 0; i < rsparams.parity; i++) {
          parity.push(new Buffer(rsparams.size));
        }

        file = Buffer.concat([file, Buffer.concat(parity)]);
        rs.encode(file, 0, file.length, size, 0, size, (err) => {
          if (err) {
            return callback(err);
          }

          this.objects.get(metadata.id, (err, object) => {
            if (err) {
              return callback(err);
            } else {
              callback(null, file, rsparams, object);
            }
          });
        });
      });
    }

    const prepareShards = (file, rsparams, object, callback) => {
      let time = Date.now();
      let shards = [];
      let position = 0;

      const prepareContracts = () => {
        async.eachSeries(shards, (shard, next) => {
          const audit = new AuditStream(3); // TODO: Configurable
          const readStream = fs.createReadStream(shard.path);
          const hash = crypto.createHash('sha256');
          const hasher = new stream.Transform({
            transform: (data, enc, cb) => {
              hash.update(data);
              cb(null, data);
            }
          });

          readStream.pipe(hasher).pipe(audit).on('finish', () => {
            shard.audits = audit.getPrivateRecord();
            shard.audits.root = shard.audits.root.toString('hex')
            shard._proposal = Contract.from({
              data_hash: utils.rmd160(hash.digest()).toString('hex'),
              data_size: rsparams.size,
              audit_count: 3, // TODO: Configurable
              audit_leaves: audit.getPublicRecord(),
              payment_storage_price: 0, // TODO: Configurable
              payment_download_price: 0, // TODO: Configurable
              store_begin: time,
              store_end: time + ms('90d'), // TODO: Configurable
              renter_hd_key: this.node.contact.xpub,
              renter_hd_index: this.node.contact.index,
              renter_id: this.node.identity.toString('hex')
            });
            shard._proposal.sign('renter', this.node.spartacus.privateKey);
            next();
          });
        }, () => {
          object.shards = shards;

          this.objects.set(
            object.id, object,
            () => callback(null, shards, object)
          );
        });
      }

      async.timesLimit(rsparams.shards + rsparams.parity, 1, (n, done) => {
        const pad = (n) => n >= 10 ? n.toString() : `0${n}`;
        const shardpath = path.join(path.dirname(filepath), `${pad(n)}.shard`);
        const bufferSlice = file.slice(position, position + rsparams.size);

        fs.writeFile(shardpath, bufferSlice, () => {
          position += rsparams.size;
          shards.push({ index: n, size: rsparams.size, path: shardpath });
          done();
        });
      }, () => {
        fs.unlink(filepath, () => prepareContracts());
      });
    };

    const uploadShards = (shards, object, callback) => {
      object.status = 'working';

      async.eachLimit(shards, 3, (shard, next) => {
        async.retry({ times: 5 }, (done) => {
          const query = this.capacityCache.find({}).bind(this.capacityCache);

          /* eslint max-statements: [2, 18] */
          query((err, capacities) => {
            if (err) {
              return callback(err);
            }

            let proposal = shard._proposal.toObject();
            let target = null;
            let contact = null;

            knuthShuffle(capacities);

            for (let i = 0; i < capacities.length; i++) {
              if (capacities[i].capacity.available < shard.size) {
                continue;
              }

              contact = this.node.router.getContactByNodeId(
                capacities[i]._key
              );
              target = contact
                     ? [capacities[i]._key, contact]
                     : [capacities[i]._key, capacities[i].contact];

              if (target !== undefined) {
                break;
              }
            }

            if (target === undefined) {
              this.node.logger.warn(
                'not enough capacity data collected to upload, waiting...'
              );
              return setTimeout(() => {
                done(new Error('Not enough capacity information'));
              }, ms('1m'));
            }

            this.node.claimFarmerCapacity(target, proposal, (err, data) => {
              if (err) {
                this.node.logger.warn(
                  `failed to claim capacity, reason: ${err.message}`
                );
                return done(err);
              }

              this.node.logger.info(`capacity claimed from ${target[0]}`);

              let [completedContract, consignToken] = data;
              let uploadStream = utils.createShardUploader(
                target,
                shard._proposal.get('data_hash'),
                consignToken,
                this.node.onion.createSecureAgent()
              );

              uploadStream.on('error', done);
              uploadStream.on('response', (res) => {
                let body = '';
                res.on('data', (data) => body += data.toString());
                res.on('end', () => {
                  if (res.statusCode !== 200) {
                    this.node.logger.warn(
                      `failed to upload shard, reason: ${body}`
                    );
                    return done(new Error(body));
                  }

                  delete shard._proposal;
                  shard.service = target;
                  shard.contract = completedContract;
                  done();
                });
              });
              this.node.logger.info(`uploading shard to ${target[0]}`);
              fs.createReadStream(shard.path)
                .on('data', (data) => uploadStream.write(data))
                .on('end', () => uploadStream.end())
                .on('error', done);
            });
          });
        }, next);
      }, (err) => {
        object.shards = shards;

        if (err) {
          object.status = 'failed';
          this.node.logger.error(err.message);
          callback(err);
        } else {
          object.status = 'finished';
          this.node.logger.info(`successfully uploaded ${object._key}`);
          rimraf(path.dirname(filepath), () => callback(null, object));
        }

        this.objects.set(object._key, object);
      });
    }

    async.waterfall([
      (next) => encodeErasure(next),
      (file, rs, obj, next) => prepareShards(file, rs, obj, next),
      (shards, obj, next) => uploadShards(shards, obj, next)
    ], callback);
  }

  /**
   * Downloads the object from the network
   * @param {object} request
   * @param {object} response
   * @param {function} next
   */
  download(req, res, next) {
    const hash = req.url.substr(1);

    const resolveDownloadTokens = (object, callback) => {
      // TODO: Request download tokens for each shard
      // TODO: Callback with node addresses and tokens
      callback(new Error('Not implemented'));
    };

    const downloadShards = (pointers, callback) => {
      // TODO: Download each shard to a temporary file
      // TODO: Callback with paths to shards
      callback(new Error('Not implemented'));
    };

    const assembleShards = (paths, callback) => {
      // TODO: Load all shards and write them to buffer
      // TODO: Apply erasure codes callback with buffer
      callback(new Error('Not implemented'));
    };

    this.object.get(hash, (err, object) => {
      if (err) {
        return next(err);
      }

      async.waterfall([
        (done) => resolveDownloadTokens(object, done),
        (pointers, done) => downloadShards(pointers, done),
        (paths, done) => assembleShards(paths, done)
      ], (err, buffer) => {
        if (err) {
          return next(err);
        }

        const decipher = utils.createDecipher(this.node.spartacus.publicKey,
                                              this.node.spartacus.privateKey);

        res.writeHead(200, { 'Content-Type': object.mime });
        decipher.pipe(res);
        decipher.end(buffer);
      });
    });
  }

  /**
   * Ends contracts with farmers for the object parts and removes
   * reference to them
   * @param {object} request
   * @param {object} response
   * @param {function} next
   */
  destroy(req, res) {
    res.writeHead(501);
    res.end('Not Implemented');
    // TODO: For each shard referenced by the object
    // TODO: Set the store_end time in the contract to now
    // TODO: Issue a RENEW message to the associated farmer node
    // TODO: Issue any final payment for storage
    // TODO: Remove the object reference
    // TODO: Respond immediately after queuing the destroy
    // TODO: (Status can be checked with GET /)
  }

  /**
   * Periodically call this to scan the object store for shards that need to
   * be audited, perform audit, and issue payment
   * @param {function} callback
   */
  audit(callback = () => null) {
    callback(new Error('Auditor not implemented'));
  }

}

module.exports = Bridge;
