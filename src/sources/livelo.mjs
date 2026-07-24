import * as cheerio from 'cheerio';

// DOM verified live on 2026-07-24 against https://www.livelo.com.br/ofertas
// (HTTP 200). /campanhas and /transferir-pontos both 404.
//
// Livelo is a Next.js SPA — the *rendered* markup carries no offer text — but
// the offers ARE in the raw HTML, inside the SSR `<script id="__NEXT_DATA__">`
// blob (a Contentstack CMS payload). Relevant shape:
//
//   props.pageProps.page.components[]        // type "cbc_previsibility"
//     .props.card.children[]                 // one node per offer card
//       .countdown            = { startDate, endDate }        // often null
//       .status.variations[]  = { status: "Vigente", title, description,
//                                 button: { redirectLink } }
//
// A transfer-bonus card is one whose CTA points at a transfer product page
// (/livelo-para-parceiros/<slug>/<SKU>) and whose copy says "N% de bônus".
// Everything else on /ofertas is shopping/points-earning promos.
//
// We walk the payload generically instead of hardcoding the component path:
// Livelo reshuffles carousels constantly, but the card node shape is stable.
//
// Livelo is its own bank, so bankName is the constant 'Livelo'.

const PDP_LINK = /\/livelo-para-parceiros\/([a-z0-9-]+)\//i;
const BONUS_PCT = /(\d+(?:[.,]\d+)?)\s*%\s*de\s*b[oô]nus/i;
const UNTIL_DDMM = /\bat[ée]\s+(?:as\s+\d{1,2}h\d{0,2}\s+d[oe]\s+dia\s+)?(\d{1,2}\/\d{1,2})\b/i;
const PARA_TAIL = /\bpara\s+(?:o|a|os|as)\s+(.+?)\s*$/i;

function* nodes(v) {
  if (!v || typeof v !== 'object') return;
  if (Array.isArray(v)) {
    for (const x of v) yield* nodes(x);
    return;
  }
  yield v;
  for (const x of Object.values(v)) yield* nodes(x);
}

// "hilton-honors" -> "Hilton Honors". The URL slug is Livelo's own stable
// partner identity; the card title's phrasing is marketing copy that varies.
function fromSlug(slug) {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Livelo stores countdowns in UTC but authors them as Brazilian wall-clock
// deadlines ("23h59 do dia 26/07" is serialized 2026-07-27T02:59:59Z), so
// shift to UTC-3 before taking the day or every campaign reads a day long.
// Emitted as D/M because that is the BR shape normalize.js's parseEndDate
// understands; it reads D/M/Y as US M/D/Y, so the year is deliberately
// dropped (parseEndDate infers it).
// ponytail: fixed -3h, not a tz database. Brazil has had no DST since 2019.
function toDayMonth(iso) {
  if (typeof iso !== 'string' || !iso) return '';
  const dateOnly = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}`;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t - 3 * 60 * 60 * 1000);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const source = {
  id: 'livelo',
  url: 'https://www.livelo.com.br/ofertas',
  async parse(html) {
    const $ = cheerio.load(html);
    const out = [];

    const payload = $('script#__NEXT_DATA__').first().html();
    if (!payload) {
      console.warn('[livelo] no __NEXT_DATA__ payload found in page');
      return out;
    }

    let data;
    try {
      data = JSON.parse(payload);
    } catch (e) {
      console.warn(`[livelo] __NEXT_DATA__ is not valid JSON: ${e.message}`);
      return out;
    }

    const seen = new Set();
    for (const node of nodes(data)) {
      const variations = node?.status?.variations;
      if (!Array.isArray(variations)) continue;
      const countdownEnd = toDayMonth(node?.countdown?.endDate);

      for (const v of variations) {
        // "Vigente" = currently running. Anything else is a scheduled or
        // wound-down variation of the same card.
        if (v?.status && !/vigente/i.test(v.status)) continue;

        const title = String(v?.title ?? '');
        const link = String(v?.button?.redirectLink ?? '');
        const text = `${title} ${String(v?.description ?? '')}`.replace(/<[^>]+>/g, ' ');
        const slug = link.match(PDP_LINK)?.[1];

        // Not a points-transfer card at all -> silently ignore (most of
        // /ofertas is shopping promos; warning on each would be noise).
        if (!slug && !/transfer/i.test(text)) continue;
        const pctMatch = text.match(BONUS_PCT);
        if (!pctMatch) continue;

        const partnerName = slug ? fromSlug(slug) : (title.match(PARA_TAIL)?.[1] ?? '').trim();
        const pct = Number(pctMatch[1].replace(',', '.'));
        if (!partnerName || !Number.isFinite(pct)) {
          console.warn(
            `[livelo] skipping malformed offer: title=${JSON.stringify(title)} link=${JSON.stringify(link)}`,
          );
          continue;
        }

        // The same card is reused across several carousels on the page.
        const key = `${partnerName}|${pct}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Livelo often publishes a transfer campaign with no machine-readable
        // deadline (the dates live in prose on the partner's product page).
        // Emit it undated rather than dropping a real bonus: normalize.mjs
        // turns a missing endDate into a route with no `active` block, so an
        // undated entry can never become a phantom live deal.
        const endDateRaw = countdownEnd || (text.match(UNTIL_DDMM)?.[1] ?? '');
        if (!endDateRaw) {
          console.warn(`[livelo] no end date published for ${partnerName} +${pct}% — emitting undated`);
        }

        out.push({ bankName: 'Livelo', partnerName, pct, endDateRaw, sourceUrl: source.url });
      }
    }

    return out;
  },
};
