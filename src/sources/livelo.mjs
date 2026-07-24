import * as cheerio from 'cheerio';

export const source = {
  id: 'livelo',
  url: 'https://www.livelo.com.br/promocoes-parceiros-transferencia',
  // ponytail: selectors below match fixtures/livelo.html's shape (a
  // Portuguese-language promo list), not the live DOM. The fixture proves
  // this parser's shape logic; finalizing selectors against the real page's
  // markup is a go-live step (see GO-LIVE.md), not something the executor
  // can verify without fetching the live site. Livelo has a single bank
  // ("Livelo"), so bankName is constant here.
  async parse(html) {
    const $ = cheerio.load(html);
    const out = [];
    $('.oferta').each((_, el) => {
      const $li = $(el);
      const bankName = $li.find('.banco').text().trim();
      const partnerName = $li.find('.parceiro').text().trim();
      const bonusText = $li.find('.bonus').text().trim();
      const endDateRaw = $li.find('.ate').text().trim();
      const pctMatch = bonusText.match(/-?\d+(\.\d+)?/);

      if (!bankName || !partnerName || !pctMatch) {
        console.warn(
          `[livelo] skipping malformed entry: banco=${JSON.stringify(bankName)} parceiro=${JSON.stringify(partnerName)} bonus=${JSON.stringify(bonusText)}`,
        );
        return;
      }

      out.push({ bankName, partnerName, pct: Number(pctMatch[0]), endDateRaw, sourceUrl: source.url });
    });
    return out;
  },
};
