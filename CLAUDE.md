# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo.

## What this is

A **Chrome & Firefox MV3 extension**. Background worker polls a local
qBittorrent (WebUI API) every minute and deletes each completed torrent + data
once its `seeding_time` passes a configurable threshold (default 49h = 2d 1h).
As it removes a torrent it says-thanks on filelist for it (courtesy POST,
best-effort). Same worker also auto-downloads FreeLeech RSS entries under a
free-space floor. No server. One `dist/` loads in both browsers; CI publishes
GitHub Releases. See `README.md` for the full run flow and the shared-workflows
CI.

## Stack & commands

Manifest V3 · TypeScript · Vite · `@crxjs/vite-plugin` · pnpm.

```sh
pnpm install
pnpm build        # tsc + vite build → dist/   (load this unpacked)
pnpm typecheck    # tsc --noEmit
pnpm dev          # vite dev server (HMR)
```

`.githooks/pre-commit` runs `typecheck` on every commit (hooksPath wired via the
`prepare` script). Don't bypass it.

## Layout

```
src/manifest.json                  MV3: [storage,alarms,cookies] + host perms
src/types.ts                       Config, LogEntry, RssArticle/RssItems
src/storage.ts                     typed chrome.storage.local + 500-entry log ring buffer
src/background/service-worker.ts    1-min alarm → runCycle (purgePass then downloadPass)
src/popup/                         log viewer + Clear + config fields
.github/workflows/                 shared-workflows CI (pr-checks, release, claude)
```

## Non-obvious constraints

- **No HTML scraping / no DOM.** Deletion is a pure qBit API decision
  (`torrents/info` → `seeding_time`), and say-thanks talks JSON to `thanks.php`.
  Nothing parses HTML, so there's no `DOMParser`, no `src/parse.ts`, and no
  Chrome offscreen document (all removed 2026-07). qBit is the WebUI API only —
  the extension never reads the qBit WebUI DOM. qBit API reference:
  https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-5.0)
- **`seeding_time` and `ratio` are the delete signals** (either trips). Both are
  top-level `torrents/info` fields — `seeding_time` (total seconds seeded,
  cumulative/persisted) renders in the WebUI as "seeded for 2d 1h", `ratio` is
  upload/download. No per-torrent call needed for the threshold check.
- **filelist tid for thanks comes from the torrent `comment`.** filelist
  .torrent files carry their details URL (`…filelist.io/details.php?id=N`) in
  `comment` (via `torrents/properties?hash=`); that's the only place the worker
  gets a tid now that snatchlist scraping is gone. No id in the comment → skip
  thanks, still delete.
- **Cross-browser build (per-target, same `dist/`).** `BROWSER` env selects the
  target: `pnpm build:chrome` (default `pnpm build`) leaves crxjs's
  `background.service_worker`; `pnpm build:firefox` rewrites it to an event page
  (`background.scripts`, no `service_worker`) so neither browser logs a manifest
  warning. The `crossBrowserManifest` Vite plugin does the Firefox rewrite in
  `writeBundle`. `browser_specific_settings.gecko` stays in `manifest.json`
  (Chrome ignores it). Release CI builds each target into `dist/` then zips it
  (Chrome `.zip` before the Firefox build overwrites the manifest).
- **`fetch` to filelist must set `credentials: "include"`** or the session +
  `cf_clearance` cookies don't attach → 302 to login.
- **qBit needs localhost auth-bypass** enabled; the extension sends no qBit creds.

## Behavior rules (locked — don't change without asking)

- **Dry-run defaults ON.** It's the only deletion guard. Keep it on by default.
  In dry-run nothing is deleted and no thanks are sent.
- Only completed (`progress === 1`) torrents in the configured category are
  candidates. Delete trigger is **either** gate, OR'd: `seeding_time >=
  minSeedTimeHours` **or** `ratio >= maxRatio` (default 2.1).
- Say-thanks fires only as a torrent is removed (live mode), at most once per
  torrent (log-deduped) — never a bulk hourly sweep. Keeps filelist traffic minimal.
- Log is capped at 500 entries; actions are a fixed union (see `types.ts`).

## Secrets

`.env` (gitignored, never committed) holds qBit/filelist creds used only for
earlier manual testing. The extension does **not** read it. Never copy its values
into source, and never commit it.
