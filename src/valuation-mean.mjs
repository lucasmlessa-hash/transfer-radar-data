// USD cents per destination point. A publisher contributes once, including
// when several eligible airline accounts use the same Avios currency.
import { AVIOS_CODES as AVIOS } from './sources/point-valuations.mjs';
const dayAfter = (date, days) => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);
const publisherKey = url => new URL(url).hostname.replace(/^www\./, '');
const realDay = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
  && Number.isFinite(Date.parse(day)) && dayAfter(day, 0) === day;

export function applyPointValuations(doc, collected, today, report) {
  doc.airlineValueMeta ??= {};
  const verified = new Set();
  const groups = new Map();
  for (const { source, parsed } of collected) {
    for (const code of source.codes) {
      const key = AVIOS.includes(code) ? 'BA' : code;
      if (!groups.has(key)) groups.set(key, new Map());
      const inputs = groups.get(key);
      if (parsed?.values?.[code] > 0 && !inputs.has(source.url)) {
        inputs.set(source.url, {source, parsed, code});
      }
    }
  }
  for (const [key, inputs] of groups) {
    const codes = key === 'BA' ? AVIOS : [key];
    const previous = doc.airlineValueMeta[key];
    let meta, value;
    if (key === 'ACCOR') {
      const quote = [...inputs.values()].find(input => input.parsed.meta?.ACCOR?.method === 'official-fx');
      if (quote) {
        const next = quote.parsed.meta.ACCOR;
        if (realDay(next.asOf) && next.asOf <= today && dayAfter(next.asOf,7) >= today &&
            (previous?.method !== 'official-fx' || next.asOf >= previous.asOf)) {
          meta = {source: quote.source.url, ...next};
          value = quote.parsed.values.ACCOR;
          verified.add(key);
        }
      }
      if (!meta && previous?.method === 'official-fx' && dayAfter(previous.asOf,7) >= today) continue;
    } else {
      const pool = new Map((previous?.sources ?? [])
        .filter(item => item.validUntil >= today && item.checkedOn <= today)
        .map(item => [publisherKey(item.source), item]));
      let nativeMeta;
      for (const {source, parsed, code} of inputs.values()) {
        const extra = parsed.meta?.[code];
        const edition = parsed.evidence?.editorial?.month;
        const asOf = parsed.dates?.[code] ?? (edition ? edition + '-01' : extra?.asOf);
        if (!realDay(asOf) || asOf > today) continue;
        const checkedOn = today;
        let validUntil = [dayAfter(asOf,source.maxAgeDays ?? 35), dayAfter(checkedOn,35)].sort()[0];
        if (parsed.evidence?.fx?.date && extra?.currency === 'BRL') {
          validUntil = [validUntil,dayAfter(parsed.evidence.fx.date,5)].sort()[0];
        }
        const publisher = publisherKey(source.url);
        const prior = pool.get(publisher);
        if (validUntil < today || (prior && (prior.asOf > asOf || prior.checkedOn > checkedOn))) continue;
        if (prior && prior.source !== source.url && prior.asOf === asOf) continue;
        pool.set(publisher,{name:source.name, source:source.url, value:parsed.values[code], asOf, checkedOn, validUntil});
        if (extra?.currency === 'BRL') nativeMeta = extra;
        for (const c of codes) verified.add(c);
      }
      const sources = [...pool.values()].sort((a,b) => a.name.localeCompare(b.name, 'en'));
      if (sources.length) {
        value = Number((sources.reduce((sum,item) => sum + item.value,0) / sources.length).toFixed(6));
        // A single converted BRL observation also keeps its original units and fixing.
        const native = sources.length === 1 && (nativeMeta || (previous?.currency === 'BRL' && previous.source === sources[0].source && previous));
        meta = {currency:'USD', ...(native || {}), method:'editorial-mean', asOf:native?.asOf ?? sources.map(item=>item.checkedOn).sort().at(-1),
          source:sources[0].source, estimate:true, sources};
      } else if (!previous?.method && !inputs.size) {
        // Legacy cached figures keep their original review dates on a complete outage.
        continue;
      }
    }
    for (const code of codes) {
      const before = doc.airlineValues[code];
      if (value === undefined) {
        delete doc.airlineValues[code];
        delete doc.airlineValueMeta[code];
      } else {
        doc.airlineValues[code] = value;
        doc.airlineValueMeta[code] = meta;
      }
      if (before !== value) report.changes.push({code, before:before ?? null, after:value ?? null});
    }
  }
  report.verified = verified.size;
}
