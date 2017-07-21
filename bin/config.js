'use strict';

const { randomBytes } = require('crypto');
const ini = require('ini');
const { existsSync, writeFileSync } = require('fs');
const mkdirp = require('mkdirp');
const { homedir } = require('os');
const { join } = require('path');
const datadir = join(homedir(), '.config/orc');

module.exports = {

  // Identity/Cryptography
  PrivateExtendedKeyPath: join(datadir, 'x_private_key'),
  ChildDerivationIndex: '0',

  // Contract Storage
  ContractStorageBaseDir: datadir,

  // Shard Database
  ShardStorageBaseDir: datadir,
  ShardStorageMaxAllocation: '0GB',

  // Trusted Renter Nodes
  AllowDirectStorageClaims: ['*'],

  // Server SSL
  TransportServiceKeyPath: join(datadir, 'service_key.pem'),
  TransportCertificatePath: join(datadir, 'certificate.pem'),

  // Public Addressability
  PublicPort: '443',
  ListenPort: '4443',

  // Network Bootstrapping
  NetworkBootstrapNodes: [
    'https://orcjfg52ty6ljv54.onion:443',
    'https://orce4nqoa6muz3gt.onion:443',
    'https://orcjd7xgshpovm6i.onion:443',
    'https://orcwfkilxjxo63mr.onion:443'
  ],

  // Tor Behavior
  ServiceAvailabilityCheckInterval: '10M',

  // Bandwidth Metering
  BandwidthAccountingEnabled: '0',
  BandwidthAccountingMax: '5GB',
  BandwidthAccountingReset: '24HR',

  // Debugging/Developer
  VerboseLoggingEnabled: '1',
  ControlPort: '4444',
  ControlHostname: '127.0.0.1',

  // Onion Service
  OnionServicePrivateKeyPath: join(datadir, 'onion_key'),

  // Node Profiles
  ProfilesEnabled: [], // renter, farmer, directory

  // Renter Profile
  RenterListenTopics: [
    '01020202',
    '02020202',
    '03020202'
  ],
  RenterCapacityCachePath: join(datadir, 'capacity.cache'),

  // Local Bridge
  BridgeEnabled: '0',
  BridgeStorageBaseDir: datadir,
  BridgeHostname: '127.0.0.1',
  BridgePort: '4445',
  BridgeAuthenticationEnabled: '0',
  BridgeAuthenticationUser: 'orc',
  BridgeAuthenticationPassword: randomBytes(16).toString('hex'),
  BridgeMetaStoragePath: join(datadir, 'objects.meta'),
  BridgeTempStagingBaseDir: join(datadir, '__bridge.staging'),
  BridgeShardAuditInterval: '5DAYS',

  // Local Node Dashboard and GUI
  DashboardEnabled: '0',
  DashboardPort: '8080',
  DashboardHostname: '127.0.0.1',

  // Directory Server
  DirectoryStorageBaseDir: datadir,
  DirectoryPort: '4446',
  DirectoryHostname: '127.0.0.1',
  DirectoryUseSSL: '0',
  DirectoryServiceKeyPath: join(datadir, 'service_key.pem'),
  DirectoryCertificatePath: join(datadir, 'certificate.pem'),
  DirectoryAuthorityChains: [],
  DirectoryCapacityCachePath: join(datadir, 'capacity.cache'),

  // Wallet Connection
  WalletHostname: 'localhost',
  WalletPort: '8232',
  WalletUser: 'orc',
  WalletPassword: 'orc',
  WalletShieldedTransactions: '0',

  // Farmer Profile
  FarmerAdvertiseTopics: [
    '01020202',
    '02020202',
    '03020202'
  ],
  FarmerShardReaperInterval: '24HR',
  FarmerAnnounceInterval: '15M'

};

if (!existsSync(join(datadir, 'config'))) {
  mkdirp.sync(datadir);
  writeFileSync(join(datadir, 'config'), ini.stringify(module.exports));
}
