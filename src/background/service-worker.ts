import { storage } from "../storage";
import { Config, LogAction, OffscreenRequest, OffscreenResponse, SnatchRow } from "../types";

const ALARM_NAME = "seed-purge";
const CYCLE_MINUTES = 60;
const PAGE_DELAY_MS = 1500;
const MAX_PAGES = 100;

const FILELIST_ORIGIN = "https://filelist.io";
const SNATCHLIST_URL = `${FILELIST_ORIGIN}/snatchlist.php`;
const DETAILS_URL = `${FILELIST_ORIGIN}/details.php`;

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

// ---- offscreen HTML parsing --------------------------------------------
// Service workers have no DOM, so DOMParser lives in an offscreen document.

async function ensureOffscreen(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.DOM_PARSER],
        justification: "Parse filelist.io HTML pages (no DOM in service worker).",
    });
}

async function closeOffscreen(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
}

async function parseSnatchPage(html: string): Promise<SnatchRow[] | null> {
    const req: OffscreenRequest = { target: "offscreen", kind: "snatch", html };
    const res = (await chrome.runtime.sendMessage(req)) as OffscreenResponse | undefined;
    return res?.kind === "snatch" ? res.rows : null;
}

async function parseDetailsName(html: string): Promise<string | null> {
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
