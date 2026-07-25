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

// The connector wording is not standardised — across partner pages it appears
// as "=", "para", "por" and "equivalem a". Each one was found only by a rate
// coming back null for a partner that clearly publishes one, so the set is
// empirical: widen it when the next silent gap turns up, do not assume it is
// complete.
const CONNECTOR = '(?:=|para|por|equivale[m]?\\s+a|vale[m]?)';
const RE_LIVELO = new RegExp(`([\\d.,]+)\\s*pontos?\\s+Livelo\\s*${CONNECTOR}\\s*([\\d.,]+)\\s*(?:pontos?|milhas?|Avios)?`, 'i');
// Esfera states it inside the terms-and-conditions blob in __NEXT_DATA__.
// Anchored on a leading digit so the UI label templates ("esferaPoint2Text":
// " ponto Esfera =") can never match — they carry no number.
const RE_ESFERA = new RegExp(`([\\d.,]+)\\s*[Pp]ontos?\\s+Esfera\\s*${CONNECTOR}\\s*([\\d.,]+)\\s*(?:[Pp]ontos?|[Mm]ilhas?|Avios)`, 'gi');
// An Esfera regulation can carry several rates for one partner along TWO axes:
//
//   who  — the standard rate, and a better one for Clube Esfera subscribers
//   when — a scheduled change, announced ahead of time and still on the page
//
// Etihad on 2026-07-25 lists four, and none of them is stale:
//
//   "A partir de 31.Julho.2026 ... Clube Esfera: de 3,3 para 4,2 ...
//                                  Esfera:       de 3,5 para 4,5 ...
//    Até 30.Julho.2026, permanecem válidas as condições atuais"
//   plus the standing "3,5 ... para todos os clientes" / "3,3 ... Clube".
//
// So 4,5 is not a leftover — it is what Esfera will charge in six days. A
// parser that ignores the date is wrong either today (quoting 4,5 early) or
// from the 31st onward (quoting 3,5 forever). Hence:
//
//   1. a rate inside an "A partir de <date>" block that has NOT arrived is
//      dropped — it is not what a transfer costs right now;
//   2. once that date passes, the dated rate WINS over the standing section,
//      which the site may not get around to editing;
//   3. among what remains, "para todos os clientes" marks the standard rate
//      and beats an unmarked line; club rates are excluded unless nothing
//      else is left;
//   4. ties break to the WORST rate, because quoting one the user does not
//      qualify for is the error that costs them points.
//
// Rules 3 and 4 were each needed on their own: without the club rule the file
// carried Flying Blue at 3:1 and TAP at 2.2:1 (member rates, real ones 3.5:1
// and 2.7:1); without "todos os clientes", Etihad came out at 4.5:1 today.
const CLUB = /clube/i;
const EVERYONE = /para\s+todos\s+os\s+clientes/i;
const PT_MONTHS = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const RE_FROM_DATE = /A partir de\s+(\d{1,2})[.\/ ]([A-Za-zçÇãÃéÉ]+)[.\/ ](\d{4})/gi;

/** "31.Julho.2026" -> Date, or null when the month word is not recognised. */
function parsePtDate(day, monthWord, year) {
  const mi = PT_MONTHS.indexOf(String(monthWord).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
  if (mi === -1) return null;
  return new Date(Date.UTC(Number(year), mi, Number(day)));
}

// Where a scheduled-change block ends. Esfera closes it explicitly ("Até
// 30.Julho.2026, permanecem válidas as condições atuais"), so the terminator is
// read rather than guessed at — a character budget swallowed the standing
// parity section that follows and left the parser with nothing at all.
const RE_BLOCK_END = /At[ée]\s+\d{1,2}[.\/ ][A-Za-zçÇãÃéÉ]+[.\/ ]\d{4}|Paridades\s*:/gi;

// "3.5" and "3,5" both appear; thousands separators do not (rates are small).
const num = (s) => Number(String(s).replace(',', '.'));
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

/**
 * "3.5 pontos Livelo = 1 ponto Iberia Plus" -> "3.5:1" (points sent : received).
 *
 * When a page states several rates, the WORST one wins: it is the standard
 * rate, and the better ones are conditional on a paid subscription the app
 * cannot know the user has. Quoting a rate someone does not qualify for is the
 * one error direction that costs them points.
 */
export function parseRatioText(text, which, now = new Date()) {
  const s = String(text ?? '');
  const found = [];
  if (which === 'LIV') {
    const m = RE_LIVELO.exec(s);
    if (m) found.push({ m, club: false, everyone: false, effective: null });
  } else {
    // where each scheduled change starts, and from when it applies
    const markers = [];
    RE_FROM_DATE.lastIndex = 0;
    let d;
    while ((d = RE_FROM_DATE.exec(s)) !== null) {
      const when = parsePtDate(d[1], d[2], d[3]);
      if (when) markers.push({ at: d.index, when });
    }
    RE_ESFERA.lastIndex = 0;
    let m;
    while ((m = RE_ESFERA.exec(s)) !== null) {
      // the qualifier trails the rate ("... para clientes do Clube Esfera")
      const tail = s.slice(m.index, m.index + m[0].length + 60);
      // the rate belongs to a scheduled change only when no block terminator
      // sits between the announcement and it
      const marker = markers
        .filter((k) => k.at < m.index && !hasTerminatorBetween(s, k.at, m.index))
        .pop();
      found.push({ m, club: CLUB.test(tail), everyone: EVERYONE.test(tail), effective: marker?.when ?? null });
    }
  }
  const rates = found
    .map(({ m, club, everyone, effective }) => ({ from: num(m[1]), to: num(m[2]), club, everyone, effective }))
    .filter((r) => Number.isFinite(r.from) && Number.isFinite(r.to) && r.from > 0 && r.to > 0)
    // announced but not yet in force: not what a transfer costs today
    .filter((r) => !r.effective || r.effective <= now);
  if (!rates.length) return null;

  // a change that HAS taken effect is newer information than the standing text
  const inForce = rates.filter((r) => r.effective);
  if (inForce.length) {
    const latest = Math.max(...inForce.map((r) => r.effective.getTime()));
    const current = inForce.filter((r) => r.effective.getTime() === latest);
    const nonClub = current.filter((r) => !r.club);
    return pickWorst(nonClub.length ? nonClub : current);
  }
  const everyone = rates.filter((r) => r.everyone && !r.club);
  if (everyone.length) return pickWorst(everyone);
  const nonClub = rates.filter((r) => !r.club);
  return pickWorst(nonClub.length ? nonClub : rates);
}

function hasTerminatorBetween(s, from, to) {
  RE_BLOCK_END.lastIndex = from;
  const m = RE_BLOCK_END.exec(s);
  return !!m && m.index < to;
}

function pickWorst(rates) {
  const pick = rates.reduce((a, b) => (a.from / a.to >= b.from / b.to ? a : b));
  return `${fmt(pick.from)}:${fmt(pick.to)}`;
}

const stripTags = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/\s+/g, ' ');

const nextData = (html) => {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return '';
  // The regulation ships as HTML inside a JSON string, so its tags arrive
  // escaped: "3 pontos\\u003c/strong\\u003e Esfera equivalem a ...". Left as
  // is, a </strong> sitting between "pontos" and "Esfera" breaks the pattern
  // and the rate reads as absent — which is exactly how Copa's 3:1 went
  // missing while the page stated it plainly.
  return m[1]
    .replace(/\\u003c[\s\S]*?\\u003e/g, ' ')
    .replace(/\\u0026nbsp;/gi, ' ')
    .replace(/\\u0026amp;/gi, '&')
    .replace(/\\[nrt]/g, ' ')
    .replace(/\s+/g, ' ');
};

/**
 * A partner page -> its ratio, or null when the page does not state one.
 * Livelo puts it in visible copy; Esfera buries it in the regulation text that
 * ships inside __NEXT_DATA__, so both haystacks are searched for both banks.
 */
export function parsePartnerRatio(html, bank, now = new Date()) {
  return parseRatioText(stripTags(html), bank, now) ?? parseRatioText(nextData(html), bank, now);
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
