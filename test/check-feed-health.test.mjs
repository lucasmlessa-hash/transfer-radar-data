import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFeedHealth } from '../scripts/check-feed-health.mjs';
const now = Date.parse('2026-10-13T12:00:00Z');
const feed = {version: 1, generatedAt: '2026-10-13T11:00:00Z', routes: [], health: {status:'ok', sources: Object.fromEntries(['frequentmiler','awardwallet','livelo','esfera'].map(id => [id,{status:'ok',checkedAt:'2026-10-13T11:00:00Z',lastSuccessAt:'2026-10-13T11:00:00Z',entries:0}])), directories:Object.fromEntries(['fm-directory','livelo-directory'].map(id => [id,{status:'ok',checkedAt:'2026-10-13T11:00:00Z'}])), carriedForwardRoutes:0}};
test('healthy empty recognized sources pass within freshness limit', () => assert.equal(checkFeedHealth(feed, now).ok, true));
test('old feed, future timestamp, missing report and partial source cannot pass', () => {
  for (const value of [
    {...feed,generatedAt:'2026-10-11T00:00:00Z'},
    {...feed,generatedAt:'2026-10-14T00:00:00Z'},
    {version:1,generatedAt:feed.generatedAt,routes:[]},
    {...feed,health:{...feed.health,status:'degraded',sources:{livelo:{status:'failed',checkedAt:feed.generatedAt}}}},
  ]) assert.equal(checkFeedHealth(value,now).ok,false);
});

test('daily collection stays fresh through its next run, but not after a missed day plus grace', () => {
  assert.equal(checkFeedHealth(feed, Date.parse('2026-10-14T12:00:00Z')).ok, true);
  assert.equal(checkFeedHealth(feed, Date.parse('2026-10-14T23:01:00Z')).ok, false);
});

test('missing sources and old per-source verification cannot hide behind a fresh build time', () => {
  for (const value of [
    {...feed,health:{...feed.health,sources:{}}},
    {...feed,health:{...feed.health,directories:{}}},
    {...feed,generatedAt:'2026-99-99T99:99:99Z'},
    {...feed,health:{...feed.health,sources:{...feed.health.sources,livelo:{...feed.health.sources.livelo,checkedAt:'2026-10-01T11:00:00Z'}}}},
  ]) assert.equal(checkFeedHealth(value,now).ok,false);
});
