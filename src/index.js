'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createMatcher } = require('./matcher');
const { CATEGORIES, DATACENTER_CATEGORIES } = require('./sources');
const bots = require('./bots');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');

function readList(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

// Builds a matcher from the files in data/.
// options.dataDir     folder with sources.json and providers/ (default: this package's data/)
// options.categories  categories to load (default: cloud, cdn, services)
// options.providers   provider IDs to load (default: every provider in those categories)
function load(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'sources.json'), 'utf8'));
  const categories = options.categories || DATACENTER_CATEGORIES;
  const lists = [];
  for (const src of meta.sources) {
    if (!src.file) continue;
    if (options.providers ? !options.providers.includes(src.id) : !categories.includes(src.category)) continue;
    const file = path.join(dataDir, src.file);
    if (!fs.existsSync(file)) continue;
    lists.push({ id: src.id, category: src.category, cidrs: readList(file) });
  }
  return createMatcher(lists);
}

let defaultMatcher = null;
let everythingMatcher = null;
const crawlerMatchers = new Map();

// True if the address belongs to a cloud, hosting, CDN or provider-service range.
// Tor exits and iCloud Private Relay are not included; use lookup() for those.
function isDatacenterIp(ip) {
  if (!defaultMatcher) defaultMatcher = load();
  return defaultMatcher.contains(ip);
}

// Every list that contains the address, in all categories:
// [{ provider, category }], [] when nothing matches, null for invalid input.
function lookup(ip) {
  if (!everythingMatcher) {
    everythingMatcher = load({ categories: Object.keys(CATEGORIES) });
  }
  return everythingMatcher.lookup(ip);
}

// Checks a request that claims to come from a known crawler (Googlebot, Bingbot,
// GPTBot, ...) against the ranges that crawler's operator publishes.
// Returns null if the user agent claims no known crawler, otherwise
// { bot, name, verified, provider }. verified: false means the claim is false
// or the address is not one the operator lists.
// options.dataDir  folder with sources.json and providers/ (default: this package's data/),
//                  loaded once per folder
function verifyBot(userAgent, ip, options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  if (!crawlerMatchers.has(dataDir)) crawlerMatchers.set(dataDir, load({ dataDir, categories: ['crawler'] }));
  return bots.verify(userAgent, ip, crawlerMatchers.get(dataDir));
}

module.exports = {
  isDatacenterIp,
  lookup,
  verifyBot,
  load,
  createMatcher,
  readList,
  BOTS: bots.BOTS,
  claimedBot: bots.claimedBot,
  DEFAULT_DATA_DIR,
};
