'use strict';

// IPv4 and IPv6 parsing, formatting and range arithmetic.
// Addresses are BigInt values. Ranges are inclusive [start, end] pairs.

const V4_MAX = (1n << 32n) - 1n;
const V6_MAX = (1n << 128n) - 1n;
const V4_MAPPED_PREFIX = 0xffffn << 32n;

function parseIPv4(s) {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

function parseIPv6(s) {
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null;
  let tail = [];
  const lastColon = s.lastIndexOf(':');
  if (s.indexOf('.') !== -1) {
    const v4 = parseIPv4(s.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [Number(v4 >> 16n), Number(v4 & 0xffffn)];
    s = s.slice(0, lastColon + 1);
    if (!s.endsWith('::')) s = s.slice(0, -1);
    if (s === '') return null;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (h) => (h === '' ? [] : h.split(':'));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  for (const g of head.concat(rest)) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
  }
  const given = head.length + rest.length + tail.length;
  let groups;
  if (halves.length === 2) {
    if (given > 7) return null;
    groups = head.concat(new Array(8 - given).fill('0'), rest);
  } else {
    if (given !== 8) return null;
    groups = head;
  }
  let n = 0n;
  for (const g of groups) n = (n << 16n) | BigInt(parseInt(g, 16));
  for (const t of tail) n = (n << 16n) | BigInt(t);
  return n;
}

// Parses a single address as it may arrive from a socket or a header.
// Accepts "1.2.3.4", "2001:db8::1", "[2001:db8::1]", "fe80::1%eth0" and
// IPv4-mapped IPv6 such as "::ffff:1.2.3.4", which is returned as IPv4.
function parseAddress(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (s.indexOf(':') === -1) {
    const v4 = parseIPv4(s);
    return v4 === null ? null : { family: 4, value: v4 };
  }
  const v6 = parseIPv6(s);
  if (v6 === null) return null;
  if (v6 >> 32n === 0xffffn) return { family: 4, value: v6 & V4_MAX };
  return { family: 6, value: v6 };
}

// Parses "a.b.c.d/len", "x::/len" or a bare address. Host bits are cleared.
function parseCidr(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  const slash = s.indexOf('/');
  const addr = slash === -1 ? s : s.slice(0, slash);
  if (addr.indexOf('%') !== -1 || addr.startsWith('[')) return null;
  const family = addr.indexOf(':') === -1 ? 4 : 6;
  const value = family === 4 ? parseIPv4(addr) : parseIPv6(addr);
  if (value === null) return null;
  const bits = family === 4 ? 32 : 128;
  let prefix = bits;
  if (slash !== -1) {
    const p = s.slice(slash + 1);
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    prefix = Number(p);
    if (prefix > bits) return null;
  }
  const hostBits = BigInt(bits - prefix);
  const start = (value >> hostBits) << hostBits;
  const end = start + (1n << hostBits) - 1n;
  return { family, start, end, prefix };
}

function formatIPv4(n) {
  return [24n, 16n, 8n, 0n].map((sh) => String((n >> sh) & 0xffn)).join('.');
}

// RFC 5952 canonical text form.
function formatIPv6(n) {
  const g = [];
  for (let i = 7; i >= 0; i--) g.push(Number((n >> BigInt(i * 16)) & 0xffffn));
  let bestStart = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (bestStart === -1) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLen).join(':');
  return left + '::' + right;
}

function formatAddress(family, n) {
  return family === 4 ? formatIPv4(n) : formatIPv6(n);
}

// Sorts and merges overlapping or adjacent ranges.
function mergeRanges(ranges) {
  const sorted = ranges.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1n) {
      if (e > last[1]) last[1] = e;
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

// Removes every address in b from a. Both inputs must be merged.
function subtractRanges(a, b) {
  const out = [];
  let j = 0;
  for (const [s0, e] of a) {
    let s = s0;
    while (j < b.length && b[j][1] < s) j++;
    let k = j;
    while (s <= e) {
      if (k >= b.length || b[k][0] > e) { out.push([s, e]); break; }
      const [bs, be] = b[k];
      if (bs > s) out.push([s, bs - 1n]);
      s = be + 1n;
      k++;
    }
  }
  return out;
}

function intersects(a, b) {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i][1] < b[j][0]) i++;
    else if (b[j][1] < a[i][0]) j++;
    else return true;
  }
  return false;
}

// Splits an inclusive range into the smallest list of CIDR blocks.
function rangeToCidrs(family, start, end) {
  const bits = family === 4 ? 32 : 128;
  const out = [];
  let s = start;
  while (s <= end) {
    let size = 0;
    while (size < bits) {
      const next = size + 1;
      const block = 1n << BigInt(next);
      if (s % block !== 0n || s + block - 1n > end) break;
      size = next;
    }
    out.push(formatAddress(family, s) + '/' + (bits - size));
    s += 1n << BigInt(size);
  }
  return out;
}

function rangesToCidrs(family, ranges) {
  const out = [];
  for (const [s, e] of ranges) out.push(...rangeToCidrs(family, s, e));
  return out;
}

module.exports = {
  V4_MAX,
  V6_MAX,
  V4_MAPPED_PREFIX,
  parseIPv4,
  parseIPv6,
  parseAddress,
  parseCidr,
  formatIPv4,
  formatIPv6,
  formatAddress,
  mergeRanges,
  subtractRanges,
  intersects,
  rangeToCidrs,
  rangesToCidrs,
};
