'use strict';

// verifyBot() and the crawler table, in Node, PHP and Python.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ip = require('../src/ip');
const { verifyBot, claimedBot, BOTS, lookup, readList, DEFAULT_DATA_DIR } = require('../src/index');
const { SOURCES } = require('../src/sources');

const ROOT = path.join(__dirname, '..');
const meta = JSON.parse(fs.readFileSync(path.join(DEFAULT_DATA_DIR, 'sources.json'), 'utf8'));

function firstAddress(provider) {
  const src = meta.sources.find((s) => s.id === provider);
  const r = ip.parseCidr(readList(path.join(DEFAULT_DATA_DIR, src.file))[0]);
  return ip.formatAddress(r.family, r.start);
}

test('every bot points at crawler sources, and every crawler source has a bot', () => {
  const crawlers = SOURCES.filter((s) => s.category === 'crawler').map((s) => s.id);
  const used = BOTS.flatMap((b) => b.providers);
  assert.deepEqual([...used].sort(), [...crawlers].sort());
  assert.equal(new Set(BOTS.map((b) => b.id)).size, BOTS.length);
});

test('claimedBot reads the documented user-agent tokens', () => {
  const cases = {
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)': 'google',
    'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)': 'google',
    'AdsBot-Google (+http://www.google.com/adsbot.html)': 'google',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)': 'bing',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)': 'applebot',
    'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)': 'duckduckbot',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)': 'gptbot',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot': 'oai-searchbot',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot': 'chatgpt-user',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)': 'perplexitybot',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)': 'perplexity-user',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)': 'mistralai-user',
    'CCBot/2.0 (https://commoncrawl.org/faq/)': 'ccbot',
    'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)': 'ahrefsbot',
    'mozilla/5.0 (compatible; GOOGLEBOT/2.1)': 'google',
  };
  for (const [ua, id] of Object.entries(cases)) assert.equal(claimedBot(ua)?.id, id, ua);
  for (const ua of ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', '', null, undefined, 42]) {
    assert.equal(claimedBot(ua), null, String(ua));
  }
});

test('verifyBot accepts published addresses and rejects everything else', () => {
  for (const bot of BOTS) {
    const ua = `Mozilla/5.0 (compatible; ${bot.tokens[0]}/1.0)`;
    for (const provider of bot.providers) {
      const r = verifyBot(ua, firstAddress(provider));
      assert.equal(r.verified, true, `${bot.id} from ${provider}`);
      assert.equal(r.bot, bot.id);
      assert.ok(bot.providers.includes(r.provider));
    }
    assert.deepEqual(verifyBot(ua, '192.0.2.1'), { bot: bot.id, name: bot.name, verified: false, provider: null });
    assert.equal(verifyBot(ua, 'not an ip').verified, false);
  }
  // A real crawler address with the wrong user agent is still a false claim.
  assert.equal(verifyBot('Mozilla/5.0 (compatible; bingbot/2.0)', firstAddress('gptbot')).verified, false);
  assert.equal(verifyBot('Mozilla/5.0 Firefox/130.0', firstAddress('googlebot')), null);
  assert.equal(verifyBot('GPTBot/1.0', firstAddress('gptbot'), { dataDir: DEFAULT_DATA_DIR }).verified, true);
});

test('crawler ranges show up in lookup()', () => {
  assert.ok(lookup(firstAddress('bingbot')).some((m) => m.provider === 'bingbot' && m.category === 'crawler'));
});

function samples() {
  const out = ['192.0.2.1', '::ffff:104.16.0.1', '2606:4700::1', '127.0.0.1', 'nope'];
  for (const f of ['all.txt', 'categories/tor.txt', 'categories/privacy-relay.txt', 'categories/crawler.txt']) {
    readList(path.join(DEFAULT_DATA_DIR, f)).filter((_, i) => i % 23 === 0).forEach((c) => {
      const r = ip.parseCidr(c);
      const max = r.family === 4 ? ip.V4_MAX : ip.V6_MAX;
      for (const v of [r.start - 1n, r.start, r.end, r.end + 1n]) if (v >= 0n && v <= max) out.push(ip.formatAddress(r.family, v));
    });
  }
  return out;
}

function botCases() {
  const cases = [];
  for (const bot of BOTS) {
    for (const p of bot.providers) cases.push([`x ${bot.tokens.at(-1)} y`, firstAddress(p)]);
    cases.push([bot.tokens[0], '198.51.100.1']);
  }
  cases.push(['Mozilla/5.0', '8.8.8.8'], ['', '1.1.1.1']);
  return cases;
}

const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
test('Python helper agrees with Node', { skip: python.status !== 0 && 'python3 not installed' }, () => {
  const ips = samples();
  const cases = botCases();
  const script = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'python'))})`,
    'import datacenter_ip as d',
    'q = json.load(sys.stdin)',
    'print(json.dumps({"bots": d.BOTS, "lookup": [d.lookup(i) for i in q["ips"]], "dc": [d.is_datacenter_ip(i) for i in q["ips"]], "verify": [d.verify_bot(u, i) for u, i in q["cases"]]}))',
  ].join('\n');
  const r = spawnSync('python3', ['-I', '-c', script], { input: JSON.stringify({ ips, cases }), encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.bots, BOTS);
  const { isDatacenterIp } = require('../src/index');
  ips.forEach((a, i) => {
    assert.deepEqual(out.lookup[i], lookup(a), `lookup ${a}`);
    assert.equal(out.dc[i], isDatacenterIp(a), `isDatacenterIp ${a}`);
  });
  cases.forEach(([u, a], i) => assert.deepEqual(out.verify[i], verifyBot(u, a), `verifyBot ${u} ${a}`));
});

test('Python unit tests pass', { skip: python.status !== 0 && 'python3 not installed' }, () => {
  const r = spawnSync('python3', ['-I', path.join(ROOT, 'python/test_datacenter_ip.py')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

const php = spawnSync('php', ['-v'], { encoding: 'utf8' });
test('PHP verifyBot agrees with Node', { skip: php.status !== 0 && 'php not installed' }, () => {
  const cases = botCases();
  const code = `require ${JSON.stringify(path.join(ROOT, 'php/DatacenterIp.php'))};
$q = json_decode(stream_get_contents(STDIN), true);
echo json_encode(['bots' => DatacenterIp::BOTS, 'verify' => array_map(fn($c) => verify_bot($c[0], $c[1]), $q)]);`;
  const r = spawnSync('php', ['-r', code], { input: JSON.stringify(cases), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.bots, BOTS);
  cases.forEach(([u, a], i) => assert.deepEqual(out.verify[i], verifyBot(u, a), `verify_bot ${u} ${a}`));
});
