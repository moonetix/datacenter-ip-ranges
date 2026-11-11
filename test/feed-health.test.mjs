import { test } from 'node:test';
import assert from 'node:assert/strict';
import { persistentlyStale, staleBody } from '../scripts/feed-health.mjs';

const feed = (id, status, note) => ({ id, name: id.toUpperCase(), status, note, url: `https://${id}.example/ranges` });

test('a feed is reported only when it was also stale before this run', () => {
  const previous = { sources: [feed('aws', 'ok'), feed('github', 'stale', 'HTTP 403'), feed('azure', 'not included (opt-in)')] };
  const current = { sources: [feed('aws', 'stale', 'timeout'), feed('github', 'stale', 'HTTP 403'), feed('azure', 'not included (opt-in)')] };
  assert.deepEqual(persistentlyStale(current, previous).map((s) => s.id), ['github']);
});

test('a feed that recovered is not reported, and opt-in feeds never are', () => {
  const previous = { sources: [feed('tor', 'stale')] };
  const current = { sources: [feed('tor', 'ok'), feed('azure', 'not included (opt-in)')] };
  assert.deepEqual(persistentlyStale(current, previous), []);
});

test('a feed new in this run that is already failing is reported', () => {
  assert.deepEqual(persistentlyStale({ sources: [feed('new', 'unavailable')] }, { sources: [] }).map((s) => s.id), ['new']);
});

test('issue body names each feed with its error and source', () => {
  const body = staleBody([feed('github', 'stale', 'fetch or parse failed: HTTP 403')], 'https://github.com/o/r/actions/runs/9');
  assert.match(body, /\| GITHUB \(`github`\) \| stale \| fetch or parse failed: HTTP 403 \| https:\/\/github\.example\/ranges \|/);
  assert.match(body, /Last run: https:\/\/github\.com\/o\/r\/actions\/runs\/9/);
});
