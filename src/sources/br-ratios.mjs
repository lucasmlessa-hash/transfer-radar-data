// Conversion rates for the Brazilian programmes, scraped from each partner's
// own page.
//
// The listing pages (livelo-para-parceiros, esfera programas-parceiros) name
// the partners but never the rate — that lives one click deeper, on the
// partner's own page. Which is why the Partners tab showed an em dash for
// every Brazilian route while the answer was published all along.
//
// It matters more than "a missing field": the rates are NOT all 1:1.
// Livelo sends 1:1 to Smiles and Azul but 3.5:1 to Iberia, Flying Blue and
// Accor, and Esfera reaches Iberia at 2:1 — so the same 100k points buy 100k
// Smiles miles or 28k Iberia Avios depending where you send them. Comparing
// that is the entire job of the Partners tab.
//
// Fetched on a WEEKLY schedule, not in the 30-minute build: 21 partner pages
// per run is rude at 48 runs a day for numbers that change maybe twice a year.
// See .github/workflows/refresh-br-ratios.yml.

const RE_LIVELO = /([\d.,]+)\s*pontos?\s+Livelo\s*=\s*([\d.,]+)\s*(?:pontos?|milhas?|Avios)?/i;
// Esfera states it inside the terms-and-conditions blob in __NEXT_DATA__.
// Anchored on a digit so the UI label templates ("esferaPoint2Text":" ponto
// Esfera =") can never match — they have no leading number.
const RE_ESFERA = /([\d.,]+)\s*[Pp]ontos?\s+Esfera\s*=\s*([\d.,]+)\s*(?:[Pp]ontos?|[Mm]ilhas?|Avios)/;

// "3.5" and "3,5" both appear; thousands separators do not (rates are small).
const num = (s) => Number(String(s).replace(',', '.'));
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

/** "3.5 pontos Livelo = 1 ponto Iberia Plus" -> "3.5:1" (points sent : received). */
export function parseRatioText(text, which) {
  const m = (which === 'LIV' ? RE_LIVELO : RE_ESFERA).exec(text);
  if (!m) return null;
  const from = num(m[1]), to = num(m[2]);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return null;
  return `${fmt(from)}:${fmt(to)}`;
}

const stripTags = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/\s+/g, ' ');

const nextData = (html) => {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
};

/**
 * A partner page -> its ratio, or null when the page does not state one.
 * Livelo puts it in visible copy; Esfera buries it in the regulation text that
 * ships inside __NEXT_DATA__, so both haystacks are searched for both banks.
 */
export function parsePartnerRatio(html, bank) {
  return parseRatioText(stripTags(html), bank) ?? parseRatioText(nextData(html), bank);
}

/** Livelo's listing page -> [{ name, url }] for every active transfer partner. */
export function liveloPartnerUrls(listingHtml) {
  const raw = nextData(listingHtml);
  if (!raw) return [];
  let doc;
  try { doc = JSON.parse(raw); } catch { return []; }
  let list = null;
  (function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o && typeof o === 'object') {
      if (!list && Array.isArray(o.listPartners)) list = o.listPartners;
      Object.values(o).forEach(walk);
    }
  })(doc);
  return (list ?? [])
    .filter((p) => p?.nomeParceiro && p?.redirectUrl && (!p.status || p.status === 'Ativo'))
    // redirectUrl is absolute for most partners and root-relative for a few
    // (Hilton). Resolving here rather than at the fetch site keeps every
    // caller from having to know that.
    .map((p) => ({ name: p.nomeParceiro, url: new URL(p.redirectUrl, 'https://www.livelo.com.br').toString() }));
}

/**
 * Esfera's listing page -> [{ id, url }] for every transfer partner.
 *
 * Reads `showcaseProductsId` on the "PLP de programas parceiros" block, NOT
 * the navigation menu. The menu lists 8; the showcase lists 19, and the four
 * the menu omits (Aeroméxico, Etihad, IHG, Turkish) are real partners the
 * Partners tab was silently missing.
 *
 * No name here on purpose: the listing carries only ids. The slug in
 * `/p/<slug>/<id>` is decorative — the id alone resolves the page — so the
 * caller fetches each id and reads the name off the page itself.
 */
export function esferaPartnerUrls(listingHtml) {
  const raw = nextData(listingHtml);
  if (!raw) return [];
  let doc;
  try { doc = JSON.parse(raw); } catch { return []; }
  const ids = new Set();
  (function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o && typeof o === 'object') {
      if (typeof o.showcaseProductsId === 'string') {
        for (const id of o.showcaseProductsId.split(',')) {
          const t = id.trim();
          if (/^e\d{9}$/.test(t)) ids.add(t);
        }
      }
      Object.values(o).forEach(walk);
    }
  })(doc);
  return [...ids].map((id) => ({ id, url: `https://www.esfera.com.vc/p/x/${id}` }));
}

/**
 * The partner name off an Esfera product page, or null for the generic shell
 * that unpublished ids render (7 of the 19 showcase ids are such husks — they
 * return the site title with no partner content, and must not become rows).
 */
export function esferaPartnerName(html) {
  const raw = ((html.match(/<title[^>]*>([^<]*)</i) ?? [])[1] ?? '')
    .replace(/&amp;/g, '&').replace(/&nbsp;/gi, ' ')
    .replace(/\s*[|–—-]\s*Esfera.*$/i, '')
    .trim();
  if (!raw || /^esfera$/i.test(raw)) return null;
  return raw;
}
