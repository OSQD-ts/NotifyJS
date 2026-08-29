const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

/**
 * `@notifyjs/protocol` lives outside this app's directory, so Metro has to be
 * told to watch it and to resolve its dependencies from here. Without this the
 * app builds against a stale copy, or fails to resolve the package at all.
 */
const config = getDefaultConfig(__dirname);
const protocolRoot = path.resolve(__dirname, '../protocol');

config.watchFolders = [protocolRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(protocolRoot, 'node_modules'),
];
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
