import * as cheerio from 'cheerio';

// DOM verified against the live site on 2026-07-24.
//
// Esfera promotes its transfer campaigns as hero-carousel banner *images* on
// the homepage. The offer copy is baked into the .avif/.png, but the
// server-rendered <img alt> repeats it verbatim as an accessibility
// description, e.g.
//   Os textos “Só até 26/07: Ganhe até 115% de bônus! Cadastre-se na
//   promoção e transfira pontos.”, a marca da Azul e o botão “Transferir”.
// so pct, end date and partner all come out of the alt attribute, and the
// enclosing <a href="/p/<slug>/e0001..."> gives a fallback partner slug.
//
// The same carousel also carries earn-points banners ("4 pontos a cada R$ 1",
// button "Compre e pontue"). Those are excluded by requiring BOTH an
// "N% de bônus" and a transfer call-to-action.
//
// ponytail: homepage only. /transfira-pontos-esfera renders no campaign copy
// at all, and the per-partner product pages (/p/<slug>/e0001..., field
// esf_transferConversionFactor) are one fetch each and carry no campaign end
// date — so the homepage alt text is the only single-URL source of a
// complete bonus row. If Esfera ever ships a real campaigns endpoint, prefer
// it over prose.

const PCT = /(\d+(?:[.,]\d+)?)\s*%\s*de\s*b[ôo]nus/i;
const END_DATE = /s[óo]\s+at[ée]\s+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i;
const PARTNER = /a\s+marca\s+(?:d[aeo]s?\s+)?(.+?)\s+e\s+o\s+bot[ãa]o/i;
// "Transfers e Seguro Viagem" (a Decolar earn offer) must NOT match, so this
// deliberately lists the Portuguese verb forms rather than a "transfer" stem.
const TRANSFER_CTA = /transferir|transfira|transfer[êe]ncia/i;

export const source = {
  id: 'esfera',
  url: 'https://www.esfera.com.vc/',

  async parse(html) {
    const $ = cheerio.load(html);
    const out = [];
    const seen = new Set();

    $('img[alt]').each((_, el) => {
      const alt = $(el).attr('alt') ?? '';
      const pctMatch = alt.match(PCT);
      if (!pctMatch || !TRANSFER_CTA.test(alt)) return; // not a transfer-bonus banner

      const slug = $(el).closest('a[href*="/p/"]').attr('href')?.split('/')[2];
      const partnerName = alt.match(PARTNER)?.[1]?.trim() || slug?.replace(/-/g, ' ') || '';
      const endDateRaw = alt.match(END_DATE)?.[1] ?? '';

      if (!partnerName || !endDateRaw) {
        console.warn(`[esfera] skipping malformed banner: alt=${JSON.stringify(alt.slice(0, 180))}`);
        return;
      }

      // Responsive <picture> markup can repeat the same alt across variants.
      const key = `${partnerName}|${pctMatch[1]}|${endDateRaw}`;
      if (seen.has(key)) return;
      seen.add(key);

      out.push({
        bankName: 'Esfera',
        partnerName,
        pct: Number(pctMatch[1].replace(',', '.')),
        endDateRaw,
        sourceUrl: source.url,
      });
    });

    return out;
  },
};
