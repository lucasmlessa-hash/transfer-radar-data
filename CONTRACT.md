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
      "active":  { "pct": 75, "endDate": "2026-07-25" },        // OPTIONAL, present iff a bonus is live right now
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
- `active`, `ended`, `next`, and `summary` are all optional and independent,
  though in practice a route currently only ever carries `active` alone,
  `ended` (+ optionally `next`/`summary`), or `next` + `summary` alone — never
  `active` and `ended` together.
- **Key change from the legacy hardcoded data**: `active.days` (days
  remaining) is **removed**. The feed carries `active.endDate` as a real ISO
  date (`YYYY-MM-DD`); the client computes days-remaining itself from
  `endDate` and the current date. Likewise `ended.when` (a display string like
  `"ENDED JUL 14"`) becomes `ended.endedAt`, a real ISO date.
- `mp` (monthly probability) is always exactly 12 numbers in `0..1`, index 0
  = January, index 11 = December, representing the historical likelihood a
  bonus is live that calendar month.
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
