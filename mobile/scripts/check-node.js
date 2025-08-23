#!/usr/bin/env node
const semver = process.versions.node;
const major = parseInt(semver.split('.')[0], 10);

const min = 20;
const maxExclusive = 21; // Project requires Node 20.x

if (Number.isNaN(major)) {
  process.exit(0);
}

const outOfRange = major < min || major >= maxExclusive;
const isCI = String(process.env.CI || '').toLowerCase() === 'true';
const strict = isCI || String(process.env.EXPO_STRICT_NODE || '') === '1';

if (outOfRange) {
  const msg = `\nUnsupported Node.js version detected: ${semver}\n\n` +
`This project requires Node.js 20.x (LTS).\n` +
`Please switch Node versions and try again.\n\n` +
`Quick fix with nvm (recommended):\n` +
`  nvm install 20\n` +
`  nvm use 20\n\n` +
`We include an .nvmrc in the repo, so you can also run:\n` +
`  nvm use\n`;

  if (strict) {
    console.error(msg);
    process.exit(1);
  } else {
    // Local/dev mode: warn but continue so developers can proceed at their own risk.
    console.warn(msg + "\nContinuing anyway because EXPO_STRICT_NODE is not set and CI is false.\n");
    process.exit(0);
  }
}
