# Go-live runbook

This directory is a self-contained pipeline. It was built and tested against
hand-written fixtures only (`fixtures/*.html`) — no live site was fetched
during development. Selectors in `src/sources/*.mjs` encode each source's
*shape* (a table row, a card, a list item), not its live DOM. Finalizing
against the real pages is an operator step, done here.

1. **Create the repo.** Create a new public GitHub repo named
   `transfer-radar-data` and push this directory's contents to it (history or
   fresh init, either is fine — nothing here references a path outside this
   directory).

2. **Enable Pages.** In the repo's Settings → Pages, serve from a branch. The
   pipeline writes to `out/`; either configure Pages to serve `/out` directly,
   or add a step to `build-feed.yml` that copies `out/` to `docs/` before the
   commit step (Pages doesn't serve arbitrary directory names by default —
   `/docs` and `/` are the two built-in options).

3. **Fix the parsers against live HTML.** Run the workflow once via
   `workflow_dispatch`. Expect it to publish few or zero routes, or to log
   parser warnings — the fixtures prove the parsing *logic*, not the live
   site's actual markup. For each source in `src/sources/`:
   - Fetch the real page, inspect the DOM, and update the CSS selectors
     (`.bonus-row`, `.listing-card`, `.oferta`, `.card-oferta`, etc.) to match.
   - If the source publishes an RSS/Atom feed, prefer it over scraping HTML
     (per plan 004's guidance) — swap the fetch + cheerio parsing for a feed
     parse.
   - Re-run `workflow_dispatch` and iterate until the run prints
     `PUBLISH OK` with real entries and a sensible `unmapped: [...]` list.
   - Extend `src/aliases.mjs` for any bank/partner name variant that lands in
     `unmapped` but is one of the 8 known banks / 12 known partner codes.

4. **Point the extension at the published feed.** In
   `transfer-bonus-radar/config.js`, set `feedBaseUrl` to the Pages URL from
   step 2. Update `host_permissions` in `transfer-bonus-radar/manifest.json`
   to that same origin so the extension is allowed to fetch it.

5. **Robots/ToS check, and keep attribution.** Before scraping each source in
   production, check its `robots.txt` and terms of service for scraping
   restrictions; drop any source that disallows it (with ≥2 sources
   remaining, per plan 004's STOP condition). Keep each source's `sourceUrl`
   available for attribution — the pipeline logs it per source in the
   `PUBLISH OK` / `unmapped` summary; the feed contract itself (plan 001)
   doesn't carry a per-route source field, so if on-feed attribution becomes
   a requirement, that's a contract change for a future plan, not something
   this pipeline can add unilaterally.

## Known limitations to resolve before go-live

- No source in this plan currently offers RSS in the fixtures — check each
  site for a feed at go-live time and prefer it if one exists (fewer things
  to break when the page's HTML changes).
- If a source requires login or is paywalled to see bonus listings, drop it
  from `SOURCES` in `src/publish.mjs`, note it here, and continue with the
  rest, provided at least 2 sources remain.
- `time` (transfer speed) and `typical` (display range) for routes the
  pipeline discovers that aren't already in `sample/feed.json` default to
  `'—'` — fill these in by hand (or via a future static seed file, see plan
  005) once real data is flowing.
