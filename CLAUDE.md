# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo.

## What this is

A private, unpacked **Chrome MV3 extension**. Background service worker scrapes
the filelist.io snatchlist for `Seed Time Left = Done` torrents and deletes the
matching torrent + data from a local qBittorrent via its WebUI API. No server, no
build target beyond the unpacked `dist/`. See `README.md` for the full run flow.

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
src/background/service-worker.ts    alarm + run flow (cookie→qBit→snatchlist→match→purge)
src/offscreen/                     DOMParser lives here (worker has no DOM)
src/popup/                         log viewer + Clear + config fields
```

## Non-obvious constraints

- **No DOM in the service worker.** `DOMParser`/`document` are undefined at
  runtime (they typecheck fine — `lib.dom` typings lie). All HTML parsing runs in
  the `chrome.offscreen` document (`reasons: [DOM_PARSER]`); the worker messages
  raw HTML over and gets parsed data back. See skill
  `mv3-worker-no-dom-offscreen-domparser`.
- **crxjs won't emit the offscreen page** unless it's registered in
  `vite.config.ts` `build.rollupOptions.input` — a runtime `createDocument` URL
  isn't an auto-detected entry. Omit it and `dist/` lacks `offscreen.html` →
  `createDocument` 404s.
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
