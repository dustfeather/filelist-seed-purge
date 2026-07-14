# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo.

## What this is

A **Chrome & Firefox MV3 extension**. Background worker scrapes the filelist.io
snatchlist for `Seed Time Left = Done` torrents and deletes the matching torrent
+ data from a local qBittorrent via its WebUI API. No server. One `dist/` loads
in both browsers; CI publishes GitHub Releases. See `README.md` for the full run
flow and the shared-workflows CI.

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
src/manifest.json                  MV3: [storage,alarms,cookies,offscreen] + host perms
src/types.ts                       Config, LogEntry, SnatchRow, Offscreen{Request,Response}
src/storage.ts                     typed chrome.storage.local + 500-entry log ring buffer
src/parse.ts                       pure DOMParser row/name parsers (shared)
src/background/service-worker.ts    alarm + run flow (cookie→qBit→snatchlist→match→purge)
src/offscreen/                     Chrome offscreen doc that runs src/parse.ts
src/popup/                         log viewer + Clear + config fields
.github/workflows/                 shared-workflows CI (pr-checks, release, claude)
```

## Non-obvious constraints

- **No DOM in the Chrome service worker.** `DOMParser`/`document` are undefined
  at runtime there (they typecheck fine — `lib.dom` typings lie). Pure parsers
  live in `src/parse.ts`. On Chrome they run in the `chrome.offscreen` document
  (`reasons: [DOM_PARSER]`); on Firefox the background is an event page **with** a
  DOM (and no `chrome.offscreen` API), so the worker calls the parsers inline.
  The worker feature-detects via `HAS_OFFSCREEN = !!chrome.offscreen`. See skill
  `mv3-worker-no-dom-offscreen-domparser`.
- **crxjs won't emit the offscreen page** unless it's registered in
  `vite.config.ts` `build.rollupOptions.input` — a runtime `createDocument` URL
  isn't an auto-detected entry. Omit it and `dist/` lacks `offscreen.html` →
  `createDocument` 404s.
- **Cross-browser build.** One `dist/` serves both. The `firefoxBackgroundScripts`
  Vite plugin adds `background.scripts` (Firefox) next to `service_worker`
  (Chrome); `browser_specific_settings.gecko` is in `manifest.json`. The
  `offscreen` permission is Chrome-only — Firefox ignores it with a warning.
- **`fetch` to filelist must set `credentials: "include"`** or the session +
  `cf_clearance` cookies don't attach → 302 to login.
- **qBit needs localhost auth-bypass** enabled; the extension sends no qBit creds.

## Behavior rules (locked — don't change without asking)

- **Dry-run defaults ON.** It's the only deletion guard. Keep it on by default.
- Matching = details-page `h4` full-name, exact → case-insensitive →
  **unique-or-skip**. Never guess an ambiguous match.
- Only completed (`progress === 1`) torrents in the configured category are
  candidates. Delete trigger is filelist `Seed Time Left = Done` alone.
- Log is capped at 500 entries; actions are a fixed union (see `types.ts`).

## Secrets

`.env` (gitignored, never committed) holds qBit/filelist creds used only for
earlier manual testing. The extension does **not** read it. Never copy its values
into source, and never commit it.
