import { parseAddress, parseCidr, formatAddress } from './lib/ip.js';

export const MAX_BULK = 500;

export const ORDER = ['datacenter', 'tor', 'relay', 'other', 'none', 'invalid'];

export const VERDICTS = {
  datacenter: { label: 'Datacenter range', short: 'Datacenter', csv: 'datacenter', icon: 'i-server', tone: 'warn' },
  tor: { label: 'Tor exit node', short: 'Tor exit', csv: 'tor', icon: 'i-tor', tone: 'warn' },
  relay: { label: 'Privacy relay', short: 'Privacy relay', csv: 'privacy-relay', icon: 'i-relay', tone: 'good' },
  other: { label: 'Listed', short: 'Listed', csv: 'listed', icon: 'i-list', tone: 'none' },
  none: { label: 'Not listed', short: 'Not listed', csv: 'not-listed', icon: 'i-none', tone: 'none' },
  invalid: { label: 'Not a valid IP address', short: 'Invalid', csv: 'invalid', icon: 'i-bad', tone: 'bad' },
};

const MEANING = {
  cloud: 'On a rewards site, a sign-up, offer click or reward claim from a cloud server is rarely a real phone or home user, so it is a good reason to hold the reward for review.',
  cdn: 'On a rewards site this usually means your app is reading the address of a CDN or proxy instead of the visitor, or the request was sent by code running on the edge network.',
  services: 'On a rewards site this is usually automation such as a crawler, a link fetcher or a CI runner, not a person completing an offer.',
  tor: 'Tor exits carry real people and automated tools behind shared addresses, so on a rewards site extra verification fits better than an outright block.',
  'privacy-relay': 'This is usually a Safari user on iCloud+ behind an address shared with many others, so treat it like a mobile carrier address and do not block on it alone.',
  other: 'This address is on a published list that is not a datacenter category, so decide per list how your rewards site should treat it.',
  none: 'Most home and mobile connections give this result, but it does not prove a real user, because residential proxies and most commercial VPNs are not in these lists.',
  special: 'This is a private or reserved address that is never listed, so if it shows up in your logs your app is reading a proxy or LAN address instead of the visitor\'s public one.',
  invalid: 'Enter one IPv4 or IPv6 address without a port, for example 3.5.140.1 or 2606:4700::1111.',
};

const ALSO = {
  tor: 'It is also a Tor exit node.',
  'privacy-relay': 'It is also listed as iCloud Private Relay egress, so a real Safari user may be behind it.',
};

export function classify(matches, datacenterCategories) {
  if (matches === null) return 'invalid';
  if (matches.length === 0) return 'none';
  if (matches.some((m) => datacenterCategories.includes(m.category))) return 'datacenter';
  if (matches.some((m) => m.category === 'tor')) return 'tor';
  if (matches.some((m) => m.category === 'privacy-relay')) return 'relay';
  return 'other';
}

export function primaryMatch(verdict, matches, datacenterCategories) {
  if (!matches || !matches.length) return null;
  if (verdict === 'datacenter') return matches.find((m) => datacenterCategories.includes(m.category));
  if (verdict === 'tor') return matches.find((m) => m.category === 'tor');
  if (verdict === 'relay') return matches.find((m) => m.category === 'privacy-relay');
  return matches[0];
}

export function createSpecial(special) {
  const ranges = [];
  for (const family of [4, 6]) {
    for (const text of (special && special[family]) || []) {
      const r = parseCidr(text);
      if (r) ranges.push(r);
    }
  }
  return (address) => ranges.some((r) => r.family === address.family && address.value >= r.start && address.value <= r.end);
}

export function meaning(verdict, matches, primary, special) {
  if (verdict === 'invalid') return MEANING.invalid;
  if (verdict === 'none') return special ? MEANING.special : MEANING.none;
  if (verdict === 'other') return MEANING.other;
  const text = MEANING[primary.category] || MEANING.other;
  if (verdict !== 'datacenter') return text;
  const extra = Object.keys(ALSO).filter((c) => matches.some((m) => m.category === c)).map((c) => ALSO[c]);
  return [text, ...extra].join(' ');
}

export function splitList(text, max = MAX_BULK) {
  const all = String(text).split(/[\s,;]+/).filter(Boolean);
  return { items: all.slice(0, max), total: all.length, dropped: Math.max(0, all.length - max) };
}

export function createChecker({ matcher, lists, datacenterCategories, special }) {
  const isSpecial = createSpecial(special);
  const tables = new Map();

  function tableFor(provider) {
    if (!tables.has(provider)) {
      const table = { 4: [], 6: [] };
      for (const text of lists.get(provider) || []) {
        const r = parseCidr(text);
        table[r.family].push({ text, start: r.start, end: r.end });
      }
      tables.set(provider, table);
    }
    return tables.get(provider);
  }

  function blockFor(provider, address) {
    const rows = tableFor(provider)[address.family];
    let lo = 0;
    let hi = rows.length - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (rows[mid].start <= address.value) {
        hit = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return hit !== -1 && address.value <= rows[hit].end ? rows[hit].text : '';
  }

  return function check(raw) {
    const input = String(raw).trim();
    const matches = matcher.lookup(input);
    const verdict = classify(matches, datacenterCategories);
    if (verdict === 'invalid') {
      return { input, valid: false, verdict, address: '', family: 0, matches: [], primary: null, special: false, meaning: MEANING.invalid };
    }
    const parsed = parseAddress(input);
    const found = matches.map((m) => ({ provider: m.provider, category: m.category, cidr: blockFor(m.provider, parsed) }));
    const primary = primaryMatch(verdict, found, datacenterCategories);
    const special = verdict === 'none' && isSpecial(parsed);
    return {
      input,
      valid: true,
      verdict,
      address: formatAddress(parsed.family, parsed.value),
      family: parsed.family,
      matches: found,
      primary,
      special,
      meaning: meaning(verdict, found, primary, special),
    };
  };
}

export function countVerdicts(results) {
  const counts = Object.fromEntries(ORDER.map((v) => [v, 0]));
  for (const r of results) counts[r.verdict]++;
  return counts;
}

function csvCell(value) {
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(results) {
  const lines = ['ip,verdict,provider,category,cidr'];
  for (const r of results) {
    lines.push(
      [
        r.valid ? r.address : r.input,
        VERDICTS[r.verdict].csv,
        r.matches.map((m) => m.provider).join('|'),
        r.matches.map((m) => m.category).join('|'),
        r.matches.map((m) => m.cidr).join('|'),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

export function inspect(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (!value.length) return '[]';
  const items = value.map((m) => `{ provider: '${m.provider}', category: '${m.category}' }`);
  const width = items.reduce((n, i) => n + i.length, 0) + 2 * items.length + 11;
  if (width <= 80) return `[ ${items.join(', ')} ]`;
  return `[\n${items.map((i) => '  ' + i).join(',\n')}\n]`;
}
