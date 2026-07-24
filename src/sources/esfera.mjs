import * as cheerio from 'cheerio';

export const source = {
  id: 'esfera',
  url: 'https://www.esfera.com.vc/promocoes',
  // ponytail: selectors below match fixtures/esfera.html's shape (a
  // Portuguese-language card listing), not the live DOM. The fixture proves
  // this parser's shape logic; finalizing selectors against the real page's
  // markup is a go-live step (see GO-LIVE.md), not something the executor
  // can verify without fetching the live site. Esfera has a single bank
  // ("Esfera"), so bankName is constant here.
  async parse(html) {
    const $ = cheerio.load(html);
    const out = [];
    $('.card-oferta').each((_, el) => {
      const $card = $(el);
      const bankName = $card.find('.banco').text().trim();
      const partnerName = $card.find('.parceiro').text().trim();
      const bonusText = $card.find('.bonus').text().trim();
      const endDateRaw = $card.find('.prazo').text().trim();
      const pctMatch = bonusText.match(/-?\d+(\.\d+)?/);

      if (!bankName || !partnerName || !pctMatch) {
        console.warn(
          `[esfera] skipping malformed entry: banco=${JSON.stringify(bankName)} parceiro=${JSON.stringify(partnerName)} bonus=${JSON.stringify(bonusText)}`,
        );
        return;
      }

      out.push({ bankName, partnerName, pct: Number(pctMatch[0]), endDateRaw, sourceUrl: source.url });
    });
    return out;
  },
};
