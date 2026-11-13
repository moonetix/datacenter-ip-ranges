import { createMatcher } from './lib/matcher.js';
import { decodeProvider } from './decode.js';
import { VERDICTS, ORDER, MAX_BULK, classify, createChecker, splitList, countVerdicts, toCsv, inspect } from './verdict.js';

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-US');
const SVG = 'http://www.w3.org/2000/svg';
const LOAD_ERROR = 'The range data did not load. Reload the page to try again.';
const SAMPLE = ['3.5.140.1', '8.8.8.8', '2606:4700::1111', '172.224.226.1', '185.220.101.1', '192.168.1.10', '203.0.113.300'];

const form = $('form');
const input = $('ip');
const result = $('result');
const bulkForm = $('bulk-form');
const bulkIn = $('bulk-in');
const bulkOut = $('bulk-out');
const timers = new WeakMap();

let data = null;
let matcher = null;
let check = null;
let sayTimer = 0;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function icon(id, cls = 'ic') {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', '#' + id);
  svg.append(use);
  return svg;
}

function say(text) {
  const live = $('live');
  live.textContent = '';
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => {
    live.textContent = text;
  }, 60);
}

function bytes(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

function clip(text, max = 64) {
  return text.length > max ? text.slice(0, max) + '...' : text;
}

function providerName(id) {
  const p = data.providers.find((x) => x.id === id);
  return p ? p.name : id;
}

function categoryLabel(id) {
  const c = data.categories.find((x) => x.id === id);
  return c ? c.label : id;
}

function emptyState(iconId, text, extra = '') {
  return el('p', { class: 'empty' + extra }, icon(iconId), el('span', {}, text));
}

function fact(term, ...value) {
  return el('div', { class: 'fact' }, el('dt', {}, term), el('dd', {}, ...value));
}

function renderResult(r, example) {
  const v = VERDICTS[r.verdict];
  const title = el('div', { class: 'v-title' }, el('p', { class: 'v-label' }, v.label));
  if (r.primary) {
    title.append(el('p', { class: 'v-sub' }, el('strong', {}, providerName(r.primary.provider)), el('span', { class: 'v-cat' }, categoryLabel(r.primary.category))));
  }
  const addr = el('div', { class: 'v-addr' }, el('code', { class: 'addr' }, r.valid ? r.address : clip(r.input)));
  if (r.valid) addr.append(el('span', { class: 'chip' }, r.family === 4 ? 'IPv4' : 'IPv6'));
  if (example) addr.append(el('span', { class: 'chip ghost' }, 'Example'));
  const box = el(
    'div',
    { class: 'verdict t-' + v.tone },
    el('div', { class: 'v-head' }, el('span', { class: 'v-icon' }, icon(v.icon)), title, addr),
    el('p', { class: 'v-mean' }, r.meaning),
  );
  if (r.matches.length) {
    const lists = el('div', { class: 'matches' });
    for (const m of r.matches) {
      lists.append(
        el(
          'dl',
          { class: 'match' },
          fact('Provider', providerName(m.provider), el('code', { class: 'sub' }, m.provider)),
          fact('Category', categoryLabel(m.category), el('code', { class: 'sub' }, m.category)),
          fact('Matching range', el('code', { class: 'cidr' }, m.cidr)),
        ),
      );
    }
    box.append(lists);
  }
  box.append(
    el(
      'dl',
      { class: 'v-api' },
      el('div', {}, el('dt', {}, el('code', {}, 'isDatacenterIp()')), el('dd', {}, el('code', {}, inspect(r.verdict === 'datacenter')))),
      el('div', {}, el('dt', {}, el('code', {}, 'lookup()')), el('dd', {}, el('code', {}, inspect(r.valid ? r.matches : null)))),
    ),
  );
  result.replaceChildren(box);
}

function show(raw, example = false) {
  const text = raw.trim();
  if (!text) {
    result.replaceChildren(emptyState('i-search', 'Enter an address or pick an example to see the verdict.'));
    return null;
  }
  const r = check(text);
  renderResult(r, example);
  return r;
}

function syncUrl(value) {
  const url = new URL(location.href);
  if (value) url.searchParams.set('ip', value);
  else url.searchParams.delete('ip');
  history.replaceState(null, '', url);
}

function lookupNow(value) {
  const r = show(value);
  syncUrl(value.trim());
  if (!r) return;
  const v = VERDICTS[r.verdict];
  say(r.valid ? `${r.address}: ${v.label}${r.primary ? ', ' + providerName(r.primary.provider) : ''}` : v.label);
}

function bar(total, max) {
  const fill = el('span', { class: 'bar-fill' });
  fill.style.width = ((total / max) * 100).toFixed(1) + '%';
  return el('span', { class: 'bar', 'aria-hidden': 'true' }, fill);
}

function renderStats() {
  const day = data.updated_at.slice(0, 10);
  $('facts').replaceChildren(
    el('li', { class: 'chip' }, 'Updated ', el('time', { datetime: data.updated_at }, day)),
    el('li', { class: 'chip' }, fmt.format(data.totals.ranges) + ' ranges'),
    el('li', { class: 'chip' }, data.totals.feeds + ' provider feeds'),
    el('li', { class: 'chip' }, 'Rebuilt daily'),
  );

  const max = Math.max(1, ...data.providers.map((p) => p.ipv4 + p.ipv6));
  const rows = [];
  for (const p of data.providers) {
    if (!p.file) {
      rows.push(
        el(
          'tr',
          { class: 'off' },
          el('td', {}, p.name, el('span', { class: 'sub' }, 'Not redistributed. Fetch it locally with --include ' + p.id + '.')),
          el('td', { class: 'barcol' }, '-'),
          el('td', { class: 'num' }, '-'),
          el('td', { class: 'num' }, '-'),
        ),
      );
      continue;
    }
    const total = p.ipv4 + p.ipv6;
    rows.push(
      el(
        'tr',
        {},
        el(
          'td',
          {},
          el('a', { href: 'data/' + p.file }, p.name),
          el('span', { class: 'sub mono' }, p.category),
          el('span', { class: 'bar-m' }, bar(total, max), el('span', { class: 'bar-n' }, fmt.format(total) + ' ranges')),
        ),
        el('td', { class: 'barcol' }, el('span', { class: 'bar-row' }, bar(total, max), el('span', { class: 'bar-n' }, fmt.format(total)))),
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

function renderExamples() {
  for (const b of document.querySelectorAll('.ex')) {
    const v = VERDICTS[check(b.dataset.ip).verdict];
    b.prepend(icon(v.icon, 'ic sm'));
    b.append(el('span', { class: 'sr-only' }, ', ' + v.label));
    b.addEventListener('click', () => {
      input.value = b.dataset.ip;
      lookupNow(b.dataset.ip);
    });
  }
}

function renderHeroPreview() {
  const box = $('hero-preview');
  if (!box) return;
  box.textContent = '';
  for (const ip of ['3.5.140.1', '185.220.101.1', '172.224.226.1', '192.168.1.10']) {
    const r = check(ip);
    const sub = r.primary ? providerName(r.primary.provider) : r.special ? 'Private or reserved address' : 'Not on any list';
    box.append(el('div', { class: 'pv-row' }, el('span', { class: 'pv-ip' }, ip), badge(r.verdict), el('span', { class: 'pv-sub' }, sub)));
  }
}

function renderSnippetOutput() {
  const lines = [];
  for (const m of $('code-node').textContent.matchAll(/console\.log\((isDatacenterIp|lookup)\('([^']+)'\)\)/g)) {
    const matches = matcher.lookup(m[2]);
    lines.push(inspect(m[1] === 'lookup' ? matches : classify(matches, data.datacenter_categories) === 'datacenter'));
  }
  $('out-node').textContent = lines.join('\n');
}

function badge(verdict) {
  const v = VERDICTS[verdict];
  return el('span', { class: 'badge t-' + v.tone }, icon(v.icon, 'ic sm'), v.short);
}

function renderBulk(results, dropped, total) {
  const counts = countVerdicts(results);
  const list = el('ul', { class: 'counts', 'aria-label': 'Addresses per verdict' });
  const spoken = [];
  for (const id of ORDER) {
    if (id === 'other' && !counts.other) continue;
    const v = VERDICTS[id];
    list.append(el('li', { class: 'count t-' + v.tone + (counts[id] ? '' : ' zero') }, icon(v.icon), el('strong', {}, fmt.format(counts[id])), el('span', {}, v.short)));
    if (counts[id]) spoken.push(`${counts[id]} ${v.short.toLowerCase()}`);
  }

  const csvBtn = el('button', { type: 'button', class: 'btn csv' }, icon('i-copy'), el('span', { class: 'copy-label' }, 'Copy as CSV'));
  const fallback = el('div', { class: 'csv-fallback', hidden: '' });
  csvBtn.addEventListener('click', async () => {
    const csv = toCsv(results);
    const ok = await writeClipboard(csv);
    flash(csvBtn, ok);
    if (ok) {
      say('CSV copied to the clipboard');
      return;
    }
    const area = el('textarea', { id: 'csv-text', readonly: '', rows: '6', spellcheck: 'false' });
    area.value = csv;
    fallback.replaceChildren(el('label', { for: 'csv-text' }, 'Copying is blocked in this browser. Select the CSV below and copy it.'), area);
    fallback.hidden = false;
    area.focus();
    area.select();
    say('Copying is blocked in this browser. The CSV is selected in a text box.');
  });

  const body = el('tbody', { role: 'rowgroup' });
  for (const r of results) {
    const where = el('td', { class: 'where', role: 'cell' });
    if (r.matches.length) {
      for (const m of r.matches) where.append(el('span', { class: 'hit' }, providerName(m.provider), el('code', { class: 'cidr' }, m.cidr)));
    } else {
      where.append(el('span', { class: 'muted' }, r.valid ? (r.special ? 'Private or reserved' : 'No list') : 'Not an IP address'));
    }
    body.append(
      el(
        'tr',
        { role: 'row' },
        el('td', { class: 'ip-cell', role: 'cell' }, el('code', {}, r.valid ? r.address : clip(r.input, 45))),
        el('td', { role: 'cell' }, badge(r.verdict)),
        where,
      ),
    );
  }
  const heads = ['Address', 'Verdict', 'Provider and range'].map((h) => el('th', { scope: 'col', role: 'columnheader' }, h));
  const table = el('table', { class: 'bulk-table', role: 'table' }, el('thead', { role: 'rowgroup' }, el('tr', { role: 'row' }, ...heads)), body);

  const summary = `Checked ${fmt.format(results.length)} ${results.length === 1 ? 'address' : 'addresses'}.`;
  const note = dropped ? ` The list had ${fmt.format(total)}; only the first ${fmt.format(MAX_BULK)} were checked.` : '';
  bulkOut.replaceChildren(
    el('div', { class: 'bulk-top' }, el('p', { class: 'bulk-sum' + (dropped ? ' warn' : '') }, summary + note), csvBtn),
    list,
    fallback,
    el('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': 'Bulk check results' }, table),
  );
  say(`${summary}${note} ${spoken.join(', ')}.`);
}

function runBulk() {
  const { items, total, dropped } = splitList(bulkIn.value);
  if (!items.length) {
    bulkOut.replaceChildren(emptyState('i-bad', 'Paste at least one address, or try the sample.', ' warn'));
    say('Paste at least one address.');
    return;
  }
  renderBulk(items.map((item) => check(item)), dropped, total);
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    return false;
  }
}

function flash(btn, ok) {
  const label = btn.querySelector('.copy-label');
  if (!btn.dataset.label) btn.dataset.label = label.textContent;
  label.textContent = ok ? 'Copied' : 'Copy failed';
  btn.classList.toggle('done', ok);
  btn.classList.toggle('fail', !ok);
  btn.querySelector('use').setAttribute('href', ok ? '#i-check' : '#i-bad');
  clearTimeout(timers.get(btn));
  timers.set(
    btn,
    setTimeout(() => {
      label.textContent = btn.dataset.label;
      btn.classList.remove('done', 'fail');
      btn.querySelector('use').setAttribute('href', '#i-copy');
    }, 2000),
  );
}

function initCopy() {
  for (const btn of document.querySelectorAll('.copy[data-copy]')) {
    btn.addEventListener('click', async () => {
      const code = $(btn.dataset.copy);
      const ok = await writeClipboard(code.textContent);
      flash(btn, ok);
      if (ok) {
        say('Copied to the clipboard');
        return;
      }
      const range = document.createRange();
      range.selectNodeContents(code);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      say('Copying is blocked in this browser. The code is selected, copy it with your keyboard.');
    });
  }
}

function initTabs() {
  const tabs = [...document.querySelectorAll('[role=tab]')];
  const select = (tab, focus) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) tab.focus();
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab, false));
    tab.addEventListener('keydown', (e) => {
      const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      select(tabs[(to + tabs.length) % tabs.length], true);
    });
  });
}

function fail() {
  $('facts').replaceChildren(el('li', { class: 'chip' }, 'Could not load the ranges'));
  result.replaceChildren(emptyState('i-bad', LOAD_ERROR, ' bad'));
  bulkOut.replaceChildren(emptyState('i-bad', LOAD_ERROR, ' bad'));
  $('providers').replaceChildren(el('tr', {}, el('td', { colspan: '4', class: 'muted' }, 'No data loaded.')));
  $('categories').replaceChildren(el('tr', {}, el('td', { colspan: '3', class: 'muted' }, 'No data loaded.')));
  $('downloads').replaceChildren(el('li', { class: 'muted' }, 'No data loaded.'));
  $('out-node').textContent = 'Not available: the range data did not load.';
}

async function start() {
  initTabs();
  initCopy();
  $('bulk-max').textContent = fmt.format(MAX_BULK);
  try {
    const res = await fetch('data/lookup.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
    const lists = new Map();
    const loaded = [];
    for (const p of data.providers) {
      if (!p.file) continue;
      const cidrs = decodeProvider(p);
      lists.set(p.id, cidrs);
      loaded.push({ id: p.id, category: p.category, cidrs });
    }
    matcher = createMatcher(loaded);
    check = createChecker({ matcher, lists, datacenterCategories: data.datacenter_categories, special: data.special });
  } catch (err) {
    fail();
    return;
  }
  renderStats();
  renderExamples();
  renderHeroPreview();
  renderSnippetOutput();
  for (const id of ['ip', 'go', 'bulk-in', 'bulk-go', 'bulk-sample', 'bulk-clear']) $(id).disabled = false;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    lookupNow(input.value);
  });
  bulkForm.addEventListener('submit', (e) => {
    e.preventDefault();
    runBulk();
  });
  $('bulk-sample').addEventListener('click', () => {
    bulkIn.value = SAMPLE.join('\n');
    runBulk();
  });
  $('bulk-clear').addEventListener('click', () => {
    bulkIn.value = '';
    bulkOut.replaceChildren(emptyState('i-list', 'Results appear here: a count per verdict and one row per address.'));
    bulkIn.focus();
  });
  const initial = new URLSearchParams(location.search).get('ip');
  if (initial) {
    input.value = initial;
    show(initial);
  } else {
    show(document.querySelector('.ex').dataset.ip, true);
  }
}

start();
