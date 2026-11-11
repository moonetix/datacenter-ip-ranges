#!/usr/bin/env node
// After the daily update: lists feeds that kept old data, and keeps the
// "Range update" issue in step with that list.
//
//   node scripts/feed-health.mjs --previous old-sources.json [--issue]
//
// A feed is reported when it was not fresh in this run and also not fresh in
// the previous committed data/sources.json, so one failed fetch does not open
// an issue. Without --issue the would-be issue is printed.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubClient, upsertIssue, closeIssue, runUrl } from './github-issue.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TOPIC = 'range-update';

const notFresh = (s) => s.status !== 'ok' && !String(s.status).startsWith('not included');

// Feeds that are stale now and were already stale before this run.
export function persistentlyStale(current, previous) {
  const before = new Map((previous?.sources ?? []).map((s) => [s.id, s]));
  return current.sources.filter((s) => notFresh(s) && (!before.has(s.id) || notFresh(before.get(s.id))));
}

export function staleBody(stale, run) {
  return [
    'These feeds failed on the last two updates, so their ranges in `data/` are being kept from an earlier fetch. The lists are still served, but they will drift from what the provider publishes.',
    '',
    '| Feed | Status | Detail | Source |',
    '| --- | --- | --- | --- |',
    ...stale.map((s) => `| ${s.name} (\`${s.id}\`) | ${s.status} | ${String(s.note ?? '').replaceAll('|', '/')} | ${s.url} |`),
    '',
    'Check whether the provider moved or changed the feed, then update `src/sources.js`. This issue closes itself once every feed is fresh again.',
    '',
    `Last run: ${run}`,
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const prevPath = args[args.indexOf('--previous') + 1];
  const current = JSON.parse(readFileSync(join(ROOT, 'data', 'sources.json'), 'utf8'));
  const previous = args.includes('--previous') ? JSON.parse(readFileSync(prevPath, 'utf8')) : null;
  const stale = persistentlyStale(current, previous);
  const request = args.includes('--issue') ? githubClient() : null;
  if (args.includes('--issue') && !request) throw new Error('--issue needs GITHUB_TOKEN and GITHUB_REPOSITORY');

  for (const s of current.sources.filter(notFresh)) console.log(`not fresh: ${s.id} (${s.status}) ${s.note ?? ''}`);
  if (stale.length) {
    const title = `Range update: ${stale.length} feed${stale.length === 1 ? '' : 's'} serving stale data`;
    await upsertIssue(request, { topic: TOPIC, title, body: staleBody(stale, runUrl()) });
  } else {
    await closeIssue(request, { topic: TOPIC, comment: 'No feed has kept old data for two runs in a row now.' });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
