import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertIssue, closeIssue, findIssue, withMarker } from '../scripts/github-issue.mjs';

// In-memory stand-in for the few GitHub REST endpoints the helper uses.
function fakeGitHub({ issues = [], labels = [] } = {}) {
  const state = { issues: structuredClone(issues), labels: new Set(labels), comments: [], calls: [] };
  const request = async (method, path, body) => {
    state.calls.push(`${method} ${path.split('?')[0]}`);
    const url = new URL(path, 'https://x');
    if (method === 'GET' && url.pathname === '/issues') {
      const want = url.searchParams.get('state');
      return state.issues.filter((i) => want === 'all' || i.state === want).reverse();
    }
    if (method === 'GET' && url.pathname.startsWith('/labels/')) {
      return state.labels.has(url.pathname.slice(8)) ? { name: url.pathname.slice(8) } : null;
    }
    if (method === 'POST' && url.pathname === '/labels') return state.labels.add(body.name) && body;
    if (method === 'POST' && url.pathname === '/issues') {
      const issue = { number: state.issues.length + 1, state: 'open', ...body };
      state.issues.push(issue);
      return issue;
    }
    const m = /^\/issues\/(\d+)(\/comments)?$/.exec(url.pathname);
    if (m && method === 'PATCH') return Object.assign(state.issues[m[1] - 1], body);
    if (m && method === 'POST') return state.comments.push({ issue: Number(m[1]), body: body.body });
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { request, state };
}

const quiet = () => {};

test('opens one issue, then updates it instead of opening a second', async () => {
  const gh = fakeGitHub();
  const first = await upsertIssue(gh.request, { topic: 't', title: 'Broken links: 2', body: 'a\nb', log: quiet });
  assert.equal(first.action, 'opened');
  assert.ok(gh.state.labels.has('automation'), 'label is created when missing');
  const second = await upsertIssue(gh.request, { topic: 't', title: 'Broken links: 3', body: 'a\nb\nc', log: quiet });
  assert.equal(second.action, 'updated');
  assert.equal(gh.state.issues.length, 1);
  assert.equal(gh.state.issues[0].title, 'Broken links: 3');
  assert.equal(gh.state.comments.length, 1, 'a title change notifies watchers');
});

test('leaves an identical issue alone', async () => {
  const gh = fakeGitHub({ issues: [{ number: 1, state: 'open', title: 'X', body: withMarker('same', 't') }], labels: ['automation'] });
  const r = await upsertIssue(gh.request, { topic: 't', title: 'X', body: 'same', log: quiet });
  assert.equal(r.action, 'unchanged');
  assert.deepEqual(gh.state.calls.filter((c) => !c.startsWith('GET')), []);
});

test('matches by topic marker, not by title, and ignores other topics and pull requests', async () => {
  const gh = fakeGitHub({
    issues: [
      { number: 1, state: 'open', title: 'Renamed by a human', body: withMarker('x', 'mine') },
      { number: 2, state: 'open', title: 'Other', body: withMarker('x', 'other') },
      { number: 3, state: 'open', title: 'PR', body: withMarker('x', 'mine'), pull_request: {} },
    ],
  });
  assert.equal((await findIssue(gh.request, 'mine')).number, 1);
  assert.equal(await findIssue(gh.request, 'missing'), null);
});

test('closes the open issue with a comment, and does nothing when there is none', async () => {
  const gh = fakeGitHub({ issues: [{ number: 1, state: 'open', title: 'X', body: withMarker('x', 't') }] });
  assert.equal((await closeIssue(gh.request, { topic: 't', comment: 'fixed', log: quiet })).action, 'closed');
  assert.equal(gh.state.issues[0].state, 'closed');
  assert.equal((await closeIssue(gh.request, { topic: 't', log: quiet })).action, 'none');
});

test('a closed issue is not reused: a new problem opens a fresh issue', async () => {
  const gh = fakeGitHub({ issues: [{ number: 1, state: 'closed', title: 'X', body: withMarker('x', 't') }], labels: ['automation'] });
  const r = await upsertIssue(gh.request, { topic: 't', title: 'X again', body: 'y', log: quiet });
  assert.equal(r.action, 'opened');
  assert.equal(r.number, 2);
});

test('dry run prints the would-be issue and calls nothing', async () => {
  const lines = [];
  const r = await upsertIssue(null, { topic: 't', title: 'T', body: 'B', log: (l) => lines.push(l) });
  assert.equal(r.action, 'dry-run');
  assert.match(lines[0], /Title: T/);
  assert.match(lines[0], /automation-topic: t/);
});
