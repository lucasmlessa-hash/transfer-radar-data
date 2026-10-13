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

// Campaign pages carry the validity separately from the undated offer card.
// Keep explicit years: D/M alone would roll an expired campaign into next year.
// Return M/D/YYYY, the year-bearing format understood by normalize.mjs.
function campaignDates(html, pct) {
  const $ = cheerio.load(html);
  const data = JSON.parse($('script#__NEXT_DATA__').first().html() || '{}');
  for (const node of nodes(data)) {
    const campaign = node.campaign;
    if (!campaign) continue;
    const copy = cheerio.load(`${campaign.bonus ?? ''} ${campaign.longDescription ?? ''}`).text();
    const percentages = [...copy.matchAll(new RegExp(BONUS_PCT.source, 'gi'))]
      .map(m => Number(m[1].replace(',', '.')));
    // Avoid combining a stale card's percentage with a different campaign's dates.
    if (!percentages.includes(pct)) continue;
    const text = cheerio.load(`${campaign.partnercampaignalert ?? ''} ${campaign.longDescription ?? ''}`)
      .text().replace(/\s+/g, ' ');
    const m = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+at[ée]\s+(?:(?:as|às)\s+)?(?:\d{1,2}(?:h|:)\d{0,2}\s+(?:do\s+dia\s+)?)?(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    if (!m) continue;
    const [, sd, sm, sy, ed, em, ey] = m;
    const endYear = Number(ey);
    const startYear = sy ? Number(sy) : endYear - (Number(sm) > Number(em) ? 1 : 0);
    const valid = (y, month, day) => {
      const d = new Date(Date.UTC(y, Number(month) - 1, Number(day)));
      return d.getUTCFullYear() === y && d.getUTCMonth() === Number(month) - 1 && d.getUTCDate() === Number(day);
    };
    if (!valid(startYear, sm, sd) || !valid(endYear, em, ed)) continue;
    if (Date.UTC(startYear, Number(sm) - 1, Number(sd)) > Date.UTC(endYear, Number(em) - 1, Number(ed))) continue;
    return { startDateRaw: `${sm}/${sd}/${startYear}`, endDateRaw: `${em}/${ed}/${endYear}` };
  }
  return null;
}

export const source = {
  id: 'livelo',
  url: 'https://www.livelo.com.br/ofertas',
  async parse(html, { loadPage } = {}) {
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
      if (node.status.forceClose) continue;
      const countdownEnd = toDayMonth(node?.countdown?.endDate);

      for (const v of variations) {
        // "Vigente" = currently running. Anything else is a scheduled or
        // wound-down variation of the same card.
        if (v?.status && !/vigente/i.test(v.status)) continue;
        if (v?.statusCard && v.statusCard !== 'active') continue;

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

        // Undated listing cards need the linked campaign's validity. If that
        // lookup fails, keep the entry undated: normalize.mjs omits `active`
        // and the pipeline surfaces a coverage warning instead of guessing.
        let endDateRaw = countdownEnd || (text.match(UNTIL_DDMM)?.[1] ?? '');
        let startDateRaw;
        if (!endDateRaw && slug && loadPage) {
          try {
            const url = new URL(link, source.url);
            if (url.origin !== new URL(source.url).origin) throw new Error('unexpected campaign origin');
            const dates = campaignDates(await loadPage(url.href), pct);
            if (dates) ({ endDateRaw, startDateRaw } = dates);
          } catch (e) {
            console.warn(`[livelo] campaign details unavailable for ${partnerName}: ${e.message}`);
          }
        }
        if (!endDateRaw) {
          console.warn(`[livelo] no end date published for ${partnerName} +${pct}% — emitting undated`);
        }

        out.push({ bankName: 'Livelo', partnerName, pct, endDateRaw, ...(startDateRaw ? { startDateRaw } : {}), sourceUrl: source.url });
      }
    }

    return out;
  },
};
