import { storage } from "../storage";
import { Config, LogAction, OffscreenRequest, OffscreenResponse, SnatchRow } from "../types";
import { parseSnatchDom, parseDetailsDom } from "../parse";

const ALARM_NAME = "seed-purge";
const CYCLE_MINUTES = 60;
const PAGE_DELAY_MS = 1500;
const THANKS_DELAY_MS = 1000;
const MAX_PAGES = 100;

const FILELIST_ORIGIN = "https://filelist.io";
const SNATCHLIST_URL = `${FILELIST_ORIGIN}/snatchlist.php`;
const DETAILS_URL = `${FILELIST_ORIGIN}/details.php`;
const THANKS_URL = `${FILELIST_ORIGIN}/thanks.php`;

const OFFSCREEN_URL = "src/offscreen/offscreen.html";

/** Guards against a second run overlapping the current one. */
let running = false;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function log(
    action: LogAction,
    fields: { tid?: string; name?: string; seedTime?: string; hash?: string } = {},
): Promise<void> {
    await storage.appendLog({
        ts: Date.now(),
        tid: fields.tid ?? "-",
        name: fields.name ?? "",
        seedTime: fields.seedTime ?? "",
        action,
        ...(fields.hash ? { hash: fields.hash } : {}),
    });
}

async function setupAlarm(): Promise<void> {
    await chrome.alarms.clear(ALARM_NAME);
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: CYCLE_MINUTES });
}

// ---- HTML parsing (cross-browser) --------------------------------------
// Chrome MV3 runs the background as a service worker (no DOM) → parse in an
// offscreen document. Firefox runs it as an event page (has DOM) and has no
// chrome.offscreen API → parse inline. Feature-detect and branch.
const HAS_OFFSCREEN = typeof chrome !== "undefined" && !!chrome.offscreen;

async function ensureOffscreen(): Promise<void> {
    if (!HAS_OFFSCREEN) return;
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.DOM_PARSER],
        justification: "Parse filelist.io HTML pages (no DOM in service worker).",
    });
}

async function closeOffscreen(): Promise<void> {
    if (!HAS_OFFSCREEN) return;
    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
}

async function parseSnatchPage(html: string): Promise<SnatchRow[] | null> {
    if (!HAS_OFFSCREEN) return parseSnatchDom(html); // Firefox event page
    const req: OffscreenRequest = { target: "offscreen", kind: "snatch", html };
    const res = (await chrome.runtime.sendMessage(req)) as OffscreenResponse | undefined;
    return res?.kind === "snatch" ? res.rows : null;
}

async function parseDetailsName(html: string): Promise<string | null> {
    if (!HAS_OFFSCREEN) return parseDetailsDom(html); // Firefox event page
    const req: OffscreenRequest = { target: "offscreen", kind: "details", html };
    const res = (await chrome.runtime.sendMessage(req)) as OffscreenResponse | undefined;
    return res?.kind === "details" ? res.name : null;
}

// ---- filelist session ---------------------------------------------------

async function getUid(): Promise<string | null> {
    const cookie = await chrome.cookies.get({ url: FILELIST_ORIGIN, name: "uid" });
    return cookie?.value ?? null;
}

// ---- qBittorrent --------------------------------------------------------

interface QbitTorrent {
    hash: string;
    name: string;
    category: string;
    /** 0..1 download fraction; 1 = fully downloaded (seeding or stopped-complete). */
    progress: number;
}

/**
 * Fetch the category's torrents from qBit, keeping only fully-downloaded ones
 * (progress === 1 → seeding or stopped-complete). Still-downloading torrents
 * (progress < 1) can't have finished seeding, so they're excluded from matching.
 * Returns null on any failure/non-200.
 */
async function fetchQbitTorrents(config: Config): Promise<QbitTorrent[] | null> {
    const base = config.qbitUrl.replace(/\/+$/, "");
    const url = `${base}/api/v2/torrents/info?category=${encodeURIComponent(config.category)}`;
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const all = (await resp.json()) as QbitTorrent[];
        return all.filter((t) => t.progress === 1);
    } catch {
        return null;
    }
}

/** POST torrents/delete for one hash (+ its data). Returns true on 2xx. */
async function qbitDelete(config: Config, hash: string): Promise<boolean> {
    const base = config.qbitUrl.replace(/\/+$/, "");
    try {
        const resp = await fetch(`${base}/api/v2/torrents/delete`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `hashes=${encodeURIComponent(hash)}&deleteFiles=true`,
        });
        return resp.ok;
    } catch {
        return false;
    }
}

type MatchResult =
    | { status: "match"; hash: string }
    | { status: "skip-nomatch" | "skip-ambiguous" };

/** exact trimmed → case-insensitive fallback → unique-or-skip. */
function matchTorrent(torrents: QbitTorrent[], fullName: string): MatchResult {
    const target = fullName.trim();
    let hits = torrents.filter((t) => t.name.trim() === target);
    if (hits.length === 0) {
        const lower = target.toLowerCase();
        hits = torrents.filter((t) => t.name.trim().toLowerCase() === lower);
    }
    if (hits.length === 0) return { status: "skip-nomatch" };
    if (hits.length > 1) return { status: "skip-ambiguous" };
    return { status: "match", hash: hits[0].hash };
}

// ---- snatchlist scrape --------------------------------------------------

/**
 * Walk snatchlist pages until a page adds no new tids (wrap-around stop) or
 * MAX_PAGES. Returns null on session-expired / abort.
 */
async function walkSnatchlist(uid: string): Promise<SnatchRow[] | null> {
    const seen = new Set<string>();
    const collected: SnatchRow[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
        if (page > 0) await sleep(PAGE_DELAY_MS);
        const url = `${SNATCHLIST_URL}?id=${encodeURIComponent(uid)}&page=${page}`;
        let resp: Response;
        try {
            resp = await fetch(url, { credentials: "include" });
        } catch {
            return null;
        }
        if (!resp.ok || resp.url.includes("login.php")) return null;

        const html = await resp.text();
        const rows = await parseSnatchPage(html);
        if (rows === null) return null; // table absent → session expired

        let added = 0;
        for (const row of rows) {
            if (seen.has(row.tid)) continue;
            seen.add(row.tid);
            collected.push(row);
            added++;
        }
        if (added === 0) break; // wrapped back to an already-seen page
    }
    return collected;
}

/** Fetch a torrent's details page and return its full name (h4), or null. */
async function fetchDetailsName(tid: string): Promise<string | null> {
    const url = `${DETAILS_URL}?id=${encodeURIComponent(tid)}`;
    try {
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) return null;
        const html = await resp.text();
        return await parseDetailsName(html);
    } catch {
        return null;
    }
}

// ---- say thanks ---------------------------------------------------------
// Replicates the details-page #thanks_button onclick (say_thanks(id)), which
// POSTs `action=add` to thanks.php. The worker has no live page, so we fire the
// request directly (no Referer needed — the session cookie authorises it).
//
// thanks.php replies with JSON. Crucially, a bare 200 is NOT success: adding an
// already-thanked torrent returns `{"status":false,"err":"..."}`. So we don't
// trust the add response — we VERIFY by reading the thankers list
// (`action=list` → `{"list":"<a href='userdetails.php?id=UID'>...","status":true}`)
// and checking our own uid is in it. Only then do we log "thanked".
//
// The server rejects duplicate thanks, so re-POSTing is a harmless no-op; the
// log-based skip below is just an optimisation, and the list verify self-heals
// any tid whose "thanked" entry has aged out of the 500-entry log.

/** tids already recorded as thanked in the log (skip re-processing). */
async function thankedTids(): Promise<Set<string>> {
    const set = new Set<string>();
    for (const entry of await storage.getLog()) {
        if (entry.action === "thanked") set.add(entry.tid);
    }
    return set;
}

type ThanksJson = { status?: boolean; list?: string; err?: string };
type ThanksResult =
    | { ok: true; data: ThanksJson }
    | { ok: false; reason: string; rateLimited?: boolean };

// filelist caps actions per account per hour. Over the cap, thanks.php returns
// an authenticated HTTP 200 HTML page (not JSON) whose error block reads
// "Numarul maxim permis de actiuni ... Reveniti peste o ora" — a silent 429.
const RATE_LIMIT_MARKER = "maxim permis de actiuni";

/** Collapse whitespace and cap a response body for a one-line log field. */
function snippet(text: string): string {
    const s = text.replace(/\s+/g, " ").trim();
    return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

/**
 * POST one `action` to thanks.php. On failure the reason distinguishes the
 * cases that actually matter: a network throw, the account hourly action cap
 * (`rateLimited`), a non-2xx status, or a 200 whose body isn't JSON (a login or
 * challenge HTML page) — each carrying a snippet of what came back.
 */
async function thanksPost(action: "add" | "list", tid: string): Promise<ThanksResult> {
    let resp: Response;
    try {
        resp = await fetch(THANKS_URL, {
            method: "POST",
            credentials: "include",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
                Accept: "application/json, text/javascript, */*; q=0.01",
            },
            body: `action=${action}&ajax=1&torrentid=${encodeURIComponent(tid)}`,
        });
    } catch (e) {
        return { ok: false, reason: `network error: ${e instanceof Error ? e.message : String(e)}` };
    }
    const text = await resp.text().catch(() => "");
    if (text.includes(RATE_LIMIT_MARKER)) {
        return { ok: false, reason: "account hourly action cap reached", rateLimited: true };
    }
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}: ${snippet(text)}` };
    try {
        return { ok: true, data: JSON.parse(text) as ThanksJson };
    } catch {
        return { ok: false, reason: `non-JSON body: ${snippet(text)}` };
    }
}

/** Does our uid appear in this response's thankers list? */
function listHasUid(res: ThanksResult, uid: string): boolean {
    // Thankers are `<a href='userdetails.php?id=UID'>`. Trailing quote anchors
    // the id so uid 110548 doesn't match a 1105489 prefix.
    return res.ok && !!res.data.list?.includes(`userdetails.php?id=${uid}'`);
}

/**
 * Thank each given row (Done torrents) not already logged as thanked, verifying membership
 * before logging. A successful `add` already returns the thankers list, so we
 * only spend a second `list` request when `add` didn't confirm us — this halves
 * action spend against the hourly cap. On hitting the cap we stop the run
 * immediately (the hourly alarm resumes next cycle). Always on, independent of
 * dry-run (non-destructive).
 */
async function thankAll(rows: SnatchRow[], uid: string): Promise<void> {
    const already = await thankedTids();
    for (const row of rows) {
        if (already.has(row.tid)) continue;

        const add = await thanksPost("add", row.tid); // fire the thank (idempotent)
        if (!add.ok && add.rateLimited) {
            await log("thanks-error", { tid: row.tid, name: "rate-limited — backing off; resumes next cycle" });
            break;
        }

        // Fresh thank: `add` returns the list with us. Otherwise (already-thanked
        // / error) confirm membership with one `list` read.
        let inList = listHasUid(add, uid);
        let list: ThanksResult | null = null;
        if (!inList) {
            list = await thanksPost("list", row.tid);
            if (!list.ok && list.rateLimited) {
                await log("thanks-error", { tid: row.tid, name: "rate-limited — backing off; resumes next cycle" });
                break;
            }
            inList = listHasUid(list, uid);
        }

        if (inList) {
            await log("thanked", { tid: row.tid });
        } else {
            const detail = !add.ok
                ? `add ${add.reason}`
                : add.data.err
                  ? `add err: ${add.data.err}`
                  : list && !list.ok
                    ? `list ${list.reason}`
                    : `not in list (add status=${add.data.status})`;
            await log("thanks-error", { tid: row.tid, name: detail });
        }
        await sleep(THANKS_DELAY_MS);
    }
}

// ---- run flow -----------------------------------------------------------

async function run(): Promise<void> {
    if (running) return;
    running = true;
    try {
        const config = await storage.getConfig();

        // 1. filelist session
        const uid = await getUid();
        if (!uid) {
            await log("abort", { name: "not logged in (no filelist uid cookie)" });
            return;
        }

        // 2. qBit torrent set
        const torrents = await fetchQbitTorrents(config);
        if (torrents === null) {
            await log("abort", { name: `qBit unreachable at ${config.qbitUrl}` });
            return;
        }

        // Spin up the offscreen parser before any HTML parsing.
        await ensureOffscreen();

        // 3. walk snatchlist
        const rows = await walkSnatchlist(uid);
        if (rows === null) {
            await log("abort", { name: "session expired / snatchlist unavailable" });
            return;
        }

        // 4. eligible = Seed Time Left === "done"
        const done = rows.filter((r) => r.seedTimeLeft.trim().toLowerCase() === "done");
        await log("info", { name: `run: ${rows.length} snatched, ${done.length} done, ${torrents.length} qBit-complete, dryRun=${config.dryRun}` });

        // 5-7. per Done row: resolve full name, match, purge
        for (const row of done) {
            const fullName = await fetchDetailsName(row.tid);
            if (fullName === null) {
                await log("skip-fetcherror", { tid: row.tid, seedTime: row.seedTime });
                continue;
            }

            const match = matchTorrent(torrents, fullName);
            if (match.status !== "match") {
                await log(match.status, { tid: row.tid, name: fullName, seedTime: row.seedTime });
                continue;
            }

            if (config.dryRun) {
                await log("would-purge", { tid: row.tid, name: fullName, seedTime: row.seedTime, hash: match.hash });
                continue;
            }

            const ok = await qbitDelete(config, match.hash);
            if (ok) {
                await log("purged", { tid: row.tid, name: fullName, seedTime: row.seedTime, hash: match.hash });
            } else {
                await log("abort", { tid: row.tid, name: `delete failed: ${fullName}`, seedTime: row.seedTime, hash: match.hash });
            }
        }

        // 8. say-thanks for the Done torrents, verified against the thankers
        //    list before logging (dedup via log scan).
        await thankAll(done, uid);
    } finally {
        await closeOffscreen();
        running = false;
    }
}

// ---- wiring -------------------------------------------------------------

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void run();
});

chrome.runtime.onInstalled.addListener(() => {
    void setupAlarm();
    void run(); // immediate first pass (dry-run default, safe)
});

chrome.runtime.onStartup.addListener(() => {
    void setupAlarm();
});
