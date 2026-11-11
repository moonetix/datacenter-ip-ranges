'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMatcher } = require('../src/matcher');
const ip = require('../src/ip');

const lists = [
  { id: 'a', category: 'cloud', cidrs: ['10.0.0.0/8', '192.0.2.0/24', '2001:db8::/32'] },
  { id: 'b', category: 'cdn', cidrs: ['10.1.0.0/16', '198.51.100.0/24', '2001:db8:1::/48'] },
  { id: 'c', category: 'tor', cidrs: ['10.1.2.3', '2001:db8:1::5'] },
];

test('reports every list that contains the address', () => {
  const m = createMatcher(lists);
  const ids = (x) => m.lookup(x).map((r) => r.provider);
  assert.deepEqual(ids('10.0.0.1'), ['a']);
  assert.deepEqual(ids('10.1.0.1'), ['a', 'b']);
  assert.deepEqual(ids('10.1.2.3'), ['a', 'b', 'c']);
  assert.deepEqual(ids('10.1.2.4'), ['a', 'b']);
  assert.deepEqual(ids('198.51.100.255'), ['b']);
  assert.deepEqual(ids('2001:db8:1::5'), ['a', 'b', 'c']);
  assert.deepEqual(ids('2001:db8:2::'), ['a']);
  assert.deepEqual(ids('11.0.0.0'), []);
  assert.deepEqual(ids('::ffff:10.1.2.3'), ['a', 'b', 'c']);
  assert.equal(m.lookup('bogus'), null);
  assert.equal(m.contains('bogus'), false);
  assert.deepEqual(m.lookup('192.0.2.1')[0], { provider: 'a', category: 'cloud' });
});

test('handles the edges of the address space', () => {
  const m = createMatcher([{ id: 'x', category: 'cloud', cidrs: ['0.0.0.0/8', '255.255.255.0/24', '::/16', 'ffff::/16'] }]);
  for (const yes of ['0.0.0.0', '0.255.255.255', '255.255.255.255', '::', '0:ffff::1', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff']) {
    assert.equal(m.contains(yes), true, yes);
  }
  for (const no of ['1.0.0.0', '255.255.254.255', '1::', 'fffe:ffff::']) assert.equal(m.contains(no), false, no);
  assert.equal(createMatcher([]).contains('1.2.3.4'), false);
});

test('rejects invalid CIDRs and too many lists', () => {
  assert.throws(() => createMatcher([{ id: 'x', category: 'cloud', cidrs: ['1.2.3.4/40'] }]), /invalid CIDR/);
  assert.throws(() => createMatcher(Array.from({ length: 31 }, (_, i) => ({ id: `l${i}`, cidrs: [] }))), /at most/);
});

test('agrees with a brute-force check on random data', () => {
  let seed = 42;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const randomV4 = () => [rnd(256), rnd(256), rnd(256), rnd(256)].join('.');
  const randomV6 = () => `2001:db8:${rnd(4).toString(16)}:${rnd(65536).toString(16)}::${rnd(65536).toString(16)}`;
  const gen = Array.from({ length: 6 }, (_, k) => ({
    id: `p${k}`,
    category: 'cloud',
    cidrs: [
      ...Array.from({ length: 200 }, () => `${randomV4()}/${8 + rnd(25)}`),
      ...Array.from({ length: 100 }, () => `${randomV6()}/${36 + rnd(93)}`),
    ],
  }));
  const parsed = gen.map((l) => l.cidrs.map(ip.parseCidr));
  const m = createMatcher(gen);
  const edges = parsed.flat().slice(0, 400).flatMap((r) => {
    const max = r.family === 4 ? ip.V4_MAX : ip.V6_MAX;
    return [r.start - 1n, r.start, r.end, r.end + 1n].filter((v) => v >= 0n && v <= max).map((v) => ip.formatAddress(r.family, v));
  });
  const samples = [...edges, ...Array.from({ length: 4000 }, (_, i) => (i % 2 ? randomV4() : randomV6()))];
  for (const addr of samples) {
    const a = ip.parseAddress(addr);
    const want = gen
      .filter((_, k) => parsed[k].some((r) => r.family === a.family && a.value >= r.start && a.value <= r.end))
      .map((l) => l.id);
    assert.deepEqual(m.lookup(addr).map((r) => r.provider), want, addr);
  }
});
