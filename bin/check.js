#!/usr/bin/env node
'use strict';

// Usage: node bin/check.js [--json] [--only categories] [--data dir] <ip> [ip ...]
//        echo 1.2.3.4 | node bin/check.js -
//
// Exit codes, like grep: 0 at least one address is listed, 1 none is listed,
// 2 an argument is not a valid IP address.

const fs = require('node:fs');
const path = require('node:path');
const { load, readList, DEFAULT_DATA_DIR } = require('../src/index');
const { CATEGORIES } = require('../src/sources');
const { parseAddress, parseCidr } = require('../src/ip');

function usage(code = 2) {
  (code === 0 ? process.stdout : process.stderr).write(
    'Usage: check.js [--json] [--only categories] [--data dir] <ip> [ip ...]\n' +
      '       check.js -          read addresses from stdin, one per line\n' +
      '  --only cloud,cdn       check only these categories (' + Object.keys(CATEGORIES).join(', ') + ')\n' +
      '  --json                 print JSON\n' +
      'Exit code 0 if any address is listed, 1 if none is, 2 on invalid input.\n',
  );
  process.exit(code);
}

function main() {
  const argv = process.argv.slice(2);
  let json = false;
  let dataDir = DEFAULT_DATA_DIR;
  let categories = Object.keys(CATEGORIES);
  const ips = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--data') dataDir = path.resolve(argv[++i] || '');
    else if (a === '--only') {
      categories = String(argv[++i] || '').split(',').filter(Boolean);
      if (!categories.length || categories.some((c) => !CATEGORIES[c])) usage();
    } else if (a === '-h' || a === '--help') usage(0);
    else if (a === '-') ips.push(...fs.readFileSync(0, 'utf8').split(/\s+/).filter(Boolean));
    else ips.push(a);
  }
  if (ips.length === 0) usage();

  const matcher = load({ dataDir, categories });
  const lists = new Map();
  // The matcher knows which providers match. For the report we also show the CIDR block.
  function blockFor(provider, ip) {
    if (!lists.has(provider)) {
      const cidrs = readList(path.join(dataDir, 'providers', `${provider}.txt`));
      lists.set(provider, cidrs.map((text) => ({ text, ...parseCidr(text) })));
    }
    const a = parseAddress(ip);
    const hit = lists.get(provider).find((r) => r.family === a.family && a.value >= r.start && a.value <= r.end);
    return hit ? hit.text : '';
  }

  let anyListed = false;
  let anyInvalid = false;
  const results = [];
  for (const ip of ips) {
    const matches = matcher.lookup(ip);
    if (matches === null) {
      anyInvalid = true;
      results.push({ ip, valid: false, listed: false, matches: [] });
      continue;
    }
    if (matches.length) anyListed = true;
    results.push({
      ip,
      valid: true,
      listed: matches.length > 0,
      matches: matches.map((m) => ({ ...m, cidr: blockFor(m.provider, ip) })),
    });
  }

  if (json) {
    process.stdout.write(JSON.stringify(results.length === 1 ? results[0] : results, null, 2) + '\n');
  } else {
    const width = Math.max(...ips.map((s) => s.length)) + 2;
    for (const r of results) {
      if (!r.valid) {
        process.stdout.write(`${r.ip.padEnd(width)}invalid IP address\n`);
      } else if (!r.listed) {
        process.stdout.write(`${r.ip.padEnd(width)}not listed\n`);
      } else {
        for (const [i, m] of r.matches.entries()) {
          const label = i === 0 ? r.ip.padEnd(width) : ''.padEnd(width);
          process.stdout.write(`${label}${m.provider.padEnd(22)}${m.category.padEnd(15)}${m.cidr}\n`);
        }
      }
    }
  }
  process.exit(anyInvalid ? 2 : anyListed ? 0 : 1);
}

main();
