# Handoff — FileList Seed-Purge extension (implementation)

**Next session focus:** scaffold + build the agreed Chrome MV3 extension. Design is fully grilled and locked. This doc = build brief. No open design decisions block coding.

## What this is
A **private, unpacked, never-published** Chrome MV3 extension that runs fully in the
background, scrapes the user's filelist.io **snatchlist**, finds torrents whose
"Seed Time Left" = **Done**, and deletes the matching torrent **+ data** from a local
qBittorrent via its WebUI API. Replaces a rejected server-side script approach
(Cloudflare + 2FA block any headless login; only the logged-in browser has a live session).

## Workspace
- Project dir: `/home/dustfeather/projects/filelist-seeder` (NOT a git repo yet; near-empty — only `.env`, `graphify.md`, `graphify-out/`).
- `.env` here is **NOT consumed by the extension** (extension-only design). It holds `QBIT_USER`, `QBIT_PASS`, `FILELIST_PASSKEY`, `COOKIE_pass`, `COOKIE_PHPSESSID` — used only for earlier manual cred testing. **Do not build a server.**
- Reference toolchain to mirror: `~/projects/browser-extensions/filelist-ext` ("FileList Monitor", published) — MV3 + TypeScript + Vite + pnpm, `src/storage.ts` typed chrome.storage wrapper, `src/background/service-worker.ts`, `src/popup/`, `src/manifest.json`, `.githooks/`. **Do NOT modify filelist-ext** — this is a separate new extension.

## Full agreed spec
Complete spec is in the final assistant turn of this conversation. Reproduced condensed:

**Manifest:** `permissions: [storage, alarms, cookies]`; `host_permissions: [https://filelist.io/*, http://127.0.0.1/*, http://localhost/*]`; background service worker (module) + toolbar action popup.

**Config (chrome.storage.local, popup-editable):** qBit base URL default `http://127.0.0.1:8181`; category filter default `auto-download`; interval default **1h** (chrome.alarms 60min); dry-run checkbox **default ON**.

**Run flow (alarm-driven, background):**
1. uid via `chrome.cookies.get({url:'https://filelist.io', name:'uid'})`. Missing → abort + log "not logged in".
2. qBit `GET torrents/info?category=<cat>` (localhost auth-bypass, **no creds**). Fail/non-200 → **abort** + log "qBit unreachable". Build name→hash set.
3. Walk `snatchlist.php?id=<uid>&page=N`, **`credentials:'include'`**, **1.5s** delay/page, `DOMParser`.
   - Row selector: `[title='Seed Time Left']` (raw HTML uses `title=`, NOT `data-original-title=` — that's a post-JS Bootstrap artifact). Per row: value=span text; tid = `td:nth-child(2) a` href `id` param; elapsed seed time = `[title='Seed Time']` text.
   - **Wrap-stop:** out-of-range pages return page 1 (never empty). Stop when a page adds **no new tids**. `MAX_PAGES=100` backstop.
   - Redirect to `login.php` / expected table absent → **abort** + log "session expired".
4. Eligible = `value.trim().toLowerCase() === "done"`.
5. Per Done tid: `GET details.php?id=<tid>` (`credentials:'include'`), full name from `.cblock-header h4` (`#maincolumn > div:nth-child(1) > div.cblock-header > h4`). Fetch fail → `skip-fetcherror`, continue.
6. Match name → qBit set within category: exact trimmed → fallback **case-insensitive** → **unique-or-skip**. 0 → `skip-nomatch`; >1 → `skip-ambiguous`.
7. Unique match: dry-run ON → log `would-purge`; live → `POST torrents/delete` `hashes=<hash>&deleteFiles=true`. Delete fail → log error, continue.

**Log:** chrome.storage.local, ring-capped **500**, `{ts, tid, name, seedTime, action, hash?}`, action ∈ `purged|would-purge|skip-nomatch|skip-ambiguous|skip-fetcherror`. Popup = read-only viewer + **Clear** button.

## Verified facts (empirical, this session)
- qBit **v5.1.0**, WebUI at `http://127.0.0.1:8181`, **localhost auth-bypass ENABLED** → API callable with no login.
- **445 torrents, every one `category=auto-download` + `tag=rss`.** Clean scoping.
- qBit `torrents/properties.comment` = generic `"Torrent created for 'filelist.io' tracker"` — **no tid**, useless for matching (ruled out).
- Snatchlist Name column is **truncated** (`...`) → name-match from snatchlist impossible; that's why matching uses details-page `h4` full name.
- Snatchlist raw-HTML row shape (view-source, confirmed no JS):
  `<td><a href='details.php?id=NNN&hit=1'><b>NAME…</b></a></td>` then per-metric
  `<span data-toggle='tooltip' title='Seed Time Left'>Done|---|<font>1d 23:19:32</font></span>`.
- filelist v1 private tracker → SHA1 infohash (matched qBit `hash`). Infohash approach was offered but user chose details-page name-match.

## Decisions the user made (don't relitigate)
- Extension-only, no server, keep simple.
- Chrome only. Private/unpacked.
- Fully background; popup is log-viewer + Clear + the few config fields only (no run button).
- Matching = **details-page full-name**, case-insensitive fallback, unique-or-skip (rejected infohash approach despite it being safer — respect the choice).
- No delete-count cap, no logfile beyond the in-storage log. Dry-run is the only guard; default ON.
- interval 1h, page delay 1.5s.

## Build notes / gotchas
- MV3 worker stays alive on the pending alarm-handler promise; full walk (≤100 pages × ~1.5s + a few detail fetches) ≪ 5-min event cap. OK.
- Worker `fetch` **must** set `credentials:'include'` or session + `cf_clearance` cookies won't attach → 302 to login.
- Editable qBit URL: host_permissions cover `127.0.0.1` + `localhost`; if user sets an odd host it won't match — acceptable for private tool, or add optional_host_permissions.
- **First real use = dry-run** to verify: (a) raw HTML attribute really is `title=` (already strongly evidenced), (b) `.cblock-header h4` text === qBit torrent `name` (if not, rows safely skip, not mis-delete).

## First implementation steps (suggested)
1. `git init` in project dir (branch-hygiene skill applies), then scaffold Vite+pnpm+TS MV3 project modeled on filelist-ext structure.
2. `src/manifest.json`, `src/storage.ts` (typed config + log ring buffer), `src/background/service-worker.ts` (alarm + run flow), `src/popup/` (log table, Clear, config fields).
3. Wire alarm, implement parse/match/delete, dry-run gating.
4. Load unpacked in Chrome, run dry-run, inspect log, verify h4-vs-qBit-name equality on real Done rows before flipping dry-run off.

## Suggested skills for next agent
- `branch-hygiene-before-coding` — at start (git repo will be freshly init'd).
- `bash-first-scripting` — N/A inside this established-toolchain extension; skip (match filelist-ext conventions instead).
- `research-before-edit` — when touching any file (read filelist-ext patterns first).
- `prefer-githook-checks` — filelist-ext has `.githooks/`; set up typecheck/lint gate similarly.
- `verify` / `run` — to load unpacked + drive the dry-run end-to-end.
- Context7 MCP — for current Chrome MV3 `chrome.alarms`/service-worker/`chrome.cookies` API details if unsure.

## Redactions
All secrets (qBit creds, filelist passkey, session cookies) live only in `.env` and are NOT needed for the build (extension uses localhost bypass + live browser session). Do not copy `.env` values into extension source.
