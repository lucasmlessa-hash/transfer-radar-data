// Issuer-confirmed terms apply only to the named destination, percentage and campaign window.
// Dates retain the issuer's offset; the stated closing minute is inclusive.
const campaigns = [
  { ids: ['citi-tk'], pct: 40, start: '2026-11-01', end: '2026-11-30',
    terms: { endsAt: '2026-11-30T23:59:00+03:00', bonusCap: 50000,
      url: 'https://www.turkishairlines.com/en-us/miles-and-smiles/campaigns/earn-40-percent-extra-miles-with-citi/index.html' } },
  { ids: ['liv-g3'], pct: 80, start: '2026-11-25', end: '2026-11-26',
    terms: { startsAt: '2026-11-25T10:00:00-03:00', endsAt: '2026-11-26T23:59:00-03:00', bonusCap: 300000,
      levels: [{ pct: 40, label: 'Demais clientes' }, { pct: 80, label: 'Clube Livelo, Clube Smiles, Magno ou Diamante' }],
      note: 'Cadastro obrigatório. O limite é compartilhado por CPF ou Conta Família Smiles.',
      url: 'https://api-cms-portal-blue.smiles.com.br/en/portal/campanhas/orangefriday-bancos-livelo-11-2026' } },
  { ids: ['rove-accor', 'rove-af', 'rove-cm', 'rove-ay', 'rove-jl'], pct: 55, start: '2026-11-26', end: '2026-11-30',
    terms: { startsAt: '2026-11-26T00:00:00-05:00', endsAt: '2026-11-30T23:59:00-05:00',
      levels: [{ pct: 40, label: 'Member ou Gold' }, { pct: 50, label: 'Platinum' }, { pct: 55, label: 'Diamond' }],
      url: 'https://www.rove.com/blog/rove-black-friday' } },
];

export function campaignWindow(id, pct, startDate, endDate) {
  const match = campaigns.find(c => c.ids.includes(id) && c.pct === pct && c.end === endDate && (!startDate || c.start === startDate));
  if (match) return { pct, startDate: match.start, endDate, terms: structuredClone(match.terms) };
  return { pct, ...(startDate ? { startDate } : {}), endDate };
}

export function windowExpired(window, now) {
  if (!window) return false;
  return window.terms?.endsAt ? now.getTime() >= Date.parse(window.terms.endsAt) + 60000 : window.endDate < now.toISOString().slice(0, 10);
}

export function windowUpcoming(window, now) {
  return window.terms?.startsAt ? now.getTime() < Date.parse(window.terms.startsAt) : window.startDate > now.toISOString().slice(0, 10);
}
