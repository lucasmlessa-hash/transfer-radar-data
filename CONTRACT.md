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
      "wait": [0.13,0.69,0.79],   // OPTIONAL, length 3: cumulative P(>=1 bonus) within 1 / 3 / 6 months of generatedAt
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
