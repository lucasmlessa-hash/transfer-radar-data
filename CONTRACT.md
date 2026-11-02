# Transfer Radar data contract

Two JSON documents pass between the data pipeline (producer) and the extension
client (consumer). Both are plain JSON, no comments, UTF-8.

- `feed.json` — dynamic, regenerated every pipeline run. The live/forecast
  route data.
- `partners.json` — curated, changes rarely. Bank metadata, partner
  directory, domains used for favicon lookups, and airline mile valuations.

Schemas: `schema/feed.schema.json` and `schema/partners.schema.json`
(JSON Schema draft 2020-12). Validate either document with
`node scripts/validate-feed.mjs <file> [--schema feed|partners]`.

## `feed.json`

```jsonc
{
  "version": 1,
  "generatedAt": "2026-07-23T18:00:00Z",   // ISO-8601 UTC. Client derives "UPDATED Xmin ago" from this.
  "routes": [
    {
      "id": "bilt-af",            // stable key: "<bankLower>-<airCodeLower>"
      "bank": "BILT",             // must be a key of partners.json's `banks` map
      "airline": "Air France / KLM Flying Blue",
      "code": "AF",               // airline code, must be a key of partners.json's `airlineDomains`/`airlineValues`
      "time": "INSTANT",          // "INSTANT" | "~1 DAY" | "~2 DAYS" | free text — transfer speed to the partner
      "typical": "+75–100%",      // free-text typical bonus range, display-only
      "mp": [0.7,0.5,0.5,0.6,0.5,0.7,0.6,0.7,0.5,0.7,0.5,0.8],  // ALWAYS length 12, Jan..Dec, each a probability 0..1
      "p2": [0.8,0.6,0.6,0.7,0.7,0.8,0.8,0.8,0.7,0.8,0.7,0.9],  // OPTIONAL, length 12: P(bonus during the 2-month stretch starting at that month)
      "wait": [0.13,0.69,0.79],   // OPTIONAL, length 3: cumulative P(>=1 bonus) during the next 1 / 3 / 6 complete calendar months
      "active":  { "pct": 75, "startDate": "2026-07-01", "endDate": "2026-07-25" },  // OPTIONAL, present iff a bonus is live right now; startDate optional
      "upcoming":{ "pct": 100, "startDate": "2026-09-01", "endDate": "2026-09-01" },  // OPTIONAL, announced but NOT yet running
      "ended":   { "pct": 25, "endedAt": "2026-07-14" },        // OPTIONAL, present iff a bonus just ended
      "next":    { "label": "Sep 2026", "prob": 82 },           // OPTIONAL, forecast rows: next likely window + confidence 0..100
      "summary": "…",                                            // OPTIONAL, free text, paired with `next`
      "hist":    [ { "w": "JUN 2026", "pct": 100, "len": "1 day" } ]  // past windows, most recent first; may be empty
    }
  ]
}
```

Field notes:

- `version` is always `1` for this contract revision.
- `generatedAt` must be a real ISO-8601 UTC timestamp — the client computes
  "updated N min/hours ago" from it; it never parses a display string.
- A route always has: `id, bank, airline, code, time, typical, mp, hist`.
- `upcoming` (emitted since 2026-09-01) is a bonus the source has ANNOUNCED but
  which has not started. Mutually exclusive with `active`, and the validator
  enforces it. Frequent Miler's table is titled "Current **and Upcoming**" and
  the parser used to read only the end date, so an announced bonus shipped as
  live: on 2026-08-30 the app showed "Bilt → Virgin +100%, ACTIVE NOW, ENDS IN
  3D" for a window that existed only on Sep 1. Acting on that earns no bonus at
  all, and transfers are irreversible. Bilt makes this the common case rather
  than an edge one — 24 of its 26 archived windows last exactly one day and
  start on the 1st of the month, announced days ahead.
- `active.startDate` is optional and present when the source publishes it. It
  exists so the client can tell a bonus that opened TODAY from one running for
  weeks — `endDate` alone cannot. The NEW badge uses it to survive at least the
  first day of a campaign, which matters because a one-day window (Bilt's usual
  shape) would otherwise lose its badge the second time the panel is opened.
- `active`, `ended`, `next`, and `summary` are all optional and independent,
  though in practice a route currently only ever carries `active` alone,
  `ended` (+ optionally `next`/`summary`), or `next` + `summary` alone — never
  `active` and `ended` together. The validator enforces that last one.
- `ended` (emitted since 2026-07-26) is the most recently CLOSED window on the
  route, and only while it closed within the last 30 days. "Closed" is strictly
  before today: `endDate` is inclusive, so a bonus running "until Jul 26" is
  live all of Jul 26 and becomes `ended` on the 27th. A route may reach the
  feed on the strength of `ended` alone — one archived window earns no `next`,
  and dropping such a route hid the whole RECENTLY ENDED list from the client.
  The client also derives `ended` itself for a route the feed published as
  `active` whose date has since passed, under the same 30-day bound, so an
  offline or frozen copy degrades into "recently ended" rather than a blank.
- **Key change from the legacy hardcoded data**: `active.days` (days
  remaining) is **removed**. The feed carries `active.endDate` as a real ISO
  date (`YYYY-MM-DD`); the client computes days-remaining itself from
  `endDate` and the current date. Likewise `ended.when` (a display string like
  `"ENDED JUL 14"`) becomes `ended.endedAt`, a real ISO date.
- `mp` (monthly probability) is always exactly 12 numbers in `0..1`, index 0
  = January, index 11 = December, representing the historical likelihood a
  bonus is live that calendar month.
- `p2` (optional; emitted by every build since 2026-07-25) is 12 numbers in
  `0..1`: index `m` is the probability a bonus runs at some point during the
  2-month stretch starting at month `m` (Dec wraps into Jan). It is computed
  from the archive as an empirical union, NOT derived from `mp` — a client
  wanting a 2-month probability must read `p2[m]`, never compose
  `1-(1-mp[m])(1-mp[m+1])`: a single window spanning both months feeds both
  `mp` entries, and the independence product double-counts it. When `p2` is
  absent (pre-2026-07-25 cached feeds), that composition is the least-bad
  fallback.
- `wait` (optional) is the "worth waiting how long?" curve: cumulative
  probability of at least one bonus on this route within 1, 3 and 6 months of
  `generatedAt`. Like `p2` it is measured EMPIRICALLY over the stretches the
  archive actually observed — never composed as `1-prod(1-mp)`, which
  overstates by ~7pp at 3 months and ~6pp at 6 because one window spanning two
  months feeds both `mp` entries and the product counts it twice.
  Non-decreasing by construction; a client may assume `wait[0] <= wait[1] <=
  wait[2]` and the validator enforces it. Absent for routes whose archive is
  too short to observe a 6-month stretch at all — show no card rather than a
  fabricated 0%.
- `next.prob` is an integer `0..100` (percent confidence).
- No extra keys are allowed on a route object beyond the ones listed above.

## `partners.json`

```jsonc
{
  "version": 1,
  "banks": {
    "AMEX": { "name": "Amex MR", "short": "Amex", "bg": "#E7EEF5", "fg": "#2E5B87" }
  },
  "airlineDomains": { "AF": "airfrance.com" },   // airline code -> domain, used for favicon logo lookups
  "bankDomains":    { "AMEX": "americanexpress.com" },  // bank code -> domain, used for favicon logo lookups
  "airlineValues":  { "AF": 1.3 },               // airline code -> baseline cents-per-mile value used in cpp math
  "directory": {
    "AMEX": {
      "air":   [ ["Aer Lingus AerClub", "1:1"] ],
      "hotel": [ ["Hilton Honors", "1:2"] ]
    }
  }
}
```

Field notes:

- `version` is always `1`.
- `banks` keys are the bank codes referenced by `feed.json` routes' `bank`
  field. Each entry is `{ name, short, bg, fg }` — display name, short label,
  background/foreground hex colors for chips.
- `airlineDomains` and `bankDomains` map codes to a bare domain (no scheme),
  used to fetch favicon-style logos.
- `airlineValues` maps an airline code to a baseline cents-per-point value
  (a plain number, not a string).
- `directory[bank].air` and `directory[bank].hotel` are arrays of 2-tuples
  `[partnerName, ratio]`. `ratio` is always a string of the form
  `"<points>:<miles>"` (e.g. `"1:1"`, `"1:1.6"`, `"2:1"`) — points sent on the
  left, miles/points received on the right.
- All five top-level keys (`banks`, `airlineDomains`, `bankDomains`,
  `airlineValues`, `directory`) are required, alongside `version`.

### Collection health (optional for older feeds)

`generatedAt` is the build time, not a claim that every source was verified.
New feeds publish `health.status` (`ok` or `degraded`), `health.sources` keyed
by source ID, and `health.carriedForwardRoutes`. Each source records `status`,
`checkedAt`, entry count, undated count and, when available, `lastSuccessAt`.
A failed/undated collection does not advance its last successful verification.
`health.directories` separately reports official partner directory failures.
A recognized empty listing can be healthy; missing page structure cannot.
Clients must show partial coverage even when the build timestamp is recent.
Expired carried-forward offers never remain `active` in a newly built feed.

### Proveniência dos dados de referência

`partners.transferTimeMeta[bank][code]` é opcional e acompanha a entrada
correspondente em `transferTimes`, com `source` (URL HTTPS), `asOf` (data real
YYYY-MM-DD) e `estimate` (boolean). Um prazo observado por uma fonte editorial
é estimativa, não garantia do programa. Ausência ou revisão vencida deve ficar
visível. A coleta diária só renova a data quando extrai o prazo daquela rota.

`airlineValueMeta` tem relógio próprio: valor sem fonte verificável ou conferência
de até 35 dias fica fora de CPP/BEST VALUE. Estimativas editoriais em centavos de
USD não são preço de compra/venda nem valor garantido de resgate. A atualização
de promoções não renova automaticamente essas conferências.

Relatórios diários de hotéis, valores e prazos são publicados em
`hotel-ratios-health.json`, `point-valuations-health.json` e
`transfer-times-health.json`, com a cobertura efetivamente verificada.


## Forecast evidence and prospective records (2026-11-01)

`route.forecast` is optional for backward compatibility. The v2 builds use
`pooled-recurrence-v2`: a regularized empirical first-bonus distribution combined
with the route's legacy seasonal estimate. Only completed campaigns strictly
before issue time enter training. The own-seasonal weight is n/(n+5), where n
is the number of distinct completed campaigns; the complement uses partially
pooled origin/destination/global frequencies with a 36-month half-life. The
pooled category counts discount six overlapping monthly origins and use fixed
regularization strengths 5 (route) and 8 (peers). This is an empirical estimator,
not a claimed posterior confidence level. The development/validation protocol
and limitations are in `reports/forecast-model-v2-2026-11-01` in the parent workspace.

Metadata contains `issuedAt`, campaign archive evidence and three calendar
`horizons` (months/startDate/endDate/probability). Horizons start NEXT month,
not today, and estimate the presence of ANY bonus, not a better bonus. `wait`
now mirrors the new cumulative horizon probabilities. `mp`, `p2`, and `next`
remain legacy compatibility fields; clients must not interpret their peaks as
the current model's probability. A forecast-only route can have `forecast`
without `next`; the route cap is 120. Evidence `level` is retained as descriptive
metadata and never suppresses a numeric v2 forecast. Archive span does not
certify continuous coverage. Carried routes retain their original issue date.

`route.offerEvidence` preserves `checkedAt`, independent observations and status
`observed`, `conflict` or `carried`. An observation contains sourceId, an HTTP(S)
URL, pct, optional startDate/endDate, bonusKind (`fixed`, `up_to`, `unknown`) and
optional public conditionsText (at most 600 characters). Observed means seen in
that source, not verified personal eligibility. Conflicting percentages/dates
must not be presented as mutual corroboration. Carry never advances checkedAt.

Real CLI builds persist `data/forecast-records.json`, separate from the campaign
ledger. Original timestamps, probability, model and window are immutable.
New attempts have `publicationStatus:"unconfirmed"` and `publishedAt:null`.
Persistence must succeed before deployment. Only a successful deployment of
the exact artifact, or an explicit observation of that exact public feed before
the forecast window opens, may add a publication confirmation. A local previous
build is never publication proof. Failed attempts remain unconfirmed; a same-day
retry can be recorded separately. After confirmation, an identical reissue in
the same UTC day is omitted; a real probability/window/evidence change or a new
day gets a new immutable record. Samples are retained on every collection.

`confirmForecastPublication` and `scripts/confirm-forecast-publication.mjs`
match route/model/issuedAt/horizon/window/probability exactly. The CLI uses an
atomic replacement and refuses to replace an unreadable or concurrently changed
ledger. A compact JSON record per line keeps the ledger reviewable without
repeating indentation. Legacy entries lacking confirmation are not retroactively
claimed to be published.

Outcomes are `pending`, `observed`, `not_observed` or `unknown`. A negative
requires healthy declared sources through both boundaries with gaps <=6h.
Positive observations remain visible immediately, but both positives and
negatives require a closed window and complete coverage to enter metrics.
`forecast-evaluation.json` contains operational counts; `forecast-history.json`
contains original records, publication markers, first observation, eligibility,
exclusion and metrics. Both expose status/asOf; corrupt ledgers produce an
explicit unavailable report, without invented counts or history.

Metrics select the first confirmed publication per route/model/start/end before
looking at its outcome; reissues are correlated, not extra accuracy samples.
They exclude unpublished, unavailable, late, already-running/announced offers,
open windows and incomplete collection. They group by horizon/model and include
n, pending, unknown, mean probability, observed rate, Brier and trend accuracy
(the prediction is positive at >=50%). `baselineBrier` uses the same sample's
observed frequency and is only a descriptive fitted reference, not an independent
forecast benchmark. The UI recomputes these aggregates for its route/search
filters and offers all/closed/open period filters for the record list.

The cloud scheduler configuration is prepared for feed collection every four
hours, with daily reference refresh/retries retained. This preparation does not
activate it. A report served in the same artifact as a newly deployed feed may
show its confirmation only on the following collection (normally four hours).
The client loads history separately: a missing/error report cannot invalidate
a usable feed/partners pair. Old cached history is visibly dated after a failed
refresh. Tests and fixtures never touch the production ledger unless an explicit
temporary path is supplied.

The client uses a 36-hour verification-age policy for offers and forecasts;
forecast windows that have already started are stale. Displayed probabilities
round to whole percentage points, with <1% and >99% replacing apparent certainty.
The original raw values stay in the feed and ledger. Missing metadata never
implies a verified offer. Divergence is derived from observations as well as
status, so a carried conflict retains its range and warning.

All four parsers mark incomplete transfer entries with `coverageComplete=false`.
The publisher reports `degraded`, preserves lastSuccessAt, and the ledger cannot
count such samples toward a negative result. Header rows, ordinary shopping
cards and Livelo financial-acquisition ads do not trigger this signal.

The evaluation summary includes `status` and `asOf`. An unreadable ledger emits
an `unavailable` summary without counts; old counts must not masquerade as a new
measurement. Workflow ledger persistence must succeed before deployment:
original predictions cannot be reconstructed by the next run after a failed push.

## Recurring campaign starts (v3, 2026-11-02)

`recurrence-hazard-v3` uses explicit `target:"campaign_start"` and
`horizonMode:"rolling_days"`. It forecasts the beginning of a new campaign,
not merely an offer remaining available during a calendar month. Its three
horizons keep `months:1|3|6` as compatibility slots, and additionally require
`days:30|90|180`. All begin on the UTC day after issuance; each ends inclusively
on the issue day plus its stated number of days. For an issue on 2026-11-02,
the windows are 2026-11-03 through 2026-12-02, 2027-01-31, and 2027-05-01.
Only metadata, not the compatibility
slot named `months`, defines the target and actual interval.

Public feeds deliver this model additively as `route.nextCampaignForecast`.
`route.forecast` and `route.wait` retain the v2 calendar-window values so an
installed 1.1.0 client continues interpreting them correctly. The additive
property must contain the v3 model and full target/mode/context metadata;
it cannot contain a legacy or unidentified model. Validators compare `wait`
only with the primary `forecast`, never with `nextCampaignForecast`. New
clients validate the wire representation before promoting the additive
forecast for display. A direct v3 `forecast` remains valid for local callers
and fixtures, with `wait` matching that primary forecast.

The required `context` snapshot contains `campaignsThisYear`,
`campaignsLast365Days`, `annualMedian`, `completeYears`, `daysSinceLastStart`,
`daysSinceLastEnd`, `medianIntervalDays`, `recentIntervalsDays` and
`nextCampaignOrdinal`. Counts are nonnegative integers; the next ordinal is
the year-to-date count plus one. Missing median/interval evidence is null,
never a fictitious zero; `daysSinceLastEnd` is null for a still-active last
campaign. Complete years exclude the first partially observed year and the
current year. These facts explain the estimate, not causal contributions or
an annual cap. The evidence object retains its existing shape.

Old forecasts omit the new target/mode/day/context fields. Their meaning
remains `bonus_available` in `calendar_months`, including bonus overlap with
the target month. Loading or serializing a ledger does not add these fields
to old records or rewrite their outcomes. Comparisons between v2 and v3 must
use the same target and interval; different definitions are not interchangeable
Brier measurements.

New records snapshot target, horizonMode, days and context. Issuance identity,
daily deduplication, exact publication confirmation, metric grouping and the
first-publication-per-window cohort all include the target and interval
definition. Context is immutable and a meaningful context change retains a
new same-day issuance. v3 metric objects expose target, horizonMode and days;
legacy metric objects keep their previous shape.

The ledger records both forecasts when a route supplies both. Additive records
also preserve `forecastField:"nextCampaignForecast"`; omitted field metadata
means the primary `forecast`, including every legacy record. Issuance identity,
daily deduplication and publication confirmation include the original field:
moving a forecast to another property cannot confirm a different artifact.
Metrics remain grouped by the prediction's semantics, so moving the same
definition between fields cannot create an additional accuracy sample.

Observation samples preserve active and announced campaign dates, canonical
campaign identity, and first observation time. Listings overlapping an already
observed campaign keep its original start/identity so an extension or
republication cannot generate a new start. A v3 positive requires a known
canonical start inside the target window and a campaign first known after
issuance. A last-day start may be observed at the closing collection boundary.
An announcement known before issuance is excluded as `offer_present`, including
when a later feed omits that announcement. Previously recorded overlap-target
outcomes retain their original rules.

Unknown campaign starts mark `uncertainStartRoutes`, distinct from general
offer conflicts: such samples invalidate new-start coverage but do not
invalidate an otherwise healthy legacy overlap observation. Both positive
and negative metrics still require publication confirmation, a closed window,
healthy sources and complete collection with gaps no longer than six hours.
One observed start never fills gaps in the rest of its evaluation window.

## Monthly campaign forecasts (v4)

`monthlyCampaignForecast` adds modelVersion `recurrence-hazard-v4`, target `campaign_start`, horizonMode `rolling_months`, and ordered horizons of 1, 2 and 3 months. `days` records the actual duration. Windows begin tomorrow UTC and end on the issuance day's month anniversary, clamped to the last valid day. Each anniversary is computed directly from issuance, never by chaining clamps. The fitted daily hazard model is unchanged.

`forecast` and `nextCampaignForecast` preserve v2/v3 wire semantics. Updated clients prefer the monthly field without modifying the raw payload. The ledger records and confirms all fields independently. Previously issued windows remain unchanged.

`forecast-history.json` preserves v2/v3 for older clients. `forecast-history-monthly.json` includes all versions and monthly records; models and horizons remain separate. The UI displays three probabilities for the same named origin together, with exact end dates. History retains model and horizon filters.
