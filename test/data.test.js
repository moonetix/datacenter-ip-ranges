'use strict';

// Checks the data shipped in data/, the CLI, and that the PHP helper gives
// the same answers as the Node matcher.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ip = require('../src/ip');
const { isDatacenterIp, lookup, readList, DEFAULT_DATA_DIR } = require('../src/index');
const { SOURCES, DATACENTER_CATEGORIES } = require('../src/sources');

const data = (f) => path.join(DEFAULT_DATA_DIR, f);
const ROOT = path.join(__dirname, '..');

test('every list is canonical, sorted and free of overlaps', () => {
  const files = ['all.txt', 'ipv4.txt', 'ipv6.txt', ...fs.readdirSync(data('providers')).map((f) => `providers/${f}`)];
  for (const f of files) {
    const cidrs = readList(data(f));
    assert.ok(cidrs.length > 0, `${f} is not empty`);
    let prev = null;
    for (const c of cidrs) {
      const r = ip.parseCidr(c);
      assert.ok(r, `${f}: ${c} parses`);
      assert.equal(`${ip.formatAddress(r.family, r.start)}/${r.prefix}`, c, `${f}: ${c} is canonical`);
      if (prev && prev.family === r.family) assert.ok(r.start > prev.end, `${f}: ${c} is sorted and does not overlap`);
      if (prev) assert.ok(prev.family <= r.family, `${f}: IPv4 comes before IPv6`);
      prev = r;
    }
  }
});

test('all.txt is exactly ipv4.txt plus ipv6.txt, and covers every datacenter provider', () => {
  const all = fs.readFileSync(data('all.txt'), 'utf8');
  assert.equal(all, fs.readFileSync(data('ipv4.txt'), 'utf8') + fs.readFileSync(data('ipv6.txt'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(data('sources.json'), 'utf8'));
  for (const s of meta.sources.filter((x) => x.file && DATACENTER_CATEGORIES.includes(x.category))) {
    const sample = readList(data(s.file)).slice(0, 25);
    for (const c of sample) {
      const r = ip.parseCidr(c);
      const first = ip.formatAddress(r.family, r.start);
      assert.equal(isDatacenterIp(first), true, `${s.id} ${first}`);
    }
  }
});

test('sources.json lists every source and matches the files', () => {
  const meta = JSON.parse(fs.readFileSync(data('sources.json'), 'utf8'));
  assert.deepEqual(meta.sources.map((s) => s.id), SOURCES.map((s) => s.id));
  for (const s of meta.sources) {
    if (!s.file) continue;
    const cidrs = readList(data(s.file));
    assert.equal(cidrs.filter((c) => !c.includes(':')).length, s.ipv4, `${s.id} IPv4 count`);
    assert.equal(cidrs.filter((c) => c.includes(':')).length, s.ipv6, `${s.id} IPv6 count`);
  }
  assert.ok(!fs.existsSync(data('providers/azure.txt')) || process.env.DCIP_ALLOW_AZURE, 'Azure data is not committed');
  const rows = JSON.parse(fs.readFileSync(data('ranges.json'), 'utf8'));
  const csv = fs.readFileSync(data('ranges.csv'), 'utf8').trim().split('\n');
  assert.equal(csv.length, rows.length + 1);
});

test('well-known addresses', () => {
  assert.equal(isDatacenterIp('104.16.0.1'), true);
  assert.equal(isDatacenterIp('2606:4700::1'), true);
  assert.equal(isDatacenterIp('::ffff:104.16.0.1'), true);
  assert.equal(isDatacenterIp('8.8.8.8'), true);
  for (const no of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '::1', 'fe80::1', '203.0.113.9', 'not an ip', '']) {
    assert.equal(isDatacenterIp(no), false, no);
  }
  assert.deepEqual(lookup('104.16.0.1'), [{ provider: 'cloudflare', category: 'cdn' }]);
  assert.equal(lookup('nope'), null);
});

test('no special-purpose range appears in any list', () => {
  const special = ['10.0.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1', '192.168.1.1', '100.64.0.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1'];
  for (const s of special) assert.deepEqual(lookup(s), [], s);
});

test('CLI prints matches and uses grep-style exit codes', () => {
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin/check.js'), ...args], { encoding: 'utf8' });
  let r = cli('104.16.0.1');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^104\.16\.0\.1\s+cloudflare\s+cdn\s+104\.16\.0\.0\/1[0-9]\n$/);
  r = cli('192.168.1.1');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not listed/);
  r = cli('1.2.3');
  assert.equal(r.status, 2);
  r = cli('--json', '104.16.0.1');
  assert.equal(JSON.parse(r.stdout).matches[0].provider, 'cloudflare');
  r = spawnSync(process.execPath, [path.join(ROOT, 'bin/check.js'), '-'], { input: '10.0.0.1\n104.16.0.1\n', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim().split('\n').length, 2);
  r = cli('--only', 'tor', '104.16.0.1');
  assert.equal(r.status, 1);
  r = cli();
  assert.equal(r.status, 2);
});

const php = spawnSync('php', ['-v'], { encoding: 'utf8' });
test('PHP helper agrees with the Node matcher', { skip: php.status !== 0 && 'php not installed' }, () => {
  const samples = [];
  for (const c of readList(data('all.txt')).filter((_, i) => i % 7 === 0)) {
    const r = ip.parseCidr(c);
    const max = r.family === 4 ? ip.V4_MAX : ip.V6_MAX;
    for (const v of [r.start - 1n, r.start, r.end, r.end + 1n]) {
      if (v >= 0n && v <= max) samples.push(ip.formatAddress(r.family, v));
    }
  }
  samples.push('::ffff:104.16.0.1', '127.0.0.1', '2606:4700::1');
  const r = spawnSync('php', [path.join(ROOT, 'php/check.php'), '-'], { input: samples.join('\n'), encoding: 'utf8', maxBuffer: 64 << 20 });
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, samples.length);
  let mismatches = 0;
  lines.forEach((line, i) => {
    const phpSays = line.endsWith(' listed') && !line.endsWith('not listed');
    if (phpSays !== isDatacenterIp(samples[i])) mismatches++;
  });
  assert.equal(mismatches, 0, `${mismatches} of ${samples.length} addresses differ`);
});

test('PHP unit tests pass', { skip: php.status !== 0 && 'php not installed' }, () => {
  const r = spawnSync('php', [path.join(ROOT, 'php/test.php')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
