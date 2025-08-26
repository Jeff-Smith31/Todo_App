// Monorepo-friendly Metro config for Expo SDK 53
// Fixes issues like: "PlatformConstants could not be found" by ensuring
// React Native resolves from this app’s node_modules and supporting symlinks.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

/** @type {import('metro-config').ConfigT} */
const config = getDefaultConfig(projectRoot);

// Watch the workspace so changes in the root are detected (if needed)
config.watchFolders = [workspaceRoot];

// Ensure resolver prefers the app's node_modules to avoid duplicate RN copies
config.resolver = {
  ...config.resolver,
  nodeModulesPaths: [
    path.resolve(projectRoot, 'node_modules'),
    // Add workspace node_modules as a fallback only
    path.resolve(workspaceRoot, 'node_modules'),
  ],
  // Prevent walking up the directory tree and accidentally resolving a second copy
  disableHierarchicalLookup: true,
  // Support symlinked packages (common in monorepos)
  unstable_enableSymlinks: true,
  unstable_enablePackageExports: true,
};

module.exports = config;
