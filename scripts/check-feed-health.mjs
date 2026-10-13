#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateFeed } from './validate-feed.mjs';

export function checkFeedHealth(feed, now = Date.now(), maxAgeHours = 6) {
  const problems = [];
  try { validateFeed(feed); } catch (error) { return { ok: false, problems: [error.message] }; }
  const age = now - Date.parse(feed.generatedAt);
  if (age < -5 * 60 * 1000) problems.push('Feed timestamp is in the future');
  if (age > maxAgeHours * 3600000) problems.push(`Feed is ${(age / 3600000).toFixed(1)}h old (limit ${maxAgeHours}h)`);
  if (!feed.health) problems.push('Feed has no source verification report');
  else {
    const expected = { sources: ['frequentmiler', 'awardwallet', 'livelo', 'esfera'], directories: ['fm-directory', 'livelo-directory'] };
    for (const group of ['sources', 'directories']) {
      for (const id of expected[group]) if (!feed.health[group]?.[id]) problems.push(`Missing verification: ${group}/${id}`);
      for (const [id, source] of Object.entries(feed.health[group] || {})) {
        if (source.status !== 'ok') problems.push(`${group}/${id}: ${source.status}${source.error ? ` — ${source.error}` : ''}${source.undated ? ` — ${source.undated} undated` : ''}`);
        const checkedAge = now - Date.parse(source.checkedAt);
        if (checkedAge > maxAgeHours * 3600000 || checkedAge < -5 * 60000) problems.push(`${group}/${id}: verification timestamp outside freshness limit`);
        if (group === 'sources' && source.status === 'ok' && (!source.lastSuccessAt || now - Date.parse(source.lastSuccessAt) > maxAgeHours * 3600000)) problems.push(`${group}/${id}: last successful verification is stale or missing`);
      }
    }
    if (feed.health.carriedForwardRoutes) problems.push(`${feed.health.carriedForwardRoutes} routes carried forward from previous collection`);
    if (feed.health.status !== 'ok' && !problems.length) problems.push('Collection is degraded');
  }
  return { ok: problems.length === 0, problems };
}

async function main(input) {
  if (!input) throw new Error('Usage: node scripts/check-feed-health.mjs <feed.json or https URL>');
  const feed = input.startsWith('https://')
    ? await fetch(input, { cache: 'no-cache', signal: AbortSignal.timeout(20000) }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    : JSON.parse(readFileSync(input, 'utf8'));
  const result = checkFeedHealth(feed);
  console.log(result.ok ? 'Collection healthy' : result.problems.join('\n'));
  process.exitCode = result.ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
