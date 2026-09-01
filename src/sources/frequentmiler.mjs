import * as cheerio from 'cheerio';
import { recordHistory } from '../history.mjs';

// DOM verified live on 2026-07-24 against
// https://frequentmiler.com/current-point-transfer-bonuses/ (HTTP 200).
//
// The page renders bonus data via TablePress. Two tables matter:
//   - `#tablepress-33-no-5` — the CURRENT/upcoming bonus table (what we want),
//     preceded by an <h3>Current and Upcoming Transfer Bonuses</h3> heading.
//   - `#tablepress-33-no-6` — a ~460-row HISTORICAL archive. Must NOT be
//     parsed as current bonuses.
// TablePress ids are regenerated whenever the page is re-saved in the CMS,
// so we don't hardcode "no-5". Instead, findBonusTable() below walks a
// fallback chain from the most specific signal to the loosest.
function findBonusTable($) {
  // (a) The table immediately following the "Current and Upcoming" heading.
  const heading = $('h1,h2,h3,h4,h5,h6')
    .filter((_, el) => /current\s+and\s+upcoming/i.test($(el).text()))
    .first();
  if (heading.length) {
    const table = heading.nextAll('table').first();
    if (table.length) return table;
  }

  // (b) Else, the first TablePress table on the page (current bonuses are
  // listed before the historical archive in document order).
  const firstTablepress = $('table.tablepress').first();
  if (firstTablepress.length) return firstTablepress;

  // (c) Else, any table whose header row mentions the bonus-details column.
  const byHeader = $('table').filter(
    (_, el) => $(el).find('th, tr:first-child td').text().includes('Transfer Bonus Details'),
  );
  if (byHeader.length) return byHeader.first();

  return null;
}

// The archive table (`#tablepress-33-no-6` today) sits under an
// <h3>Expired Transfer Bonuses</h3> heading and carries ~463 rows in the same
// 4-column shape. Same reasoning as findBonusTable: ids get regenerated on
// re-save, so locate by heading first, then by structure — of the TablePress
// tables that are NOT the current-bonus table, the archive is by far the
// largest (463 rows vs 6). If neither signal fires we return null and simply
// publish no history: degraded, never wrong.
function findHistoryTable($, currentTable) {
  const currentEl = currentTable?.[0];

  const heading = $('h1,h2,h3,h4,h5,h6')
    .filter((_, el) => /expired|past\s+transfer|previous\s+transfer/i.test($(el).text()))
    .first();
  if (heading.length) {
    const table = heading.nextAll('table').first();
    // guard: if the heading somehow leads back to the current-bonus table,
    // fall through rather than ingest live bonuses as "history"
    if (table.length && table[0] !== currentEl) return table;
  }

  let best = null;
  let bestRows = 0;
  $('table.tablepress').each((_, el) => {
    if (el === currentEl) return;
    const rows = $(el).find('tr').length;
    if (rows > bestRows) {
      best = $(el);
      bestRows = rows;
    }
  });
  return best;
}

// Both tables hide a numeric sort-serial in the date cells, e.g.
// <p style='display:none'>46233</p>07/30/26 — without stripping it the text
// reads "4623307/30/26".
function cellText($, td) {
  const $c = $(td).clone();
  $c.find('p').remove();
  return $c.text().trim();
}

const DETAILS_RE = /(\d+)%\s*transfer bonus\s+from\s+(.+?)\s+to\s+(.+)/i;

// Parses the historical archive out of the SAME html the current-bonus parse
// already has — no second HTTP request. Silent by design: ~300 of the 463 rows
// are banks/partners this product doesn't track (Marriott, Hilton, JetBlue…)
// and warning on each would drown the log (and the current-table warning
// contract other tests assert on).
function parseHistoryFrom($) {
  const out = [];
  const table = findHistoryTable($, findBonusTable($));
  if (!table) return out;

  table.find('tr').each((_, el) => {
    const cells = $(el).find('td');
    if (cells.length < 4) return; // header / layout rows
    const details = cellText($, cells[1]);
    // "[Targeted]" rows are offers mailed to selected cardholders, not public
    // windows — counting them would inflate the odds an ordinary user ever
    // sees a bonus on that route (27 of 462 archive rows on 2026-07-24).
    // They already fail alias resolution because of the suffix; excluding them
    // here makes that deliberate instead of accidental.
    if (/\[\s*targeted\s*\]/i.test(details)) return;
    const match = details.match(DETAILS_RE);
    if (!match) return; // non-percentage promos ("5,000 bonus points…")
    out.push({
      bankName: cellText($, cells[0]),
      partnerName: match[3].trim(),
      pct: Number(match[1]),
      startDateRaw: cellText($, cells[2]),
      endDateRaw: cellText($, cells[3]),
    });
  });

  return out;
}

// Exported for tests and for a future publish.mjs that collects history
// explicitly instead of via the history.mjs store (see the ponytail note
// there). Same html in, raw windows out.
export function parseHistory(html) {
  return parseHistoryFrom(cheerio.load(html));
}

export const source = {
  id: 'frequentmiler',
  url: 'https://frequentmiler.com/current-point-transfer-bonuses/',
  async parse(html) {
    const $ = cheerio.load(html);
    const out = [];
    const table = findBonusTable($);

    // Hand the archive off before parsing current bonuses: the loop below
    // mutates date cells (find('p').remove()) on this same document.
    recordHistory(source.id, parseHistoryFrom($));

    if (!table) {
      console.warn('[frequentmiler] could not locate the current/upcoming bonus table');
      return out;
    }

    table.find('tr').each((_, el) => {
      const $row = $(el);
      const cells = $row.find('td');
      // Header rows (th only) and anything short of the 4 expected columns
      // are skipped here.
      if (cells.length < 4) {
        console.warn(`[frequentmiler] skipping row with ${cells.length} cell(s), expected 4`);
        return;
      }

      const bankName = $(cells[0]).text().trim();
      const detailsText = $(cells[1]).text().trim();
      const match = detailsText.match(/(\d+)%\s*transfer bonus\s+from\s+(.+?)\s+to\s+(.+)/i);

      if (!bankName || !match) {
        console.warn(
          `[frequentmiler] skipping malformed row: bank=${JSON.stringify(bankName)} details=${JSON.stringify(detailsText)}`,
        );
        return;
      }

      // The end-date cell holds a hidden sort-serial <p> before the display
      // date, e.g. <p style='display:none'>46233</p>07/30/26 — strip it or
      // the text comes out as "4623307/30/26".
      const $endCell = $(cells[3]);
      $endCell.find('p').remove();
      const endDateRaw = $endCell.text().trim();

      if (!endDateRaw) {
        console.warn(`[frequentmiler] skipping row with no end date: bank=${JSON.stringify(bankName)}`);
        return;
      }

      // The table is titled "Current AND UPCOMING", and this parser used to
      // read only the end date — so a bonus announced days ahead was published
      // as live the moment it appeared. That is the one error class this
      // product must never make: on 2026-08-30 it showed "Bilt -> Virgin +100%,
      // ACTIVE NOW, ENDS IN 3D" for a window that existed only on Sep 1.
      // Transferring on the strength of that gets zero bonus, and transfers are
      // irreversible. Bilt makes it acute: 24 of its 26 archived windows last
      // exactly ONE day and start on the 1st of the month.
      const $startCell = $(cells[2]);
      $startCell.find('p').remove();
      const startDateRaw = $startCell.text().trim();

      out.push({
        bankName,
        partnerName: match[3].trim(),
        pct: Number(match[1]),
        startDateRaw,
        endDateRaw,
        sourceUrl: source.url,
      });
    });

    return out;
  },
};
