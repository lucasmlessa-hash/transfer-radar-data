import * as cheerio from 'cheerio';

export const source = {
  id: 'frequentmiler',
  url: 'https://frequentmiler.com/current-point-transfer-bonuses/',
  // ponytail: selectors below match fixtures/frequentmiler.html's shape (a
  // bank/partner/bonus/expires table), not the live DOM. The fixture proves
  // this parser's shape logic; finalizing selectors against the real page's
  // markup is a go-live step (see GO-LIVE.md), not something the executor
  // can verify without fetching the live site.
  async parse(html) {
    const $ = cheerio.load(html);
    const out = [];
    $('.bonus-row').each((_, el) => {
      const $row = $(el);
      const bankName = $row.find('.bank').text().trim();
      const partnerName = $row.find('.partner').text().trim();
      const pctText = $row.find('.pct').text().trim();
      const endDateRaw = $row.find('.expires').text().trim();
      const pctMatch = pctText.match(/-?\d+(\.\d+)?/);

      if (!bankName || !partnerName || !pctMatch) {
        console.warn(
          `[frequentmiler] skipping malformed entry: bank=${JSON.stringify(bankName)} partner=${JSON.stringify(partnerName)} pct=${JSON.stringify(pctText)}`,
        );
        return;
      }

      out.push({ bankName, partnerName, pct: Number(pctMatch[0]), endDateRaw, sourceUrl: source.url });
    });
    return out;
  },
};
