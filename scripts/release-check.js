#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tag = process.argv[2] || process.env.GITHUB_REF_NAME || '';
const expected = `v${packageJson.version}`;

if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  console.error(`Release tag must be semantic, for example ${expected}. Received: ${tag || '(empty)'}`);
  process.exit(1);
}
if (tag !== expected) {
  console.error(`Tag ${tag} does not match package.json version ${packageJson.version}. Expected ${expected}.`);
  process.exit(1);
}

console.log(`Release metadata OK: ${packageJson.name}@${packageJson.version} (${tag})`);
