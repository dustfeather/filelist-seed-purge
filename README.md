# FileList Seed-Purge

A **Chrome & Firefox** MV3 extension that runs in the background, watches a local
[qBittorrent](https://www.qbittorrent.org/) via its WebUI API, and deletes each
completed torrent **and its data** once it trips either gate: seeded long enough
(`seeding_time` past a threshold — the qBit WebUI's "seeded for 2d 1h") **or**
`ratio` past a threshold (default 2.1). As it removes a torrent it says-thanks on
[filelist.io](https://filelist.io) for it.

filelist sits behind Cloudflare + 2FA — a headless/server-side login is blocked,
so only the logged-in browser holds a live session. The extension reuses that
session directly from the background for the say-thanks POST.

## How it works

Every minute (via `chrome.alarms`) the background service worker runs one cycle:

**Purge**

1. `GET {qBit}/api/v2/torrents/info?category=<cat>` and keeps only **completed**
   torrents (`progress === 1`). Unreachable → aborts.
2. Selects the ones that trip either gate: `seeding_time` (seconds) at least
   `minSeedTimeHours × 3600`, **or** `ratio` at least `maxRatio` (default 2.1).
3. For each: if **dry-run** is on, logs `would-purge`. Otherwise it says-thanks
   for the torrent (best-effort — see below) then `POST /api/v2/torrents/delete`
   with `deleteFiles=true`.

**Say-thanks** (live mode only, as part of removal — never a bulk sweep):

- Reads the torrent's `comment` (`GET /api/v2/torrents/properties?hash=<hash>`);
  filelist .torrent files carry their `details.php?id=N` URL there → the tid.
- With the filelist `uid` cookie (`chrome.cookies`) present, POSTs `thanks.php`
  and **verifies** membership in the thankers list before logging `thanked`.
- No tid in the comment, not logged in, or already thanked → skip; the delete
  still happens. filelist's hourly action cap backs off gracefully.

The same cycle then runs the FreeLeech RSS auto-download pass (see the RSS
section below). It's all qBit WebUI API + one JSON `thanks.php` POST — nothing
scrapes HTML, so there's no offscreen document or DOM parser.

### Safety

- **Dry-run is ON by default.** Nothing is deleted (and no thanks are sent) until
  you turn it off in the popup. In dry-run, eligible torrents log `would-purge`.
- Only torrents in the configured category, already fully downloaded, are ever
  considered — and only past the seed-time threshold.

## Install

### From a release

Grab the latest [release](../../releases): `…-chrome-vX.Y.Z.zip` for Chrome,
`…-firefox-vX.Y.Z.xpi` for Firefox. Releases are built automatically by CI on
every push to `main` (see [Releases & CI](#releases--ci)).

- **Chrome:** unzip, then `chrome://extensions` → **Developer mode** → **Load
  unpacked** → select the unzipped folder.
- **Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary
  Add-on** → select the `.xpi` (temporary install; permanent install requires an
  AMO-signed build).

### From source

```sh
pnpm install
pnpm build          # single dist/ works in both browsers
```

Then load `dist/` unpacked as above.

**Either way:**
- Be logged in to filelist.io in the same browser profile.
- Have qBittorrent's WebUI running locally (default `http://127.0.0.1:8181`).

> qBittorrent's **localhost auth-bypass** (Options → Web UI → "Bypass
> authentication for clients on localhost") lets the extension call the API with
> no credentials. Enable it, or the delete calls will 401.

## Configure (popup)

| Field              | Default                 | Notes                                        |
|--------------------|-------------------------|----------------------------------------------|
| qBit URL           | `http://127.0.0.1:8181` | WebUI base URL.                              |
| Category           | `auto-download`         | Only this qBit category is purged / downloaded into. |
| Min free space (GiB) | `100`                 | RSS auto-download floor.                     |
| Min seed time (hours) | `49`                 | Purge gate: `seeding_time` past this (49h = 2d 1h). |
| Max ratio          | `2.1`                   | Purge gate: `ratio` at/above this. OR'd with seed time. |
| Dry-run            | **on**                  | Off = live deletes + downloads. Badge turns red (LIVE). |

The popup is otherwise a read-only log viewer with a **Clear** button.

## Log

Kept in `chrome.storage.local`, ring-capped to 500 entries. Each entry:
`{ ts, tid, name, seedTime, action, hash? }`, where `action` is one of
`purged | would-purge | thanked | thanks-error | downloaded | would-download | skip-nospace | skip-nosize | abort | info`.

## Development

```sh
pnpm dev            # vite dev server (HMR)
pnpm build          # tsc + vite build → dist/
pnpm typecheck      # tsc --noEmit
```

A `.githooks/pre-commit` gate runs `typecheck` on every commit
(`git config core.hooksPath .githooks`, wired via the `prepare` script).

**Stack:** Manifest V3, TypeScript, Vite, `@crxjs/vite-plugin`, pnpm. One `dist/`
targets both browsers — a small Vite plugin adds Firefox's `background.scripts`
alongside Chrome's `service_worker`.

## Releases & CI

CI uses shared reusable workflows from
[`dustfeather/shared-workflows`](https://github.com/dustfeather/shared-workflows):

- **PR checks** (`pr-checks.yml`): lint/typecheck/tests/build + automated review.
- **Release** (`release.yml`): on every push to `main`, auto-bumps the patch
  version, tags it, builds, and publishes a GitHub Release with the Chrome
  `.zip` and Firefox `.xpi` (plus a source archive). Optional Chrome Web Store /
  AMO publish jobs run when the corresponding store secrets are configured and
  no-op otherwise.

## Privacy

No server, no telemetry, no external calls beyond filelist.io (your session) and
your local qBittorrent. Credentials are never stored by the extension — it relies
on the browser's live filelist session and qBittorrent's localhost bypass.
