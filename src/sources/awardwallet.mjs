import * as cheerio from 'cheerio';

// DOM verified against the live page on 2026-07-24.
// Layout: repeated `.transfer-times` grids (one master + one per bank section).
// Row shape:
//   <div class="tt-row">
//     <div class="tt-body tt-from">…<a>Chase (Ultimate Rewards)</a><div class="tt-from-region">United States</div><span class="tt-arrow">➔</span></div>
//     <div class="tt-body tt-to"><span class="tt-arrow">➔</span><div>IHG Hotels &amp; Resorts (One Rewards)</div></div>
//     <div class="tt-body tt-ratio">1,000:2,000<div class="tt-bonus">100% transfer bonus through July 30, 2026. Then 70% …</div></div>
//     <div class="tt-body tt-mintransfer">-</div><div class="tt-body tt-avg">…</div>
//   </div>
// Only the master grid is parsed — the per-bank grids below it repeat the same rows.

const DATE = /[A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4}/;

export const source = {
  id: 'awardwallet',
  url: 'https://awardwallet.com/news/credit-card-transfer-bonuses/',
  async parse(html) {
    const $ = cheerio.load(html);
    // Locate by heading, not position; fall back to the first grid on the page.
    const $grid = $('#Current_Transfer_Bonuses').closest('h2').nextAll('.transfer-times').first();
    const $rows = ($grid.length ? $grid : $('.transfer-times').first()).find('.tt-row');
    const out = [];

    $rows.each((_, el) => {
      const $row = $(el);
      if (!$row.find('.tt-body').length) return; // header row

      const cell = (sel) => {
        const $c = $row.find(sel).clone();
        $c.find('.tt-arrow, .tt-from-region, .tt-bonus').remove();
        return $c.text().replace(/\s+/g, ' ').trim();
      };

      const bankName = cell('.tt-from');
      const partnerName = cell('.tt-to');
      const bonus = $row.find('.tt-bonus').text().replace(/\s+/g, ' ').trim();

      // pct is the first percentage; the end date is the first date AFTER it
      // ("Transfer partner added July 1 … and 25% bonus through July 31" -> July 31;
      //  "100% … through July 30. Then 70% … through Aug 31" -> the current one).
      const pctMatch = bonus.match(/(\d+(?:\.\d+)?)\s*%/);
      const endDateRaw = pctMatch
        ? (bonus.slice(pctMatch.index + pctMatch[0].length).match(DATE) || [''])[0].replace(/\s+/g, ' ')
        : '';

      if (!bankName || !partnerName || !pctMatch || !endDateRaw) {
        console.warn(
          `[awardwallet] skipping malformed entry: bank=${JSON.stringify(bankName)} partner=${JSON.stringify(partnerName)} bonus=${JSON.stringify(bonus)}`,
        );
        return;
      }

      out.push({ bankName, partnerName, pct: Number(pctMatch[1]), endDateRaw, sourceUrl: source.url });
    });

    return out;
  },
};
