import * as cheerio from 'cheerio';

export const source = {
  id: 'awardwallet',
  url: 'https://awardwallet.com/currentpromotions',
  // ponytail: selectors below match fixtures/awardwallet.html's shape (a
  // card-listing layout), not the live DOM. The fixture proves this parser's
  // shape logic; finalizing selectors against the real page's markup is a
  // go-live step (see GO-LIVE.md), not something the executor can verify
  // without fetching the live site.
  async parse(html) {
    const $ = cheerio.load(html);
    const out = [];
    $('.listing-card').each((_, el) => {
      const $card = $(el);
      const bankName = $card.find('.from').text().trim();
      const partnerName = $card.find('.to').text().trim();
      const badgeText = $card.find('.badge').text().trim();
      const endDateRaw = $card.find('.valid-until').text().trim();
      const pctMatch = badgeText.match(/-?\d+(\.\d+)?/);

      if (!bankName || !partnerName || !pctMatch) {
        console.warn(
          `[awardwallet] skipping malformed entry: bank=${JSON.stringify(bankName)} partner=${JSON.stringify(partnerName)} badge=${JSON.stringify(badgeText)}`,
        );
        return;
      }

      out.push({ bankName, partnerName, pct: Number(pctMatch[0]), endDateRaw, sourceUrl: source.url });
    });
    return out;
  },
};
