// These are route-specific estimates reported by Frequent Miler. They are not
// official bank SLAs, and an Unknown/absent cell never verifies a saved value.
import * as cheerio from 'cheerio';
import { resolveBank, resolvePartner } from '../aliases.mjs';
import { DIRECTORY_SOURCES } from './partner-directory.mjs';

export const TRANSFER_TIME_SOURCE = DIRECTORY_SOURCES.find(({ id }) => id === 'fm-directory');

// Extract outer parentheses without losing nested qualifications such as
// "~12-24 hours (slower over weekend)". Malformed cells fail closed.
function parentheses(text) {
  const groups = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(' && depth++ === 0) start = i + 1;
    if (text[i] === ')') {
      if (depth === 0) return null;
      if (--depth === 0) groups.push(text.slice(start, i).trim());
    }
  }
  return depth === 0 ? groups : null;
}

function parseCell(cell) {
  if (!/\b\d[\d,.]*k?\s*(?:to|:)\s*\d[\d,.]*k?\b/i.test(cell)) return { time: null, reason: 'unparseable' };
  const groups = parentheses(cell);
  if (!groups) return { time: null, reason: 'unparseable' };
  const raw = groups.at(-1);
  if (!raw) return { time: null, reason: 'no-time' };
  if (/^(?:unknown|n\/?a)$/i.test(raw)) return { time: null, reason: 'unknown' };
  if (/^instant$/i.test(raw)) return { time: 'INSTANT' };
  const match = raw.match(/^(~)?\s*(\d+(?:\.\d+)?)(?:\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?))?\s*(business days?|days?|hours?|hrs?|minutes?|mins?)(\s*\(slower over weekend\))?$/i);
  if (!match) return { time: null, reason: 'unparseable' };
  const [, approximate = '', low, high, rawUnit, qualifier = ''] = match;
  if (Number(low) <= 0 || (high && Number(high) < Number(low))) return { time: null, reason: 'unparseable' };
  const baseUnit = /^business/i.test(rawUnit) ? 'BUSINESS DAY' : /^d/i.test(rawUnit) ? 'DAY' : /^h/i.test(rawUnit) ? 'HOUR' : 'MINUTE';
  const unit = `${baseUnit}${high || Number(low) !== 1 ? 'S' : ''}`;
  return { time: `${approximate}${low}${high ? `–${high}` : ''} ${unit}${qualifier ? ` ${qualifier.trim().toUpperCase()}` : ''}` };
}

/**
 * Header-mapped FM table observations. Only a time explicitly present in a
 * bank/program cell can populate times[bank][code]; no airline-wide fallback.
 * "via Qatar/BA" rows retain the source's end-to-end estimate, never a time
 * inferred from the intermediate program. Tables marked Indirect are ignored.
 */
export function parseFmTransferTimes(html) {
  const $ = cheerio.load(html);
  const routes = new Map();
  let tableCount = 0;
  $('table.tablepress').each((_, table) => {
    const headers = $(table).find('thead th').map((__, el) => $(el).text().trim()).get();
    if (!/^Rewards Program$/i.test(headers[0] ?? '') || headers.some((h) => /Indirect/i.test(h))) return;
    const banks = headers.map((h) => /Transfer Ratio.*transfer time/is.test(h)
      ? resolveBank(h.replace(/transfer ratio[\s\S]*$/i, '').trim()) : null);
    if (!banks.some((b) => TRANSFER_TIME_SOURCE.banks.includes(b))) return;
    tableCount += 1;
    $(table).find('tbody tr').each((__, row) => {
      const cells = $(row).find('td').map((___, el) => $(el).text().replace(/\s+/g, ' ').trim()).get();
      const code = resolvePartner(cells[0] ?? '');
      if (!code) return;
      banks.forEach((bank, i) => {
        const cell = cells[i];
        if (!TRANSFER_TIME_SOURCE.banks.includes(bank) || !cell) return;
        const key = `${bank}/${code}`;
        if (!routes.has(key)) routes.set(key, { bank, code, observations: new Map() });
        routes.get(key).observations.set(cell, { cell, ...parseCell(cell) });
      });
    });
  });
  const times = {}, unparsed = [], conflicts = [];
  for (const { bank, code, observations } of routes.values()) {
    const values = new Set([...observations.values()].map(({ time }) => time));
    if (values.size > 1) {
      conflicts.push({ bank, code, values: [...values], cells: [...observations.keys()] });
      continue;
    }
    const time = [...values][0];
    if (time) (times[bank] ??= {})[code] = time;
    else for (const observation of observations.values()) unparsed.push({ bank, code, ...observation });
  }
  return { times, unparsed, conflicts, tableCount, observedRoutes: routes.size };
}
