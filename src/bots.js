'use strict';

// Crawlers whose operators publish the addresses they crawl from. Each entry
// lists the user-agent tokens the crawler sends and the provider lists (IDs in
// sources.js, category "crawler") its requests must come from.
//
// php/DatacenterIp.php and python/datacenter_ip.py carry the same table; a test
// fails if they drift apart.
const BOTS = [
  {
    id: 'google',
    name: 'Google',
    tokens: ['Googlebot', 'Storebot-Google', 'Google-InspectionTool', 'GoogleOther', 'Google-CloudVertexBot',
      'AdsBot-Google', 'Mediapartners-Google', 'APIs-Google', 'FeedFetcher-Google', 'Google-Read-Aloud',
      'Google-Site-Verification', 'GoogleProducer', 'Google-Safety'],
    providers: ['googlebot', 'google-special-crawlers', 'google-user-fetchers', 'google-user-fetchers-google'],
  },
  { id: 'bing', name: 'Bing', tokens: ['bingbot', 'adidxbot', 'BingPreview', 'MicrosoftPreview'], providers: ['bingbot'] },
  { id: 'applebot', name: 'Applebot', tokens: ['Applebot'], providers: ['applebot'] },
  { id: 'duckduckbot', name: 'DuckDuckBot', tokens: ['DuckDuckBot'], providers: ['duckduckbot'] },
  { id: 'gptbot', name: 'OpenAI GPTBot', tokens: ['GPTBot'], providers: ['gptbot'] },
  { id: 'oai-searchbot', name: 'OpenAI OAI-SearchBot', tokens: ['OAI-SearchBot'], providers: ['oai-searchbot'] },
  { id: 'chatgpt-user', name: 'OpenAI ChatGPT-User', tokens: ['ChatGPT-User'], providers: ['chatgpt-user'] },
  { id: 'perplexitybot', name: 'PerplexityBot', tokens: ['PerplexityBot'], providers: ['perplexitybot'] },
  { id: 'perplexity-user', name: 'Perplexity-User', tokens: ['Perplexity-User'], providers: ['perplexity-user'] },
  { id: 'mistralai-user', name: 'MistralAI-User', tokens: ['MistralAI-User'], providers: ['mistralai-user'] },
  { id: 'ccbot', name: 'Common Crawl CCBot', tokens: ['CCBot'], providers: ['ccbot'] },
  { id: 'ahrefsbot', name: 'Ahrefs', tokens: ['AhrefsBot', 'AhrefsSiteAudit'], providers: ['ahrefsbot'] },
];

// The bot a user-agent string claims to be, or null. Tokens match
// case-insensitively anywhere in the string, the way crawler operators
// document them.
function claimedBot(userAgent) {
  if (typeof userAgent !== 'string' || userAgent === '') return null;
  const ua = userAgent.toLowerCase();
  return BOTS.find((b) => b.tokens.some((t) => ua.includes(t.toLowerCase()))) || null;
}

// verify(userAgent, ip, matcher): matcher is a matcher over the crawler lists.
//   null                                   the user agent claims none of the known crawlers
//   { bot, name, verified: true, provider } the address is in that crawler's published ranges
//   { bot, name, verified: false, provider: null }
//                                          the user agent claims a crawler but the address is
//                                          not one of its published ranges (or is not an IP)
function verify(userAgent, ip, matcher) {
  const bot = claimedBot(userAgent);
  if (!bot) return null;
  const hit = (matcher.lookup(ip) || []).find((m) => bot.providers.includes(m.provider));
  return { bot: bot.id, name: bot.name, verified: Boolean(hit), provider: hit ? hit.provider : null };
}

module.exports = { BOTS, claimedBot, verify };
