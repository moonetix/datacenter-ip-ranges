#!/usr/bin/env node
// Keeps one open GitHub issue per automation topic: opens it, updates it in
// place, or closes it once the problem is gone. Node 22, no dependencies.
//
// The topic is stored as an HTML comment at the end of the issue body, so a
// human can rename the issue or change its labels without breaking the match.
//
//   node scripts/github-issue.mjs upsert --topic T --title "..." --body-file F [--comment "..."]
//   node scripts/github-issue.mjs close  --topic T [--comment "..."]
//
// Needs GITHUB_TOKEN and GITHUB_REPOSITORY (both set inside GitHub Actions).
// Without them, or with --dry-run, it prints what it would do and calls nothing.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const LABEL = { name: 'automation', color: 'ededed', description: 'Opened by a scheduled workflow' };

const marker = (topic) => `<!-- automation-topic: ${topic} -->`;

export function withMarker(body, topic) {
  return `${body.trimEnd()}\n\n${marker(topic)}\n`;
}

export function hasTopic(issue, topic) {
  return !issue.pull_request && typeof issue.body === 'string' && issue.body.includes(marker(topic));
}

export function githubClient({ token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPOSITORY, api = process.env.GITHUB_API_URL || 'https://api.github.com', fetchImpl = fetch } = {}) {
  if (!token || !repo) return null;
  return async function request(method, path, body) {
    const res = await fetchImpl(`${api}/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': `${repo} automation`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) throw new Error(`GitHub API ${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
}

// Returns the newest issue carrying the topic marker, or null.
export async function findIssue(request, topic, state = 'open') {
  for (let page = 1; page <= 10; page++) {
    const list = await request('GET', `/issues?state=${state}&per_page=100&page=${page}&sort=created&direction=desc`);
    if (!list || list.length === 0) return null;
    const hit = list.find((issue) => hasTopic(issue, topic));
    if (hit) return hit;
    if (list.length < 100) return null;
  }
  return null;
}

async function ensureLabel(request) {
  const found = await request('GET', `/labels/${LABEL.name}`);
  if (!found) await request('POST', '/labels', LABEL);
}

// Opens the topic's issue, or updates the open one. The title change gets a
// comment so watchers are notified; an unchanged issue is left alone.
export async function upsertIssue(request, { topic, title, body, comment, log = console.log }) {
  const fullBody = withMarker(body, topic);
  if (!request) {
    log(`[dry run] would open or update the issue for topic "${topic}"\nTitle: ${title}\nLabels: ${LABEL.name}\n\n${fullBody}${comment ? `\nComment: ${comment}\n` : ''}`);
    return { action: 'dry-run' };
  }
  const open = await findIssue(request, topic);
  if (!open) {
    await ensureLabel(request);
    const created = await request('POST', '/issues', { title, body: fullBody, labels: [LABEL.name] });
    log(`Opened issue #${created.number}: ${title}`);
    return { action: 'opened', number: created.number };
  }
  const titleChanged = open.title !== title;
  if (!titleChanged && open.body === fullBody && !comment) {
    log(`Issue #${open.number} is already up to date.`);
    return { action: 'unchanged', number: open.number };
  }
  await request('PATCH', `/issues/${open.number}`, { title, body: fullBody });
  const note = comment || (titleChanged ? `Updated: ${title}` : '');
  if (note) await request('POST', `/issues/${open.number}/comments`, { body: note });
  log(`Updated issue #${open.number}: ${title}`);
  return { action: 'updated', number: open.number };
}

export async function closeIssue(request, { topic, comment, log = console.log }) {
  if (!request) {
    log(`[dry run] would close the open issue for topic "${topic}", if there is one${comment ? `, with the comment: ${comment}` : ''}`);
    return { action: 'dry-run' };
  }
  const open = await findIssue(request, topic);
  if (!open) {
    log(`No open issue for topic "${topic}".`);
    return { action: 'none' };
  }
  if (comment) await request('POST', `/issues/${open.number}/comments`, { body: comment });
  await request('PATCH', `/issues/${open.number}`, { state: 'closed', state_reason: 'completed' });
  log(`Closed issue #${open.number}.`);
  return { action: 'closed', number: open.number };
}

export function runUrl(env = process.env) {
  return env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : '(local run)';
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;
  if (!args.topic || !['upsert', 'close'].includes(command)) {
    console.error('usage: github-issue.mjs upsert|close --topic T [--title T --body-file F] [--comment C] [--dry-run]');
    process.exit(2);
  }
  const request = args.dryRun ? null : githubClient();
  if (command === 'close') {
    await closeIssue(request, { topic: args.topic, comment: args.comment });
    return;
  }
  if (!args.title || !args['body-file']) {
    console.error('upsert needs --title and --body-file');
    process.exit(2);
  }
  const body = await readFile(args['body-file'], 'utf8');
  await upsertIssue(request, { topic: args.topic, title: args.title, body, comment: args.comment });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
