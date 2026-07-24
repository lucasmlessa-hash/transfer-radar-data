import * as cheerio from 'cheerio';

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

export const source = {
  id: 'frequentmiler',
  url: 'https://frequentmiler.com/current-point-transfer-bonuses/',
  async parse(html) {
    const $ = cheerio.load(html);
    const out = [];
    const table = findBonusTable($);

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

      out.push({
        bankName,
        partnerName: match[3].trim(),
        pct: Number(match[1]),
        endDateRaw,
        sourceUrl: source.url,
      });
    });

    return out;
  },
};
