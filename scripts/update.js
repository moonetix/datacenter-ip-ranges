#!/usr/bin/env node
'use strict';

// Rebuilds data/ from the provider feeds.
// Usage: node scripts/update.js [--include azure] [--out dir]

const path = require('node:path');
const { buildData } = require('../src/build');

function args(argv) {
  const out = { include: [], outDir: path.join(__dirname, '..', 'data') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--include') out.include.push(...String(argv[++i] || '').split(',').filter(Boolean));
    else if (argv[i] === '--out') out.outDir = path.resolve(argv[++i] || '');
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return out;
}

buildData({ ...args(process.argv.slice(2)), log: console.log }).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
