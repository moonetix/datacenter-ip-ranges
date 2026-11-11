'use strict';

const { parseAddress, parseCidr, mergeRanges } = require('./ip');

// A matcher answers "which lists contain this address" with one binary search.
// The ranges of all lists are cut into disjoint segments, and each segment
// carries a bit mask of the lists that cover it. IPv4 uses plain numbers,
// IPv6 uses BigInt.

const MAX_LISTS = 30;

function buildFamily(perList, family) {
  const events = [];
  perList.forEach((ranges, idx) => {
    for (const [s, e] of ranges) {
      events.push([s, idx, 1]);
      events.push([e + 1n, idx, -1]);
    }
  });
  events.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const counts = new Array(perList.length).fill(0);
  const starts = [];
  const ends = [];
  const masks = [];
  let mask = 0;
  for (let i = 0; i < events.length; ) {
    const pos = events[i][0];
    while (i < events.length && events[i][0] === pos) {
      const [, idx, d] = events[i];
      counts[idx] += d;
      i++;
    }
    mask = 0;
    for (let k = 0; k < counts.length; k++) if (counts[k] > 0) mask |= 1 << k;
    if (i < events.length && mask !== 0) {
      const end = events[i][0] - 1n;
      const last = starts.length - 1;
      if (last >= 0 && masks[last] === mask && ends[last] + 1n === pos) {
        ends[last] = end;
      } else {
        starts.push(pos);
        ends.push(end);
        masks.push(mask);
      }
    }
  }
  if (family === 4) {
    return {
      starts: Float64Array.from(starts, Number),
      ends: Float64Array.from(ends, Number),
      masks: Int32Array.from(masks),
    };
  }
  return { starts, ends, masks: Int32Array.from(masks) };
}

// Fast path for the common case: a plain dotted IPv4 string. Returns -1 if
// the input is anything else, so the caller can fall back to the full parser.
function fastIPv4(s) {
  const len = s.length;
  if (len < 7 || len > 15) return -1;
  let n = 0;
  let part = 0;
  let digits = 0;
  let dots = 0;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      if (digits === 1 && part === 0) return -1;
      part = part * 10 + (c - 48);
      if (++digits > 3 || part > 255) return -1;
    } else if (c === 46) {
      if (digits === 0 || ++dots > 3) return -1;
      n = n * 256 + part;
      part = 0;
      digits = 0;
    } else {
      return -1;
    }
  }
  if (dots !== 3 || digits === 0) return -1;
  return n * 256 + part;
}

function search(table, x) {
  const { starts, ends, masks } = table;
  let lo = 0;
  let hi = starts.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= x) {
      hit = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return hit !== -1 && x <= ends[hit] ? masks[hit] : 0;
}

// lists: [{ id, category, cidrs: [string] }]
function createMatcher(lists) {
  if (lists.length > MAX_LISTS) throw new Error(`at most ${MAX_LISTS} lists per matcher`);
  const v4 = lists.map(() => []);
  const v6 = lists.map(() => []);
  lists.forEach((list, idx) => {
    for (const c of list.cidrs) {
      const r = parseCidr(c);
      if (!r) throw new Error(`invalid CIDR in ${list.id}: ${c}`);
      (r.family === 4 ? v4 : v6)[idx].push([r.start, r.end]);
    }
  });
  const t4 = buildFamily(v4.map(mergeRanges), 4);
  const t6 = buildFamily(v6.map(mergeRanges), 6);
  const meta = lists.map((l) => ({ provider: l.id, category: l.category }));

  function maskOf(ip) {
    if (typeof ip === 'string') {
      const n = fastIPv4(ip);
      if (n !== -1) return search(t4, n);
    }
    const a = parseAddress(ip);
    if (!a) return -1;
    return a.family === 4 ? search(t4, Number(a.value)) : search(t6, a.value);
  }

  return {
    size: { ipv4Segments: t4.starts.length, ipv6Segments: t6.starts.length },
    // Returns true if the address is in any list. Invalid input returns false.
    contains(ip) {
      return maskOf(ip) > 0;
    },
    // Returns [{ provider, category }] for every list that contains the address,
    // an empty array if none does, or null if the input is not an IP address.
    lookup(ip) {
      const mask = maskOf(ip);
      if (mask < 0) return null;
      const out = [];
      for (let k = 0; k < meta.length; k++) if (mask & (1 << k)) out.push(meta[k]);
      return out;
    },
  };
}

module.exports = { createMatcher };
