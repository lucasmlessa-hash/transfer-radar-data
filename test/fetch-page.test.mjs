import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPage } from '../src/fetch-page.mjs';

test('transient HTTP failures recover with a bounded delay', async () => {
  const waits = [];
  let calls = 0;
  const body = await fetchPage('https://example.org/', {
    fetcher: async () => ++calls < 3 ? new Response('', { status: 403 }) : new Response('verified listing'),
    wait: async ms => waits.push(ms),
  });
  assert.equal(body, 'verified listing');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1500, 3000]);
});

test('persistent HTTP failure stays a failure after three attempts', async () => {
  let calls = 0;
  await assert.rejects(fetchPage('https://example.org/', {
    fetcher: async () => { calls++; return new Response('', { status: 403 }); }, wait: async () => {},
  }), /HTTP 403/);
  assert.equal(calls, 3);
});

test('network errors and unusable listing bodies retry without accepting empty evidence', async () => {
  let calls = 0;
  assert.equal(await fetchPage('https://example.org/', {
    fetcher: async () => { if (++calls === 1) throw new TypeError('fetch failed'); return new Response(calls === 2 ? '' : 'partners'); },
    ok: body => body === 'partners', wait: async () => {},
  }), 'partners');
});

test('permanent missing pages fail immediately', async () => {
  let calls = 0;
  await assert.rejects(fetchPage('https://example.org/', {
    fetcher: async () => { calls++; return new Response('', { status: 404 }); }, wait: async () => {},
  }), /HTTP 404/);
  assert.equal(calls, 1);
});
