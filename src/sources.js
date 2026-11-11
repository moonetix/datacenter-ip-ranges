'use strict';

// Every feed this project reads. Each one is published by the provider itself.
// parse() receives the response body and returns a list of CIDR strings.

const CATEGORIES = {
  cloud: 'Cloud and VPS hosting',
  cdn: 'CDN and edge networks',
  services: 'Provider services and automation',
  'privacy-relay': 'Privacy relay egress',
  tor: 'Tor exit nodes',
};

// Categories that count as datacenter traffic for isDatacenterIp() and data/all.txt.
const DATACENTER_CATEGORIES = ['cloud', 'cdn', 'services'];

function lines(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

// RFC 8805 geofeed: the first CSV column is the prefix.
function geofeed(text) {
  return lines(text).map((l) => l.split(',')[0].trim());
}

function json(text) {
  return JSON.parse(text);
}

const SOURCES = [
  {
    id: 'aws',
    name: 'Amazon Web Services',
    category: 'cloud',
    url: 'https://ip-ranges.amazonaws.com/ip-ranges.json',
    docs: 'https://docs.aws.amazon.com/vpc/latest/userguide/aws-ip-ranges.html',
    terms: 'Published by AWS for allow lists and filtering. No license is stated.',
    parse(text) {
      const j = json(text);
      return [
        ...j.prefixes.map((p) => p.ip_prefix),
        ...j.ipv6_prefixes.map((p) => p.ipv6_prefix),
      ];
    },
  },
  {
    id: 'google-cloud',
    name: 'Google Cloud',
    category: 'cloud',
    url: 'https://www.gstatic.com/ipranges/cloud.json',
    docs: 'https://support.google.com/a/answer/10026322',
    terms: 'Published by Google for allow lists and filtering. No license is stated.',
    parse(text) {
      return json(text).prefixes.map((p) => p.ipv4Prefix || p.ipv6Prefix);
    },
  },
  {
    id: 'google-services',
    name: 'Google services (excluding Google Cloud)',
    category: 'services',
    url: 'https://www.gstatic.com/ipranges/goog.json',
    docs: 'https://support.google.com/a/answer/10026322',
    terms: 'Published by Google for allow lists and filtering. No license is stated.',
    // Google documents goog.json minus cloud.json as the ranges of its own services.
    subtract: 'google-cloud',
    parse(text) {
      return json(text).prefixes.map((p) => p.ipv4Prefix || p.ipv6Prefix);
    },
  },
  {
    id: 'oracle-cloud',
    name: 'Oracle Cloud Infrastructure',
    category: 'cloud',
    url: 'https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json',
    docs: 'https://docs.oracle.com/en-us/iaas/Content/General/Concepts/addressranges.htm',
    terms: 'Published by Oracle in its public documentation. No license is stated.',
    parse(text) {
      return json(text).regions.flatMap((r) => r.cidrs.map((c) => c.cidr));
    },
  },
  {
    id: 'digitalocean',
    name: 'DigitalOcean',
    category: 'cloud',
    url: 'https://www.digitalocean.com/geo/google.csv',
    docs: 'https://docs.digitalocean.com/platform/',
    terms: 'Self-published RFC 8805 geofeed, linked from the DigitalOcean docs. No license is stated.',
    parse: geofeed,
  },
  {
    id: 'linode',
    name: 'Akamai Cloud (Linode)',
    category: 'cloud',
    url: 'https://ipgeo.akamai.com/linode-geofeed.csv',
    docs: 'https://rdap.arin.net/registry/ip/172.104.0.1',
    terms: 'Self-published RFC 8805 geofeed, referenced in the Linode network records at ARIN. No license is stated.',
    parse: geofeed,
  },
  {
    id: 'vultr',
    name: 'Vultr',
    category: 'cloud',
    url: 'https://geofeed.constant.com/',
    docs: 'https://rdap.arin.net/registry/ip/45.32.0.1',
    terms: 'Self-published RFC 8805 geofeed of AS20473, referenced in the Vultr network records at ARIN. No license is stated.',
    parse: geofeed,
  },
  {
    id: 'azure',
    name: 'Microsoft Azure',
    category: 'cloud',
    url: 'https://www.microsoft.com/en-us/download/details.aspx?id=56519',
    docs: 'https://learn.microsoft.com/en-us/azure/virtual-network/service-tags-overview',
    terms: 'Microsoft Download Center file. The Microsoft Terms of Use restrict reposting downloads, so this data is not committed. Fetch it locally with --include azure.',
    optIn: true,
    // The weekly file has a new name every week. The download page links the current one.
    async fetchText(get) {
      const page = await get(this.url);
      const m = page.match(/https:\/\/download\.microsoft\.com\/download\/[^"'\s]+\/ServiceTags_Public_\d{8}\.json/i);
      if (!m) throw new Error('no ServiceTags_Public link on the download page');
      return { text: await get(m[0]), resolvedUrl: m[0] };
    },
    parse(text) {
      const tag = json(text).values.find((v) => v.name === 'AzureCloud');
      if (!tag) throw new Error('AzureCloud tag not found');
      return tag.properties.addressPrefixes;
    },
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    category: 'cdn',
    url: 'https://www.cloudflare.com/ips-v4',
    urlV6: 'https://www.cloudflare.com/ips-v6',
    docs: 'https://www.cloudflare.com/ips/',
    terms: 'Published by Cloudflare for allow lists. No license is stated.',
    parse: lines,
  },
  {
    id: 'fastly',
    name: 'Fastly',
    category: 'cdn',
    url: 'https://api.fastly.com/public-ip-list',
    docs: 'https://www.fastly.com/documentation/reference/api/utils/public-ip-list/',
    terms: 'Public, unauthenticated Fastly API endpoint. No license is stated.',
    parse(text) {
      const j = json(text);
      return [...(j.addresses || []), ...(j.ipv6_addresses || [])];
    },
  },
  {
    id: 'github',
    name: 'GitHub (incl. Actions runners)',
    category: 'services',
    url: 'https://api.github.com/meta',
    docs: 'https://docs.github.com/en/rest/meta/meta',
    terms: 'GitHub REST API, covered by the GitHub Terms of Service (API Terms).',
    parse(text) {
      const j = json(text);
      const out = [];
      for (const [key, value] of Object.entries(j)) {
        if (!Array.isArray(value) || key === 'ssh_keys' || key === 'commit_signing_keys') continue;
        for (const v of value) if (typeof v === 'string' && /^[0-9a-fA-F:.]+\/\d+$/.test(v)) out.push(v);
      }
      return out;
    },
  },
  {
    id: 'icloud-private-relay',
    name: 'iCloud Private Relay egress',
    category: 'privacy-relay',
    url: 'https://mask-api.icloud.com/egress-ip-ranges.csv',
    docs: 'https://developer.apple.com/support/prepare-your-network-for-icloud-private-relay/',
    terms: 'Published by Apple for geolocation and server operators. No license is stated.',
    parse: geofeed,
  },
  {
    id: 'tor',
    name: 'Tor exit nodes',
    category: 'tor',
    url: 'https://check.torproject.org/torbulkexitlist',
    docs: 'https://metrics.torproject.org/about.html',
    terms: 'Tor Project data, CC0 1.0 (no copyright).',
    parse: lines,
  },
];

module.exports = { SOURCES, CATEGORIES, DATACENTER_CATEGORIES, lines, geofeed };
