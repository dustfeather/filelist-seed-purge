# FileList Seed-Purge

A private, unpacked Chrome MV3 extension that runs in the background, scrapes your
[filelist.io](https://filelist.io) **snatchlist** for torrents whose seeding
requirement is met (`Seed Time Left = Done`), and deletes the matching torrent
**and its data** from a local [qBittorrent](https://www.qbittorrent.org/) via its
WebUI API.

It exists because filelist sits behind Cloudflare + 2FA — a headless/server-side
login is blocked, so only the logged-in browser holds a live session. The
extension reuses that session directly from the background.

## How it works

Every 60 minutes (via `chrome.alarms`) the background service worker:

1. Reads the filelist `uid` cookie (`chrome.cookies`). Missing → aborts, logs
   "not logged in".
2. `GET {qBit}/api/v2/torrents/info?category=<cat>` and keeps only
   **completed** torrents (`progress === 1`). Unreachable → aborts.
3. Walks `snatchlist.php?id=<uid>&page=N` with `credentials: "include"`, 1.5 s
   between pages, stopping when a page adds no new torrent IDs (the snatchlist
   wraps to page 1 past the end) or at `MAX_PAGES = 100`.
4. Selects rows where `Seed Time Left === "Done"`.
5. For each, fetches `details.php?id=<tid>` to read the full torrent name from the
   page header (`.cblock-header h4`) — the snatchlist name column is truncated.
6. Matches that name against the qBit set: exact (trimmed) → case-insensitive
   fallback → **unique-or-skip**. Zero matches → `skip-nomatch`; more than one →
   `skip-ambiguous`.
7. On a unique match: if **dry-run** is on, logs `would-purge`; otherwise
   `POST /api/v2/torrents/delete` with `deleteFiles=true`.

HTML parsing happens in a `chrome.offscreen` document — MV3 service workers have
no DOM, so `DOMParser` isn't available in the worker itself.

### Safety

- **Dry-run is ON by default.** Nothing is deleted until you turn it off in the
  popup. In dry-run, eligible torrents log `would-purge` instead.
- Matching is **unique-or-skip**: an ambiguous or missing name is skipped, never
  guessed. A parsing regression fails safe (rows skip; nothing is mis-deleted).
- Only torrents in the configured category, already fully downloaded, are ever
  considered.

## Install (unpacked)

```sh
pnpm install
pnpm build          # outputs to dist/
```

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `dist/` folder.
3. Be logged in to filelist.io in the same browser profile.
4. Have qBittorrent's WebUI running locally (default `http://127.0.0.1:8181`).

> qBittorrent's **localhost auth-bypass** (Options → Web UI → "Bypass
> authentication for clients on localhost") lets the extension call the API with
> no credentials. Enable it, or the delete calls will 401.

## Configure (popup)

| Field      | Default                  | Notes                                        |
|------------|--------------------------|----------------------------------------------|
| qBit URL   | `http://127.0.0.1:8181`  | WebUI base URL.                              |
| Category   | `auto-download`          | Only this qBit category is matched/purged.   |
| Dry-run    | **on**                   | Off = live deletes. Badge turns red (LIVE).  |

The popup is otherwise a read-only log viewer with a **Clear** button.

## Log

Kept in `chrome.storage.local`, ring-capped to 500 entries. Each entry:
`{ ts, tid, name, seedTime, action, hash? }`, where `action` is one of
`purged | would-purge | skip-nomatch | skip-ambiguous | skip-fetcherror | abort | info`.

## Development

```sh
pnpm dev            # vite dev server (HMR)
pnpm build          # tsc + vite build → dist/
pnpm typecheck      # tsc --noEmit
```

A `.githooks/pre-commit` gate runs `typecheck` on every commit
(`git config core.hooksPath .githooks`, wired via the `prepare` script).

**Stack:** Manifest V3, TypeScript, Vite, `@crxjs/vite-plugin`, pnpm.

## Privacy

No server, no telemetry, no external calls beyond filelist.io (your session) and
your local qBittorrent. Credentials are never stored by the extension — it relies
on the browser's live filelist session and qBittorrent's localhost bypass.
