#!/usr/bin/env node

'use strict';

const os = require('os');
const url = require('url');
const async = require('async');
const program = require('commander');
const assert = require('assert');
const bytes = require('bytes');
const hdkey = require('hdkey');
const hibernate = require('kad-hibernate');
const traverse = require('kad-traverse');
const spartacus = require('kad-spartacus');
const onion = require('kad-onion');
const ms = require('ms');
const bunyan = require('bunyan');
const levelup = require('levelup');
const mkdirp = require('mkdirp');
const path = require('path');
const fs = require('fs');
const manifest = require('../package');
const orc = require('..');
const options = require('./config');
const { execFileSync } = require('child_process');
const { Transform } = require('stream');
const config = require('rc')('orc', options);
const boscar = require('boscar');
const kad = require('kad');


program.version(`
  orc      ${orc.version.software}
  protocol ${orc.version.protocol}
`);

program.description(`
  Copyright (c) 2017 Gordon Hall
  Licensed under the GNU Affero General Public License Version 3
`);

program.option('--config <file>', 'path to a orc configuration file');
program.parse(process.argv);

function orctool() {
  return execFileSync(
    path.join(__dirname, 'orctool.js'),
    [...arguments]
  ).toString().trim();
}

// Extend the Kad T_RESPONSETIMEOUT to 30s because Tor
kad.constants.T_RESPONSETIMEOUT = ms('30s');

// Generate a private extended key if it does not exist
if (!fs.existsSync(config.PrivateExtendedKeyPath)) {
  fs.writeFileSync(
    config.PrivateExtendedKeyPath,
    orctool('generate-key', '--extended')
  );
}

// Generate self-signed ssl certificate if it does not exist
if (!fs.existsSync(config.TransportServiceKeyPath)) {
  let [key, cert] = orctool('generate-cert').split('\r\n\r\n');
  fs.writeFileSync(config.TransportServiceKeyPath, key);
  fs.writeFileSync(config.TransportCertificatePath, cert);
}

// Generate self-signed ssl certificate if it does not exist
if (!fs.existsSync(config.OnionServicePrivateKeyPath)) {
  let key = orctool('generate-onion');
  fs.writeFileSync(config.OnionServicePrivateKeyPath, key);
}

// Initialize private extended key
const xprivkey = fs.readFileSync(config.PrivateExtendedKeyPath).toString();
const parentkey = hdkey.fromExtendedKey(xprivkey)
                    .derive(orc.constants.HD_KEY_DERIVATION_PATH);
const childkey = parentkey.deriveChild(parseInt(config.ChildDerivationIndex));

// Initialize the contract storage database
const contracts = levelup(
  path.join(config.ContractStorageBaseDir, 'contracts.db'),
  { valueEncoding: 'json' }
);

// Create the shards directory if it does not exist
if (!fs.existsSync(path.join(config.ShardStorageBaseDir, 'shards'))) {
  mkdirp.sync(path.join(config.ShardStorageBaseDir, 'shards'));
}

// Initialize the shard storage database
const shards = new orc.Shards(path.join(config.ShardStorageBaseDir, 'shards'), {
  maxSpaceAllocated: bytes.parse(config.ShardStorageMaxAllocation)
});

// Initialize the directory storage database
const storage = levelup(
  path.join(config.DirectoryStorageBaseDir, 'directory.db'),
  { valueEncoding: 'json' }
);

// Initialize logging
const logger = bunyan.createLogger({
  name: spartacus.utils.toPublicKeyHash(childkey.publicKey).toString('hex')
});

// Initialize transport adapter with SSL
const transport = new orc.Transport({
  key: fs.readFileSync(config.TransportServiceKeyPath),
  cert: fs.readFileSync(config.TransportCertificatePath)
});

// Initialize public contact data
const contact = {
  protocol: 'https:',
  port: parseInt(config.PublicPort),
  xpub: parentkey.publicExtendedKey,
  index: parseInt(config.ChildDerivationIndex),
  agent: `orc-${manifest.version}/${os.platform()}`
};

// Initialize protocol implementation
const node = new orc.Node({
  contracts,
  shards,
  storage,
  logger,
  transport,
  contact,
  claims: config.AllowDirectStorageClaims,
  privateExtendedKey: xprivkey,
  keyDerivationIndex: parseInt(config.ChildDerivationIndex)
});

// Handle any fatal errors
node.on('error', (err) => {
  logger.error(err.message.toLowerCase());
});

const rsa = fs.readFileSync(config.OnionServicePrivateKeyPath)
              .toString().split('\n').filter((l) => l && l[0] !== '-')
              .join('');

// Establish onion hidden service
node.plugin(onion({
  rsaPrivateKey: rsa,
  torrcEntries: {
    CircuitBuildTimeout: 10,
    KeepalivePeriod: 60,
    NewCircuitPeriod: 60,
    NumEntryGuards: 8
  },
  serviceHealthCheckInterval: ms(config.ServiceAvailabilityCheckInterval)
}));

// Intialize control server
const control = new boscar.Server(node);

// Plugin bandwidth metering if enabled
if (!!parseInt(config.BandwidthAccountingEnabled)) {
  node.plugin(hibernate({
    limit: config.BandwidthAccountingMax,
    interval: config.BandwidthAccountingReset,
    reject: ['CLAIM', 'FIND_VALUE', 'STORE', 'CONSIGN']
  }));
}

// Use verbose logging if enabled
if (!!parseInt(config.VerboseLoggingEnabled)) {
  node.rpc.deserializer.append(new Transform({
    transform: (data, enc, callback) => {
      let [rpc, ident] = data;

      if (rpc.payload.method) {
        logger.info(
          `received ${rpc.payload.method} (${rpc.payload.id}) from ` +
          `${ident.payload.params[0]} ` +
          `(https://${ident.payload.params[1].hostname}:` +
          `${ident.payload.params[1].port})`
        );
      } else {
        logger.info(
          `received response from ${ident.payload.params[0]} to ` +
          `${rpc.payload.id}`
        );
      }

      callback(null, data);
    },
    objectMode: true
  }));
  node.rpc.serializer.prepend(new Transform({
    transform: (data, enc, callback) => {
      let [rpc, sender, recv] = data;

      if (rpc.method) {
        logger.info(
          `sending ${rpc.method} (${rpc.id}) to ${recv[0]} ` +
          `(https://${recv[1].hostname}:${recv[1].port})`
        );
      } else {
        logger.info(
          `sending response to ${recv[0]} for ${rpc.id}`
        );
      }

      callback(null, data);
    },
    objectMode: true
  }));
}

let retry = null;

function join() {
  let entry = null;

  logger.info(
    `joining network from ${config.NetworkBootstrapNodes.length} seeds`
  );
  async.detectSeries(config.NetworkBootstrapNodes, (seed, done) => {
    logger.info(`requesting identity information from ${seed}`);
    node.identifyService(seed, (err, contact) => {
      if (err) {
        logger.error(`failed to identify seed ${seed} (${err.message})`);
        done(null, false);
      } else {
        entry = contact;
        node.join(contact, (err) => done(null, !err));
      }
    });
  }, (err, result) => {
    if (!result) {
      logger.error('failed to join network, will retry in 1 minute');
      retry = setTimeout(() => join(), ms('1m'));
    } else {
      logger.info(
        `connected to network via ${entry[0]} ` +
        `(https://${entry[1].hostname}:${entry[1].port})`
      );
      logger.info(`discovered ${node.router.size} peers from seed`);
      profiles();
    }
  });
}

// Configure dashboard and check enabled
if (parseInt(config.DashboardEnabled)) {
  const dashboard = new orc.Dashboard({ logger });

  dashboard.listen(
    parseInt(config.DashboardPort),
    config.DashboardHostname,
    () => {
      logger.info(
        `gui listening on ${config.DashboardHostname}:${config.DashboardPort}`
      );
    }
  );
}


function profiles() {
  if (config.ProfilesEnabled.length === 0) {
    logger.warn('no profiles are enabled, you are only a relay');
  }

  config.ProfilesEnabled.forEach((profile) => {
    if (!orc.profiles[profile]) {
      logger.error(`failed to apply invalid profile "${profile}"`);
    } else {
      logger.info(`initializing ${profile} profile routines`);
      orc.profiles[profile](node, config);
    }
  });
}

// Print super dank orc ascii
console.info(fs.readFileSync(path.join(__dirname, '../motd')).toString());

// Bind to listening port and join the network
logger.info('bootstrapping tor and establishing hidden service');
node.listen(parseInt(config.ListenPort), () => {
  logger.info(`node listening on port ${config.ListenPort}`);
  join();
});

// Establish control server and wrap node instance
control.listen(parseInt(config.ControlPort), config.ControlHostname, () => {
  logger.info(
    `control server bound to ${config.ControlHostname}:${config.ControlPort}`
  );
});
