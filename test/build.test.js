'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildData } = require('../src/build');
const { SOURCES, geofeed, lines } = require('../src/sources');
const { load } = require('../src/index');

function fakeSources() {
  return [
    { id: 'cloud-a', name: 'Cloud A', category: 'cloud', url: 'https://a.test/ranges', docs: 'https://a.test', terms: 't', parse: lines },
    { id: 'cloud-b', name: 'Cloud B', category: 'cloud', url: 'https://b.test/feed.csv', docs: 'https://b.test', terms: 't', parse: geofeed },
    { id: 'svc', name: 'Services', category: 'services', url: 'https://c.test/all', docs: 'https://c.test', terms: 't', subtract: 'cloud-a', parse: lines },
    { id: 'relay', name: 'Relay', category: 'privacy-relay', url: 'https://d.test/relay', docs: 'https://d.test', terms: 't', parse: lines },
    { id: 'optin', name: 'Opt in', category: 'cloud', url: 'https://e.test/x', docs: 'https://e.test', terms: 't', optIn: true, parse: lines },
  ];
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dcip-'));
}

const FEEDS = {
  'https://a.test/ranges': '# comment\n203.0.112.0/24\n198.51.99.0/25\n198.51.99.128/25\n2001:db9::/32\n',
  'https://b.test/feed.csv': '# geofeed\n45.32.0.0/21,US,US-NJ,Piscataway,08854\n45.32.8.0/21,US,,,\n2a05:f480::/32,DE,,,\n',
  'https://c.test/all': '203.0.112.0/23\n10.0.0.0/8\nnot-a-cidr\n4.0.0.0/4\n100.20.0.0/16\n',
  'https://d.test/relay': '172.224.226.0/27\n',
  'https://e.test/x': '9.9.9.0/24\n',
};

async function run(outDir, feeds, extra = {}) {
  return buildData({
    outDir,
    sources: fakeSources(),
    get: async (url) => {
      if (!(url in feeds)) throw new Error(`HTTP 404 for ${url}`);
      return feeds[url];
    },
    now: new Date('2026-01-02T03:04:05Z'),
    ...extra,
  });
}

test('writes merged, cleaned lists and metadata', async () => {
  const out = tmpDir();
  const res = await run(out, FEEDS);
  const read = (f) => fs.readFileSync(path.join(out, f), 'utf8');

  assert.equal(read('providers/cloud-a.txt'), '198.51.99.0/24\n203.0.112.0/24\n2001:db9::/32\n');
  assert.equal(read('providers/cloud-b.txt'), '45.32.0.0/20\n2a05:f480::/32\n');
  // From svc: 10.0.0.0/8 is private, 203.0.113.0/24 is a documentation range,
  // 4.0.0.0/4 is too broad, and 203.0.112.0/24 belongs to cloud-a.
  assert.equal(read('providers/svc.txt'), '100.20.0.0/16\n');
  assert.equal(read('categories/privacy-relay.txt'), '172.224.226.0/27\n');
  assert.equal(read('ipv4.txt'), '45.32.0.0/20\n100.20.0.0/16\n198.51.99.0/24\n203.0.112.0/24\n');
  assert.equal(read('ipv6.txt'), '2001:db9::/32\n2a05:f480::/32\n');
  assert.equal(read('all.txt'), read('ipv4.txt') + read('ipv6.txt'));
  assert.ok(!read('all.txt').includes('172.224.226.0'), 'privacy relay is not in all.txt');
  assert.ok(!fs.existsSync(path.join(out, 'providers/optin.txt')), 'opt-in source skipped');

  const rows = JSON.parse(read('ranges.json'));
  assert.deepEqual(rows[0], { provider: 'cloud-a', category: 'cloud', cidr: '198.51.99.0/24', source: 'https://a.test/ranges' });
  assert.ok(rows.some((r) => r.provider === 'relay'));
  assert.equal(read('ranges.csv').split('\n')[0], 'provider,category,cidr,source');
  assert.equal(read('ranges.csv').trim().split('\n').length, rows.length + 1);

  const meta = JSON.parse(read('sources.json'));
  assert.equal(meta.updated_at, '2026-01-02T03:04:05Z');
  const svc = meta.sources.find((s) => s.id === 'svc');
  assert.match(svc.note, /dropped 1 invalid and 1 too broad/);
  assert.equal(meta.sources.find((s) => s.id === 'optin').status, 'not included (opt-in)');
  assert.match(read('SOURCES.md'), /\| Cloud A \| cloud \| 2 \| 1 \| ok \|/);
  assert.equal(res.ipv4, 4);

  const m = load({ dataDir: out });
  assert.equal(m.contains('45.32.15.255'), true);
  assert.equal(m.contains('172.224.226.1'), false);
  assert.deepEqual(load({ dataDir: out, categories: ['privacy-relay'] }).lookup('172.224.226.1'), [{ provider: 'relay', category: 'privacy-relay' }]);
});

test('includes opt-in sources on request', async () => {
  const out = tmpDir();
  await run(out, FEEDS, { include: ['optin'] });
  assert.equal(fs.readFileSync(path.join(out, 'providers/optin.txt'), 'utf8'), '9.9.9.0/24\n');
});

test('keeps previous data when a feed fails or shrinks', async () => {
  const out = tmpDir();
  const big = Array.from({ length: 40 }, (_, i) => `45.${i}.0.0/24`).join('\n');
  await run(out, { ...FEEDS, 'https://a.test/ranges': big });
  const before = fs.readFileSync(path.join(out, 'providers/cloud-a.txt'), 'utf8');

  // cloud-a now returns 3 ranges instead of 40, and cloud-b is down.
  const feeds = { ...FEEDS, 'https://a.test/ranges': '45.0.0.0/24\n45.2.0.0/24\n45.4.0.0/24\n' };
  delete feeds['https://b.test/feed.csv'];
  await run(out, feeds);
  const meta = JSON.parse(fs.readFileSync(path.join(out, 'sources.json'), 'utf8'));
  const a = meta.sources.find((s) => s.id === 'cloud-a');
  const b = meta.sources.find((s) => s.id === 'cloud-b');
  assert.equal(a.status, 'stale');
  assert.match(a.note, /kept previous/);
  assert.equal(fs.readFileSync(path.join(out, 'providers/cloud-a.txt'), 'utf8'), before);
  assert.equal(b.status, 'stale');
  assert.match(b.note, /HTTP 404/);
  assert.equal(fs.readFileSync(path.join(out, 'providers/cloud-b.txt'), 'utf8'), '45.32.0.0/20\n2a05:f480::/32\n');
});

test('writes nothing when every feed fails', async () => {
  const out = tmpDir();
  await assert.rejects(run(out, {}), /Every feed failed/);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('each real source parses a sample of its own format', () => {
  const byId = Object.fromEntries(SOURCES.map((s) => [s.id, s]));
  const samples = {
    aws: [JSON.stringify({ prefixes: [{ ip_prefix: '3.5.140.0/22' }], ipv6_prefixes: [{ ipv6_prefix: '2600:1f00::/24' }] }), ['3.5.140.0/22', '2600:1f00::/24']],
    'google-cloud': [JSON.stringify({ prefixes: [{ ipv4Prefix: '34.80.0.0/15' }, { ipv6Prefix: '2600:1900::/35' }] }), ['34.80.0.0/15', '2600:1900::/35']],
    'oracle-cloud': [JSON.stringify({ regions: [{ region: 'x', cidrs: [{ cidr: '129.146.0.0/21', tags: ['OCI'] }] }] }), ['129.146.0.0/21']],
    digitalocean: ['5.101.96.0/21,NL,NL-NH,Amsterdam,1098 XH\n', ['5.101.96.0/21']],
    linode: ['# geofeed\n# ip_prefix, alpha2code\n2600:3c00::/32,US,US-TX,Richardson,\n', ['2600:3c00::/32']],
    vultr: ['# Vultr\n45.32.0.0/21,US,US-NJ,Piscataway,08854\n', ['45.32.0.0/21']],
    azure: [JSON.stringify({ values: [{ name: 'AzureCloud', properties: { addressPrefixes: ['4.144.0.0/17', '2603:1000::/40'] } }, { name: 'Other', properties: { addressPrefixes: ['1.1.1.0/24'] } }] }), ['4.144.0.0/17', '2603:1000::/40']],
    cloudflare: ['173.245.48.0/20\n\n2400:cb00::/32\n', ['173.245.48.0/20', '2400:cb00::/32']],
    fastly: [JSON.stringify({ addresses: ['23.235.32.0/20'], ipv6_addresses: ['2a04:4e40::/32'] }), ['23.235.32.0/20', '2a04:4e40::/32']],
    github: [JSON.stringify({ verifiable_password_authentication: true, ssh_keys: ['ssh-ed25519 AAAA'], hooks: ['192.30.252.0/22'], actions: ['4.148.0.0/16', '2a01:111:f403::/48'], domains: { website: ['github.com'] } }), ['192.30.252.0/22', '4.148.0.0/16', '2a01:111:f403::/48']],
    'icloud-private-relay': ['172.224.226.0/27,GB,GB-EN,London,\n', ['172.224.226.0/27']],
    tor: ['171.25.193.25\n80.67.167.81\n', ['171.25.193.25', '80.67.167.81']],
    'google-services': [JSON.stringify({ prefixes: [{ ipv4Prefix: '8.8.8.0/24' }] }), ['8.8.8.0/24']],
  };
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(byId).sort(), 'every source has a sample');
  for (const [id, [text, want]] of Object.entries(samples)) assert.deepEqual(byId[id].parse(text), want, id);
});

test('Azure discovers the weekly file from the download page', async () => {
  const azure = SOURCES.find((s) => s.id === 'azure');
  const weekly = 'https://download.microsoft.com/download/7/1/d/abc/ServiceTags_Public_20260105.json';
  const pages = { [azure.url]: `<a href="${weekly}">Download</a>`, [weekly]: '{"values":[]}' };
  const res = await azure.fetchText(async (u) => pages[u]);
  assert.equal(res.resolvedUrl, weekly);
  await assert.rejects(azure.fetchText(async () => '<html></html>'), /no ServiceTags_Public link/);
});
