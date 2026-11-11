'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ip = require('../src/ip');

test('parses IPv4 strictly', () => {
  assert.equal(ip.parseIPv4('1.2.3.4'), 0x01020304n);
  assert.equal(ip.parseIPv4('255.255.255.255'), ip.V4_MAX);
  for (const bad of ['1.2.3', '1.2.3.4.5', '256.0.0.1', '01.2.3.4', '1.2.3.-4', '1..3.4', 'a.b.c.d', '']) {
    assert.equal(ip.parseIPv4(bad), null, bad);
  }
});

test('parses IPv6 forms', () => {
  assert.equal(ip.parseIPv6('::'), 0n);
  assert.equal(ip.parseIPv6('::1'), 1n);
  assert.equal(ip.parseIPv6('2001:db8::'), 0x20010db8n << 96n);
  assert.equal(ip.parseIPv6('2001:DB8:0:0:0:0:0:1'), (0x20010db8n << 96n) | 1n);
  assert.equal(ip.parseIPv6('::ffff:1.2.3.4'), (0xffffn << 32n) | 0x01020304n);
  assert.equal(ip.parseIPv6('64:ff9b::192.0.2.33'), (0x64ff9bn << 96n) | 0xc0000221n);
  assert.equal(ip.parseIPv6('1:2:3:4:5:6:1.2.3.4'), ip.parseIPv6('1:2:3:4:5:6:102:304'));
  for (const bad of ['1::2::3', '12345::', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7', ':1.2.3.4', 'g::1', '::1.2.3']) {
    assert.equal(ip.parseIPv6(bad), null, bad);
  }
});

test('parseAddress handles socket and header forms', () => {
  assert.deepEqual(ip.parseAddress('::ffff:8.8.8.8'), { family: 4, value: 0x08080808n });
  assert.deepEqual(ip.parseAddress('[2001:db8::1]'), { family: 6, value: (0x20010db8n << 96n) | 1n });
  assert.deepEqual(ip.parseAddress('fe80::1%eth0'), { family: 6, value: (0xfe80n << 112n) | 1n });
  assert.deepEqual(ip.parseAddress(' 1.2.3.4\n'), { family: 4, value: 0x01020304n });
  assert.equal(ip.parseAddress('1.2.3.4/32'), null);
  assert.equal(ip.parseAddress(undefined), null);
  assert.equal(ip.parseAddress(16909060), null);
});

test('parseCidr clears host bits and rejects bad prefixes', () => {
  const r = ip.parseCidr('192.0.2.77/24');
  assert.equal(ip.formatIPv4(r.start), '192.0.2.0');
  assert.equal(ip.formatIPv4(r.end), '192.0.2.255');
  assert.equal(ip.parseCidr('10.0.0.1').prefix, 32);
  assert.equal(ip.parseCidr('2001:db8::/129'), null);
  assert.equal(ip.parseCidr('1.2.3.4/33'), null);
  assert.equal(ip.parseCidr('1.2.3.4/024'), null);
  assert.equal(ip.parseCidr('0.0.0.0/0').end, ip.V4_MAX);
  assert.equal(ip.parseCidr('::/0').end, ip.V6_MAX);
});

test('formats IPv6 in RFC 5952 form', () => {
  const cases = {
    '2001:0db8:0000:0000:0000:0000:0000:0001': '2001:db8::1',
    '2001:db8:0:1:1:1:1:1': '2001:db8:0:1:1:1:1:1',
    '2001:0:0:1:0:0:0:1': '2001:0:0:1::1',
    '2001:db8:0:0:1:0:0:1': '2001:db8::1:0:0:1',
    '0:0:0:0:0:0:0:0': '::',
    '1:0:0:0:0:0:0:0': '1::',
    'fe80:0:0:0:0:0:0:1': 'fe80::1',
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(ip.formatIPv6(ip.parseIPv6(input)), want);
});

test('merges overlapping and adjacent ranges', () => {
  assert.deepEqual(ip.mergeRanges([[10n, 20n], [0n, 5n], [6n, 8n], [15n, 30n], [40n, 41n]]), [[0n, 8n], [10n, 30n], [40n, 41n]]);
});

test('subtracts ranges', () => {
  const a = [[0n, 100n], [200n, 300n]];
  const b = [[10n, 20n], [90n, 210n], [250n, 250n]];
  assert.deepEqual(ip.subtractRanges(a, b), [[0n, 9n], [21n, 89n], [211n, 249n], [251n, 300n]]);
  assert.deepEqual(ip.subtractRanges(a, []), a);
  assert.deepEqual(ip.subtractRanges(a, [[0n, 1000n]]), []);
});

test('splits ranges into minimal CIDR blocks', () => {
  const r = (s, e) => ip.rangeToCidrs(4, ip.parseIPv4(s), ip.parseIPv4(e));
  assert.deepEqual(r('10.0.0.0', '10.0.1.255'), ['10.0.0.0/23']);
  assert.deepEqual(r('10.0.0.1', '10.0.0.6'), ['10.0.0.1/32', '10.0.0.2/31', '10.0.0.4/31', '10.0.0.6/32']);
  assert.deepEqual(r('0.0.0.0', '255.255.255.255'), ['0.0.0.0/0']);
  assert.deepEqual(ip.rangeToCidrs(6, 0n, ip.V6_MAX), ['::/0']);
});

test('CIDR round trip through ranges covers exactly the same addresses', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let i = 0; i < 300; i++) {
    const s = BigInt(rnd());
    const e = s + BigInt(rnd() % 100000);
    const blocks = ip.rangeToCidrs(4, s, e).map(ip.parseCidr);
    assert.equal(blocks[0].start, s);
    assert.equal(blocks[blocks.length - 1].end, e);
    for (let k = 1; k < blocks.length; k++) assert.equal(blocks[k].start, blocks[k - 1].end + 1n);
  }
});
