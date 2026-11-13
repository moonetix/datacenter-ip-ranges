// Builds the GitHub Pages demo into _site/.
//
//   node scripts/build-site.mjs
//
// - copies site/ (page, styles, scripts)
// - turns src/ip.js and src/matcher.js into browser ES modules (same code,
//   comments removed, wrapped so require() and module.exports work)
// - derives data/lookup.json: every provider list, delta-encoded, about half
//   the size of the CIDR text (a third once gzipped) instead of ranges.json
// - copies the published lists so the download links are same-origin
// - checks that the encoded lists decode back to the exact files in data/,
//   that the browser matcher answers like the Node package, and that the
//   page's verdict, CSV and output formatting agree with it too
//
// Node 22 built-ins only. The output depends only on the repo contents.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const OUT = path.join(ROOT, '_site');
const DATA = path.join(ROOT, 'data');
const require = createRequire(import.meta.url);
const ip = require(path.join(ROOT, 'src', 'ip.js'));
// The private and reserved ranges the data build removes from every feed. The
// page uses the same list to explain why such an address is never listed.
const { SPECIAL } = require(path.join(ROOT, 'src', 'build.js'));

// Azure ranges can be fetched locally with --include azure but are never
// redistributed (see .gitignore and the README), so they stay out of the site.
const NOT_REDISTRIBUTED = new Set(['azure']);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

// Removes // and /* */ comments. Knows about strings, template literals and
// regex literals, which is all src/ip.js and src/matcher.js use.
function stripComments(src) {
  let out = '';
  let i = 0;
  let lastSig = '';
  let word = '';
  const regexAfter = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
  const regexAfterWord = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw']);
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated block comment');
      i = end + 2;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (c === '`' && src[j] === '$' && src[j + 1] === '{') {
          if (src.indexOf('`', j) < src.indexOf('}', j)) throw new Error('nested template literal not supported');
        } else if (c !== '`' && src[j] === '\n') throw new Error('unterminated string');
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      lastSig = c;
      word = '';
      continue;
    }
    if (c === '/' && (regexAfter.has(lastSig) || regexAfterWord.has(word))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '\n') throw new Error('unterminated regex');
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        j++;
      }
      j++;
      while (j < src.length && /[a-z]/.test(src[j])) j++;
      out += src.slice(i, j);
      i = j;
      lastSig = '/';
      word = '';
      continue;
    }
    const ident = /[A-Za-z0-9_$]/;
    if (ident.test(c)) word = (ident.test(out[out.length - 1] || '') ? word : '') + c;
    else if (!/\s/.test(c)) word = '';
    if (!/\s/.test(c)) lastSig = c;
    out += c;
    i++;
  }
  return out
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l !== '')
    .join('\n') + '\n';
}

// Wraps a CommonJS file from src/ as an ES module with the same exports.
function toBrowserModule(name) {
  const file = path.join(ROOT, 'src', `${name}.js`);
  const source = stripComments(fs.readFileSync(file, 'utf8'));
  const deps = [...new Set([...source.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]))];
  for (const dep of deps) {
    if (!dep.startsWith('./')) throw new Error(`src/${name}.js requires ${dep}, which does not run in a browser`);
  }
  const names = Object.keys(require(file));
  const imports = deps.map((dep, k) => `import __dep${k} from '${dep}.js';`).join('\n');
  const table = deps.length ? `{ ${deps.map((dep, k) => `'${dep}': __dep${k}`).join(', ')} }` : '{}';
  return [
    imports,
    'const module = { exports: {} };',
    '(function (module, exports, require) {',
    source.trimEnd(),
    `})(module, module.exports, (id) => (${table})[id]);`,
    'export default module.exports;',
    `export const { ${names.join(', ')} } = module.exports;`,
    '',
  ]
    .filter((l, k) => k !== 0 || l !== '')
    .join('\n');
}

function readList(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

// Each family becomes "gap+prefix" tokens: the gap from the end of the previous
// block to the start of this one, then the prefix length. IPv4 uses base 36
// with a one-character prefix, IPv6 uses hex with a two-character prefix.
function encodeList(cidrs, label) {
  const parts = { 4: [], 6: [] };
  const next = { 4: 0n, 6: 0n };
  for (const text of cidrs) {
    const r = ip.parseCidr(text);
    if (!r) throw new Error(`${label}: invalid CIDR ${text}`);
    const gap = r.start - next[r.family];
    if (gap < 0n) throw new Error(`${label}: ${text} is not sorted or overlaps`);
    const prefix = r.family === 4 ? r.prefix.toString(36) : r.prefix.toString(16).padStart(2, '0');
    const gapText = gap === 0n ? '' : gap.toString(r.family === 4 ? 36 : 16);
    parts[r.family].push(gapText + prefix);
    next[r.family] = r.end + 1n;
  }
  return { v4: parts[4].join(','), v6: parts[6].join(','), ipv4: parts[4].length, ipv6: parts[6].length };
}

function countFamilies(cidrs) {
  let ipv4 = 0;
  let ipv6 = 0;
  for (const c of cidrs) c.includes(':') ? ipv6++ : ipv4++;
  return { ipv4, ipv6 };
}

fs.rmSync(OUT, { recursive: true, force: true });
copyDir(SITE, OUT);

fs.mkdirSync(path.join(OUT, 'lib'), { recursive: true });
for (const name of ['ip', 'matcher']) {
  fs.writeFileSync(path.join(OUT, 'lib', `${name}.js`), toBrowserModule(name));
}

const meta = JSON.parse(fs.readFileSync(path.join(DATA, 'sources.json'), 'utf8'));
const providers = [];
const originals = new Map();
for (const src of meta.sources) {
  if (NOT_REDISTRIBUTED.has(src.id) || !src.file) {
    providers.push({ id: src.id, name: src.name, category: src.category, status: src.status, docs: src.docs || '', file: '', ipv4: 0, ipv6: 0, v4: '', v6: '' });
    continue;
  }
  const cidrs = readList(path.join(DATA, src.file));
  originals.set(src.id, cidrs);
  const enc = encodeList(cidrs, src.file);
  providers.push({
    id: src.id,
    name: src.name,
    category: src.category,
    status: src.status,
    docs: src.docs || '',
    file: src.file,
    fetched_at: src.fetched_at || '',
    ipv4: enc.ipv4,
    ipv6: enc.ipv6,
    v4: enc.v4,
    v6: enc.v6,
  });
}

const categories = Object.entries(meta.categories).map(([id, label]) => {
  const file = `categories/${id}.txt`;
  const counts = fs.existsSync(path.join(DATA, file)) ? countFamilies(readList(path.join(DATA, file))) : { ipv4: 0, ipv6: 0 };
  return {
    id,
    label,
    datacenter: meta.datacenter_categories.includes(id),
    file,
    providers: providers.filter((p) => p.category === id && p.file).map((p) => p.id),
    ...counts,
  };
});

const DOWNLOADS = [
  ['all.txt', 'Every datacenter range (cloud, cdn, services), one CIDR per line'],
  ['ipv4.txt', 'The same, IPv4 only'],
  ['ipv6.txt', 'The same, IPv6 only'],
  ['ranges.csv', 'Every range with provider, category, CIDR and source URL'],
  ['ranges.json', 'The same as JSON'],
  ['sources.json', 'Feed status, range counts and fetch times'],
];
const downloads = DOWNLOADS.filter(([f]) => fs.existsSync(path.join(DATA, f))).map(([file, about]) => ({
  file,
  about,
  bytes: fs.statSync(path.join(DATA, file)).size,
}));

const all = countFamilies(readList(path.join(DATA, 'all.txt')));
const lookup = {
  updated_at: meta.updated_at,
  datacenter_categories: meta.datacenter_categories,
  totals: {
    ranges: providers.reduce((n, p) => n + p.ipv4 + p.ipv6, 0),
    feeds: providers.filter((p) => p.file).length,
    datacenter_ipv4: all.ipv4,
    datacenter_ipv6: all.ipv6,
  },
  special: SPECIAL,
  categories,
  downloads,
  providers,
};
fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'data', 'lookup.json'), JSON.stringify(lookup));

for (const { file } of downloads) fs.copyFileSync(path.join(DATA, file), path.join(OUT, 'data', file));
for (const dir of ['providers', 'categories']) {
  fs.mkdirSync(path.join(OUT, 'data', dir), { recursive: true });
  for (const f of fs.readdirSync(path.join(DATA, dir)).sort()) {
    if (!f.endsWith('.txt')) continue;
    if (dir === 'providers' && NOT_REDISTRIBUTED.has(f.slice(0, -4))) continue;
    fs.copyFileSync(path.join(DATA, dir, f), path.join(OUT, 'data', dir, f));
  }
}

// A temporary package.json lets Node load the browser modules as ES modules.
const typeFile = path.join(OUT, 'package.json');
fs.writeFileSync(typeFile, '{"type":"module"}\n');
const { decodeProvider } = await import(pathToFileURL(path.join(OUT, 'decode.js')).href);
const { createMatcher } = await import(pathToFileURL(path.join(OUT, 'lib', 'matcher.js')).href);
const page = await import(pathToFileURL(path.join(OUT, 'verdict.js')).href);
fs.rmSync(typeFile);
for (const p of providers) {
  if (!p.file) continue;
  const back = decodeProvider(p);
  const orig = originals.get(p.id);
  if (back.length !== orig.length || back.some((c, k) => c !== orig[k])) {
    throw new Error(`lookup.json does not decode back to ${p.file}`);
  }
}
const browser = createMatcher(providers.filter((p) => p.file).map((p) => ({ id: p.id, category: p.category, cidrs: decodeProvider(p) })));
const node = require(path.join(ROOT, 'src', 'index.js'));
const probes = ['3.5.140.1', '8.8.8.8', '172.224.226.1', '2606:4700::1111', '185.220.101.1', '192.168.1.10', '::ffff:104.16.0.1', 'nope'];
for (const [id, cidrs] of originals) {
  for (const c of [cidrs[0], cidrs[cidrs.length - 1]]) {
    const r = ip.parseCidr(c);
    probes.push(ip.formatAddress(r.family, r.start), ip.formatAddress(r.family, r.end));
    if (r.start > 0n) probes.push(ip.formatAddress(r.family, r.start - 1n));
  }
}
for (const probe of probes) {
  const a = JSON.stringify(browser.lookup(probe));
  const b = JSON.stringify(node.lookup(probe));
  if (a !== b) throw new Error(`browser matcher disagrees on ${probe}: ${a} vs ${b}`);
}

// The page's own logic (site/verdict.js) on top of the matcher: the verdict
// must agree with isDatacenterIp(), the block it reports must contain the
// address, the bulk CSV must have one line per address, and the output shown
// under the Node.js snippet must be what console.log prints.
const util = require('node:util');
const lists = new Map(providers.filter((p) => p.file).map((p) => [p.id, decodeProvider(p)]));
const check = page.createChecker({ matcher: browser, lists, datacenterCategories: lookup.datacenter_categories, special: SPECIAL });
const checked = probes.map((probe) => check(probe));
for (const r of checked) {
  const expected = node.lookup(r.input);
  if ((r.verdict === 'datacenter') !== node.isDatacenterIp(r.input)) throw new Error(`page verdict disagrees with isDatacenterIp() on ${r.input}`);
  if (r.valid !== (expected !== null) || (r.verdict === 'none') !== (r.valid && expected.length === 0)) throw new Error(`page verdict is wrong for ${r.input}`);
  for (const m of r.matches) {
    const block = ip.parseCidr(m.cidr);
    const addr = ip.parseAddress(r.input);
    if (!block || block.family !== addr.family || addr.value < block.start || addr.value > block.end) throw new Error(`page reports ${m.cidr} for ${r.input}`);
    if (!originals.get(m.provider).includes(m.cidr)) throw new Error(`${m.cidr} is not in the ${m.provider} list`);
  }
  for (const value of [expected, node.isDatacenterIp(r.input)]) {
    if (page.inspect(value) !== util.inspect(value)) throw new Error(`page output differs from console.log for ${r.input}`);
  }
}
const csv = page.toCsv(checked).trimEnd().split('\n');
if (csv.length !== checked.length + 1 || csv.some((line) => line.split(',').length < 5)) throw new Error('bulk CSV is malformed');
const counts = page.countVerdicts(checked);
if (Object.values(counts).reduce((n, c) => n + c, 0) !== checked.length) throw new Error('bulk counts do not add up');

const kb = (f) => (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(1);
console.log(`_site built: ${lookup.totals.ranges} ranges from ${lookup.totals.feeds} feeds, data/lookup.json ${kb('data/lookup.json')} KB, ${probes.length} lookups and page verdicts checked against src/index.js`);
