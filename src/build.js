'use strict';

// Fetches every feed in sources.js, normalizes and merges the ranges, and
// writes the files in data/.
//
// A feed that fails, or that suddenly shrinks by more than half, keeps its
// previous data and is marked "stale" in data/sources.json. buildData() throws
// only if every feed failed, and then writes nothing.

const fs = require('node:fs');
const path = require('node:path');
const ip = require('./ip');
const { SOURCES, CATEGORIES, DATACENTER_CATEGORIES } = require('./sources');

const USER_AGENT = 'datacenter-ip-ranges/1.0 (+https://github.com/moonetix/datacenter-ip-ranges)';
const TIMEOUT_MS = 60000;
const SHRINK_LIMIT = 0.5;

// Never let a feed mark private, loopback, link-local or other special ranges.
const SPECIAL = {
  4: ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
    '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
    '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'],
  6: ['::/8', '100::/64', '2001:db8::/32', 'fc00::/7', 'fe80::/10', 'ff00::/8'],
};
// Anything broader than this is treated as a feed error.
const MIN_PREFIX = { 4: 8, 6: 16 };

async function get(url) {
  const headers = { 'User-Agent': USER_AGENT, Accept: '*/*' };
  if (url.startsWith('https://api.github.com/') && process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastError = e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  throw new Error(`${url}: ${lastError.message}`);
}

function specialRanges(family) {
  return ip.mergeRanges(SPECIAL[family].map((c) => {
    const r = ip.parseCidr(c);
    return [r.start, r.end];
  }));
}

// Turns raw CIDR strings into merged ranges per family, with counts of what was dropped.
function normalize(cidrs) {
  const acc = { 4: [], 6: [] };
  let invalid = 0;
  let tooBroad = 0;
  for (const c of cidrs) {
    const r = typeof c === 'string' ? ip.parseCidr(c) : null;
    if (!r) { invalid++; continue; }
    if (r.prefix < MIN_PREFIX[r.family]) { tooBroad++; continue; }
    acc[r.family].push([r.start, r.end]);
  }
  return {
    4: ip.subtractRanges(ip.mergeRanges(acc[4]), specialRanges(4)),
    6: ip.subtractRanges(ip.mergeRanges(acc[6]), specialRanges(6)),
    invalid,
    tooBroad,
  };
}

function readPrevious(outDir, id) {
  const file = path.join(outDir, 'providers', `${id}.txt`);
  if (!fs.existsSync(file)) return null;
  return normalize(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean));
}

function count(r) {
  return r[4].length + r[6].length;
}

function toCidrs(r) {
  return [...ip.rangesToCidrs(4, r[4]), ...ip.rangesToCidrs(6, r[6])];
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeList(file, cidrs) {
  writeFile(file, cidrs.length ? cidrs.join('\n') + '\n' : '');
}

function union(parts) {
  return {
    4: ip.mergeRanges(parts.flatMap((p) => p[4])),
    6: ip.mergeRanges(parts.flatMap((p) => p[6])),
  };
}

function csvField(v) {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// Fetches the feeds and writes every file in outDir. Returns the source summary.
// options: outDir (required), include (opt-in source IDs), sources, get(url), now, log
async function buildData(options) {
  const outDir = options.outDir;
  const include = options.include || [];
  const sources = options.sources || SOURCES;
  const fetchText = options.get || get;
  const log = options.log || (() => {});
  const selected = sources.filter((s) => !s.optIn || include.includes(s.id));
  const fetchedAt = (options.now || new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Fetch everything in parallel.
  const raw = await Promise.all(selected.map(async (src) => {
    try {
      let text;
      let resolvedUrl = src.url;
      if (src.fetchText) {
        ({ text, resolvedUrl } = await src.fetchText(fetchText));
      } else {
        text = await fetchText(src.url);
        if (src.urlV6) text += '\n' + (await fetchText(src.urlV6));
      }
      return { src, cidrs: src.parse(text), resolvedUrl };
    } catch (e) {
      return { src, error: e.message };
    }
  }));

  const results = new Map();
  for (const { src, cidrs, resolvedUrl, error } of raw) {
    const previous = readPrevious(outDir, src.id);
    let ranges = null;
    let status = 'ok';
    let note = '';
    if (error) {
      status = 'stale';
      note = `fetch or parse failed: ${error}`;
    } else {
      ranges = normalize(cidrs);
      if (ranges.invalid || ranges.tooBroad) {
        note = `dropped ${ranges.invalid} invalid and ${ranges.tooBroad} too broad entries`;
      }
      if (count(ranges) === 0) {
        status = 'stale';
        note = 'feed returned no ranges';
        ranges = null;
      }
    }
    results.set(src.id, { src, ranges, previous, status, note, resolvedUrl: resolvedUrl || src.url });
  }

  // google-services is goog.json minus cloud.json.
  for (const r of results.values()) {
    if (!r.src.subtract || !r.ranges) continue;
    const base = results.get(r.src.subtract);
    const minus = (base && (base.ranges || base.previous)) || readPrevious(outDir, r.src.subtract);
    if (!minus) {
      r.status = 'stale';
      r.note = `cannot subtract ${r.src.subtract}: no data`;
      r.ranges = null;
      continue;
    }
    r.ranges = { 4: ip.subtractRanges(r.ranges[4], minus[4]), 6: ip.subtractRanges(r.ranges[6], minus[6]) };
  }

  // Shrink guard: keep the previous list if a feed suddenly loses more than half its ranges.
  for (const r of results.values()) {
    if (r.ranges && r.previous && count(r.previous) > 20 && count(r.ranges) < count(r.previous) * SHRINK_LIMIT) {
      r.status = 'stale';
      r.note = `new list has ${count(r.ranges)} ranges, previous had ${count(r.previous)}; kept previous`;
      r.ranges = null;
    }
    if (!r.ranges) r.ranges = r.previous;
  }

  if ([...results.values()].every((r) => r.status !== 'ok')) {
    const why = [...results.values()].map((r) => `${r.src.id}: ${r.note}`).join('\n');
    throw new Error(`Every feed failed. Nothing was written.\n${why}`);
  }

  // Per provider files.
  const sourcesMeta = [];
  const rows = [];
  const byCategory = {};
  for (const src of sources) {
    const r = results.get(src.id);
    const entry = {
      id: src.id,
      name: src.name,
      category: src.category,
      url: src.url,
      url_v6: src.urlV6,
      docs: src.docs,
      terms: src.terms,
    };
    if (!r || !r.ranges) {
      entry.status = src.optIn && !results.has(src.id) ? 'not included (opt-in)' : 'unavailable';
      if (r && r.note) entry.note = r.note;
      sourcesMeta.push(entry);
      continue;
    }
    const cidrs = toCidrs(r.ranges);
    const file = `providers/${src.id}.txt`;
    writeList(path.join(outDir, file), cidrs);
    Object.assign(entry, {
      file,
      status: r.status,
      ipv4: r.ranges[4].length ? ip.rangesToCidrs(4, r.ranges[4]).length : 0,
      ipv6: r.ranges[6].length ? ip.rangesToCidrs(6, r.ranges[6]).length : 0,
      fetched_at: r.status === 'ok' ? fetchedAt : undefined,
      resolved_url: r.resolvedUrl !== src.url ? r.resolvedUrl : undefined,
      note: r.note || undefined,
    });
    sourcesMeta.push(entry);
    (byCategory[src.category] ||= []).push(r.ranges);
    for (const c of cidrs) {
      const source = src.urlV6 && c.includes(':') ? src.urlV6 : r.resolvedUrl;
      rows.push({ provider: src.id, category: src.category, cidr: c, source });
    }
  }

  // Per category files and the combined datacenter lists.
  for (const cat of Object.keys(CATEGORIES)) {
    const u = union(byCategory[cat] || []);
    writeList(path.join(outDir, 'categories', `${cat}.txt`), toCidrs(u));
  }
  const dc = union(DATACENTER_CATEGORIES.flatMap((c) => byCategory[c] || []));
  const v4 = ip.rangesToCidrs(4, dc[4]);
  const v6 = ip.rangesToCidrs(6, dc[6]);
  writeList(path.join(outDir, 'all.txt'), [...v4, ...v6]);
  writeList(path.join(outDir, 'ipv4.txt'), v4);
  writeList(path.join(outDir, 'ipv6.txt'), v6);

  // ranges.json and ranges.csv: every provider range, all categories.
  writeFile(path.join(outDir, 'ranges.json'), '[\n' + rows.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n');
  writeFile(
    path.join(outDir, 'ranges.csv'),
    'provider,category,cidr,source\n' + rows.map((r) => [r.provider, r.category, r.cidr, r.source].map(csvField).join(',')).join('\n') + '\n',
  );

  // sources.json and SOURCES.md: what was fetched, when, and how much.
  const meta = { updated_at: fetchedAt, datacenter_categories: DATACENTER_CATEGORIES, categories: CATEGORIES, sources: sourcesMeta };
  writeFile(path.join(outDir, 'sources.json'), JSON.stringify(meta, null, 2) + '\n');

  const md = [
    '# Sources',
    '',
    `Last run ${fetchedAt} by \`scripts/update.js\`. This file is rewritten on every run.`,
    '',
    `Datacenter lists (\`all.txt\`, \`ipv4.txt\`, \`ipv6.txt\`): ${v4.length} IPv4 and ${v6.length} IPv6 CIDR blocks.`,
    '',
    '| Provider | Category | IPv4 | IPv6 | Status | Fetched (UTC) | Feed |',
    '| --- | --- | ---: | ---: | --- | --- | --- |',
    ...sourcesMeta.map((s) => `| ${s.name} | ${s.category} | ${s.ipv4 ?? '-'} | ${s.ipv6 ?? '-'} | ${s.status}${s.note ? ` (${s.note})` : ''} | ${s.fetched_at || '-'} | ${[s.url, s.url_v6].filter(Boolean).map((u) => `[${new URL(u).host}${new URL(u).pathname}](${u})`).join(', ')} |`),
    '',
  ].join('\n');
  writeFile(path.join(outDir, 'SOURCES.md'), md);

  for (const s of sourcesMeta) {
    const counts = s.file ? `${String(s.ipv4).padStart(7)} v4 ${String(s.ipv6).padStart(7)} v6` : ''.padStart(21);
    log(`${s.id.padEnd(22)} ${counts}  ${s.status}${s.note ? ': ' + s.note : ''}`);
  }
  log(`datacenter total     ${String(v4.length).padStart(7)} v4 ${String(v6.length).padStart(7)} v6`);
  return { updatedAt: fetchedAt, sources: sourcesMeta, ipv4: v4.length, ipv6: v6.length };
}

module.exports = { buildData, normalize, SPECIAL, MIN_PREFIX };
