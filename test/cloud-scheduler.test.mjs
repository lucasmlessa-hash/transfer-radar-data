import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { runScheduled } from '../cloud-scheduler/worker.mjs';

const morning = Date.parse('2026-10-14T09:00:00Z');
const recovery = Date.parse('2026-10-14T10:00:00Z');
const verification = Date.parse('2026-10-14T11:00:00Z');
const env = { GITHUB_TOKEN: 'test-only-not-a-secret' };
const healthy = () => ({ generatedAt: '2026-10-14T09:05:00Z', routes: [], health: {
  status: 'ok', carriedForwardRoutes: 0,
  sources: Object.fromEntries(['frequentmiler', 'awardwallet', 'livelo', 'esfera'].map(id => [id, {
    status: 'ok', checkedAt: '2026-10-14T09:04:00Z', lastSuccessAt: '2026-10-14T09:04:00Z', entries: 0,
  }])),
  directories: Object.fromEntries(['fm-directory', 'livelo-directory'].map(id => [id, {
    status: 'ok', checkedAt: '2026-10-14T09:04:00Z',
  }])),
} });

test('daily tick dispatches only the ratio workflow, which publishes the feed through workflow_run', async () => {
  const calls = [];
  const result = await runScheduled(morning, env, async (url, options) => {
    calls.push({ url, options });
    return options.method === 'POST' ? new Response(null, { status: 204 })
      : Response.json({ workflow_runs: [] });
  });
  assert.equal(result.status, 'dispatched');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api.github.com/repos/lucasmlessa-hash/transfer-radar-data/actions/workflows/refresh-br-ratios.yml/dispatches');
  assert.deepEqual(JSON.parse(calls[1].options.body), { ref: 'main' });
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-only-not-a-secret');
  assert.equal(calls[1].options.redirect, 'manual');
});

test('edge-compatible fetch dispatches without following redirects', async () => {
  const result = await runScheduled(morning, env, async (url, options) => {
    // Workers rejects redirect:error before making any network request.
    if (!['manual', 'follow'].includes(options.redirect)) throw new TypeError('Invalid redirect value');
    assert.equal(options.redirect, 'manual');
    return options.method === 'POST' ? new Response(null, { status: 204 })
      : Response.json({ workflow_runs: [] });
  });
  assert.equal(result.status, 'dispatched');
});

test('redirects abort both lookup and dispatch without forwarding credentials', async () => {
  for (const redirectedCall of [1, 2]) {
    let calls = 0;
    await assert.rejects(runScheduled(morning, env, async (url, options) => {
      calls++;
      assert.equal(options.redirect, 'manual');
      return calls === redirectedCall
        ? new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/' } })
        : Response.json({ workflow_runs: [] });
    }), /HTTP 302/);
    assert.equal(calls, redirectedCall);
  }
});

test('active runs and successful runs from this daily window prevent another dispatch', async () => {
  for (const run of [
    { status: 'in_progress', created_at: '2026-10-14T08:59:00Z', head_branch: 'main' },
    { status: 'completed', conclusion: 'success', created_at: '2026-10-14T09:00:00Z', head_branch: 'main' },
  ]) {
    let calls = 0;
    const result = await runScheduled(morning, env, async () => { calls++; return Response.json({ workflow_runs: [run] }); });
    assert.equal(result.status, 'already-running-or-completed');
    assert.equal(calls, 1);
  }
});

test('yesterday success and today failure do not suppress the daily attempt', async () => {
  for (const run of [
    { status: 'completed', conclusion: 'success', created_at: '2026-10-13T09:00:00Z', head_branch: 'main' },
    { status: 'completed', conclusion: 'failure', created_at: '2026-10-14T09:00:00Z', head_branch: 'main' },
  ]) {
    const result = await runScheduled(morning, env, async (url, options) => options.method === 'POST'
      ? Response.json({ workflow_run_id: 123 }) : Response.json({ workflow_runs: [run] }));
    assert.equal(result.status, 'dispatched');
  }
});

test('missing credentials and rejected GitHub requests fail explicitly without leaking tokens', async () => {
  await assert.rejects(runScheduled(morning, {}, () => { throw Error('must not fetch'); }), /GITHUB_TOKEN/);
  await assert.rejects(runScheduled(morning, env, async () => new Response('test-only-not-a-secret', { status: 401 })), error => {
    assert.match(error.message, /401/);
    assert.doesNotMatch(error.message, /test-only/);
    return true;
  });
});

test('verification checks the daily ratios job and published feed without leaking credentials or collecting again', async () => {
  let calls = 0;
  const result = await runScheduled(verification, env, async (url, options) => {
    calls++;
    assert.notEqual(options.method, 'POST');
    if (url.startsWith('https://api.github.com/')) return Response.json({ workflow_runs: [{
      status: 'completed', conclusion: 'success', head_branch: 'main',
      created_at: '2026-10-14T09:00:00Z', updated_at: '2026-10-14T09:04:00Z',
    }] });
    assert.equal(url, 'https://lucasmlessa-hash.github.io/transfer-radar-data/feed.json');
    assert.equal(options.headers?.Authorization, undefined);
    assert.equal(options.cache, 'no-store');
    return Response.json(healthy());
  });
  assert.equal(result.status, 'verified');
  assert.equal(calls, 2);
});

test('a fresh feed cannot hide a failed daily ratio check', async () => {
  await assert.rejects(runScheduled(verification, env, async (url) => url.startsWith('https://api.github.com/')
    ? Response.json({ workflow_runs: [{ status: 'completed', conclusion: 'failure', head_branch: 'main',
      created_at: '2026-10-14T09:00:00Z', updated_at: '2026-10-14T09:04:00Z' }] })
    : Response.json(healthy())), /ratio verification incomplete/i);
});

test('a feed published before the latest verified ratio changes is not verified', async () => {
  const feed = healthy();
  feed.generatedAt = '2026-10-14T09:10:00Z';
  await assert.rejects(runScheduled(verification, env, async url => url.startsWith('https://api.github.com/')
    ? Response.json({ workflow_runs: [
      { status: 'completed', conclusion: 'success', head_branch: 'main', created_at: '2026-10-14T09:17:00Z', updated_at: '2026-10-14T09:25:00Z' },
      { status: 'completed', conclusion: 'success', head_branch: 'main', created_at: '2026-10-14T09:00:00Z', updated_at: '2026-10-14T09:04:00Z' },
    ] }) : Response.json(feed)), /verification failed/i);
});

test('dispatch acceptance cannot hide an old, partial, incomplete, or future published feed', async () => {
  const cases = [healthy(), healthy(), healthy(), healthy(), healthy()];
  cases[0].generatedAt = '2026-10-13T09:05:00Z';
  cases[1].health.sources.livelo.status = 'failed';
  delete cases[2].health.directories['fm-directory'];
  cases[3].generatedAt = '2026-10-15T09:05:00Z';
  cases[4].health.sources.livelo.lastSuccessAt = '2026-10-13T09:05:00Z';
  for (const feed of cases) await assert.rejects(runScheduled(verification, env, async (url) => url.startsWith('https://api.github.com/')
    ? Response.json({ workflow_runs: [{ status: 'completed', conclusion: 'success', head_branch: 'main',
      created_at: '2026-10-14T09:00:00Z', updated_at: '2026-10-14T09:04:00Z' }] })
    : Response.json(feed)), /verification failed/i);
});

test('public requests cannot manually dispatch workflows', async () => {
  const response = await worker.fetch(new Request('https://scheduler.example/run', { method: 'POST' }), env);
  assert.equal(response.status, 404);
});

test('unexpected cron hours fail rather than dispatching extra jobs', async () => {
  await assert.rejects(runScheduled(Date.parse('2026-10-14T12:00:00Z'), env, () => { throw Error('must not fetch'); }), /schedule/i);
});

const successfulRun = { status: 'completed', conclusion: 'success', head_branch: 'main',
  created_at: '2026-10-14T09:00:00Z', updated_at: '2026-10-14T09:04:00Z' };

test('recovery hour does not collect again when publication is healthy', async () => {
  const result = await runScheduled(recovery, env, async (url, options) => {
    assert.notEqual(options.method, 'POST');
    return url.startsWith('https://api.github.com/') ? Response.json({ workflow_runs: [successfulRun] }) : Response.json(healthy());
  });
  assert.equal(result.status, 'verified');
});

test('recovery hour retries failed references or partial publication once without claiming success', async () => {
  for (const failedRatios of [true, false]) {
    let dispatches = 0;
    const feed = healthy();
    feed.health.status = 'degraded';
    feed.health.directories['livelo-directory'].status = 'failed';
    const result = await runScheduled(recovery, env, async (url, options) => {
      if (options.method === 'POST') { dispatches++; return new Response(null, { status: 204 }); }
      return url.startsWith('https://api.github.com/')
        ? Response.json({ workflow_runs: [{ ...successfulRun, conclusion: failedRatios ? 'failure' : 'success' }] }) : Response.json(feed);
    });
    assert.equal(result.status, 'recovery-dispatched');
    assert.equal(dispatches, 1);
  }
});

test('duplicate recovery tick cannot redispatch an already started recovery even if it failed', async () => {
  for (const status of ['queued', 'in_progress', 'completed']) {
    const result = await runScheduled(recovery + 5 * 60000, env, async (url, options) => {
      assert.notEqual(options.method, 'POST');
      return Response.json({ workflow_runs: [{ ...successfulRun, status, conclusion: 'failure', created_at: '2026-10-14T10:00:10Z' }] });
    });
    assert.equal(result.status, 'recovery-already-attempted');
  }
});

test('a newer failed reference run is not hidden by an earlier success', async () => {
  await assert.rejects(runScheduled(verification, env, async url => url.startsWith('https://api.github.com/')
    ? Response.json({ workflow_runs: [successfulRun, { ...successfulRun, conclusion: 'failure', created_at: '2026-10-14T10:00:00Z', updated_at: '2026-10-14T10:04:00Z' }] })
    : Response.json({ ...healthy(), generatedAt: '2026-10-14T10:05:00Z' })), /ratio verification incomplete/i);
});

test('a failed rerun of an older workflow cannot be hidden by a newer successful workflow', async () => {
  const feed = JSON.parse(JSON.stringify(healthy()).replaceAll('09:04:00Z', '09:35:00Z').replaceAll('09:05:00Z', '09:35:00Z'));
  await assert.rejects(runScheduled(verification, env, async url => url.startsWith('https://api.github.com/')
    ? Response.json({ workflow_runs: [
      { ...successfulRun, created_at: '2026-10-14T09:30:00Z', updated_at: '2026-10-14T09:34:00Z' },
      { ...successfulRun, run_attempt: 2, run_started_at: '2026-10-14T10:00:00Z', updated_at: '2026-10-14T10:04:00Z', conclusion: 'failure' },
    ] }) : Response.json(feed)), /ratio verification incomplete/i);
});
