import { createMatcher } from './lib/matcher.js';
import { parseAddress, parseCidr, formatAddress } from './lib/ip.js';
import { decodeProvider } from './decode.js';

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-US');
const form = $('form');
const input = $('ip');
const result = $('result');

let data = null;
let matcher = null;
const lists = new Map();
const blocks = new Map();

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function bytes(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

function blockFor(provider, address) {
  if (!blocks.has(provider)) {
    blocks.set(provider, lists.get(provider).map((text) => ({ text, ...parseCidr(text) })));
  }
  const hit = blocks.get(provider).find((r) => r.family === address.family && address.value >= r.start && address.value <= r.end);
  return hit ? hit.text : '';
}

function providerName(id) {
  const p = data.providers.find((x) => x.id === id);
  return p ? p.name : id;
}

function categoryLabel(id) {
  const c = data.categories.find((x) => x.id === id);
  return c ? c.label : id;
}

function show(raw) {
  const text = raw.trim();
  result.replaceChildren();
  if (!text) return;
  const matches = matcher.lookup(text);
  if (matches === null) {
    result.append(el('p', { class: 'verdict bad' }, 'Not a valid IPv4 or IPv6 address.'));
    return;
  }
  const address = parseAddress(text);
  const shown = formatAddress(address.family, address.value);
  const head = el('div', { class: 'verdict-row' });
  const addr = el('code', { class: 'addr' }, shown);
  const fam = el('span', { class: 'chip' }, address.family === 4 ? 'IPv4' : 'IPv6');
  const dc = matches.filter((m) => data.datacenter_categories.includes(m.category));
  let verdict;
  let note;
  if (!matches.length) {
    verdict = el('p', { class: 'verdict' }, 'Not listed');
    note = 'This address is not in any published provider range. Most home and mobile connections give this result.';
  } else if (dc.length) {
    verdict = el('p', { class: 'verdict hit' }, 'Datacenter range');
    note = 'isDatacenterIp() returns true for this address.';
  } else {
    const labels = [...new Set(matches.map((m) => categoryLabel(m.category)))].join(', ');
    verdict = el('p', { class: 'verdict warn' }, 'Listed: ' + labels);
    note = 'Not a datacenter category, so isDatacenterIp() returns false. lookup() returns the lists below.';
  }
  head.append(verdict, addr, fam);
  result.append(head);
  result.append(el('p', { class: 'small muted note' }, note));
  if (matches.length) {
    const body = el('tbody');
    for (const m of matches) {
      body.append(
        el(
          'tr',
          {},
          el('td', {}, providerName(m.provider), el('span', { class: 'sub mono' }, m.provider)),
          el('td', {}, categoryLabel(m.category), el('span', { class: 'sub mono' }, m.category)),
          el('td', { class: 'mono cidr' }, blockFor(m.provider, address)),
        ),
      );
    }
    result.append(
      el(
        'table',
        { class: 'matches' },
        el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Provider'), el('th', { scope: 'col' }, 'Category'), el('th', { scope: 'col' }, 'Block'))),
        body,
      ),
    );
  }
}

function syncUrl(value) {
  const url = new URL(location.href);
  if (value) url.searchParams.set('ip', value);
  else url.searchParams.delete('ip');
  history.replaceState(null, '', url);
}

function check(value) {
  show(value);
  syncUrl(value.trim());
}

function renderStats() {
  const day = data.updated_at.slice(0, 10);
  $('facts').replaceChildren(
    el('li', { class: 'chip' }, 'Updated ', el('time', { datetime: data.updated_at }, day)),
    el('li', { class: 'chip' }, fmt.format(data.totals.ranges) + ' ranges'),
    el('li', { class: 'chip' }, data.totals.feeds + ' provider feeds'),
    el('li', { class: 'chip' }, 'Rebuilt daily'),
  );

  const rows = [];
  for (const p of data.providers) {
    if (!p.file) {
      rows.push(
        el(
          'tr',
          { class: 'off' },
          el('td', {}, p.name, el('span', { class: 'sub' }, 'Not redistributed. Fetch it locally with --include ' + p.id + '.')),
          el('td', { class: 'num' }, '-'),
          el('td', { class: 'num' }, '-'),
        ),
      );
      continue;
    }
    rows.push(
      el(
        'tr',
        {},
        el('td', {}, el('a', { href: 'data/' + p.file }, p.name), el('span', { class: 'sub mono' }, p.category)),
        el('td', { class: 'num' }, fmt.format(p.ipv4)),
        el('td', { class: 'num' }, fmt.format(p.ipv6)),
      ),
    );
  }
  $('providers').replaceChildren(...rows);

  $('categories').replaceChildren(
    ...data.categories.map((c) =>
      el(
        'tr',
        {},
        el(
          'td',
          {},
          el('a', { href: 'data/' + c.file }, c.label),
          el('span', { class: 'sub' }, el('span', { class: 'mono' }, c.id), c.datacenter ? ' - in all.txt' : ' - separate list'),
        ),
        el('td', { class: 'num' }, fmt.format(c.ipv4)),
        el('td', { class: 'num' }, fmt.format(c.ipv6)),
      ),
    ),
  );

  $('downloads').replaceChildren(
    ...data.downloads.map((d) =>
      el(
        'li',
        {},
        el('a', { href: 'data/' + d.file, download: '' }, d.file),
        el('span', { class: 'size' }, bytes(d.bytes)),
        el('span', { class: 'sub' }, d.about),
      ),
    ),
  );
}

async function start() {
  try {
    const res = await fetch('data/lookup.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
    const loaded = [];
    for (const p of data.providers) {
      if (!p.file) continue;
      const cidrs = decodeProvider(p);
      lists.set(p.id, cidrs);
      loaded.push({ id: p.id, category: p.category, cidrs });
    }
    matcher = createMatcher(loaded);
  } catch (err) {
    $('facts').replaceChildren(el('li', { class: 'chip' }, 'Could not load the ranges'));
    result.append(el('p', { class: 'verdict bad' }, 'The range data did not load. Reload the page to try again.'));
    return;
  }
  renderStats();
  input.disabled = false;
  $('go').disabled = false;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    check(input.value);
  });
  for (const b of document.querySelectorAll('.ex')) {
    b.addEventListener('click', () => {
      input.value = b.dataset.ip;
      check(b.dataset.ip);
    });
  }
  const initial = new URLSearchParams(location.search).get('ip');
  if (initial) {
    input.value = initial;
    show(initial);
  }
}

start();
