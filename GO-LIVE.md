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

2. **Enable Pages.** ~~Serve from a branch~~ — **feito de outro jeito, e este
   passo está errado.** O deploy real usa `actions/upload-pages-artifact` +
   `actions/deploy-pages`, com Pages configurado como **GitHub Actions**, não
   como branch. `out/` é gitignored de propósito e nunca é commitado; o
   cabeçalho de `build-feed.yml` explica por quê. Copiar `out/` para `docs/`,
   como este passo recomendava, republicaria dado de build no repositório e
   contradiz o workflow em produção.

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

## Syncing this repo with the monorepo (post-ledger)

Since 2026-07-25 the CI workflow itself commits to this repo: the
`observed-windows` ledger (`data/observed-windows.json`) advances ~once a
day. The public repo is therefore no longer a pure mirror of the monorepo's
subtree. Before any `git subtree push` from the monorepo, pull the CI
commits back first:

    git subtree pull --prefix=transfer-radar-data radar-data main

A rejected subtree push is this in action, not corruption. Never force-push
over `main`: that erases ledger history the pipeline cannot regenerate —
those windows were observed live and exist nowhere else.

## Operational health (2026-10-13 audit)

Build success alone is insufficient. `feed.json.health` reports source and
partner-directory coverage; `generatedAt` remains the build time. Validate the
published endpoint with:

    node scripts/check-feed-health.mjs https://lucasmlessa-hash.github.io/transfer-radar-data/feed.json

Exit 1 means missing coverage, a partial collection, or data/verification older
than six hours. The deploy job now performs this same check after publishing.
A validated partial feed can still publish fresh observations from healthy
sources, but the workflow and extension must expose the degraded status.

GitHub's hourly schedule is best effort: the October audit measured gaps up to
10.4 hours. `repository_dispatch` type `refresh-feed` is supported for an
independent cloud scheduler. Use an existing authorized scheduler and a
repository-scoped credential; do not put tokens in source. This hook alone does
not install or activate an external scheduler. Check that real runs and the
published `generatedAt` advance at the intended cadence after activation.

Weekly ratio checks commit verified changes before reporting unavailable sources
or overdue manual reviews. `node scripts/check-curated-ratios.mjs` verifies review
age; never renew a provenance date without checking the official source.
