import { storage } from "../storage";
import { Config, LogAction } from "../types";

const ALARM_NAME = "seed-purge";
const CYCLE_MINUTES = 60;
const PAGE_DELAY_MS = 1500;
const MAX_PAGES = 100;

const FILELIST_ORIGIN = "https://filelist.io";
const SNATCHLIST_URL = `${FILELIST_ORIGIN}/snatchlist.php`;
const DETAILS_URL = `${FILELIST_ORIGIN}/details.php`;

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
}

/** Fetch the category's torrents from qBit. Returns null on any failure/non-200. */
async function fetchQbitTorrents(config: Config): Promise<QbitTorrent[] | null> {
    const base = config.qbitUrl.replace(/\/+$/, "");
    const url = `${base}/api/v2/torrents/info?category=${encodeURIComponent(config.category)}`;
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        return (await resp.json()) as QbitTorrent[];
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

interface SnatchRow {
    tid: string;
    /** "Seed Time Left" value, e.g. "Done" or "---" or an elapsed string. */
    seedTimeLeft: string;
    /** "Seed Time" elapsed value (context only). */
    seedTime: string;
}

function idFromHref(href: string | null): string | null {
    if (!href) return null;
    const m = href.match(/[?&]id=(\d+)/);
    return m ? m[1] : null;
}

/**
 * Parse one snatchlist page's rows. Returns null when the expected table is
 * absent (session likely expired / redirected to login).
 */
function parseSnatchPage(html: string): SnatchRow[] | null {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const stlSpans = doc.querySelectorAll("[title='Seed Time Left']");
    if (stlSpans.length === 0) return null;

    const rows: SnatchRow[] = [];
    for (const span of Array.from(stlSpans)) {
        const tr = span.closest("tr");
        if (!tr) continue;
        const link = tr.querySelector<HTMLAnchorElement>("td:nth-child(2) a");
        const tid = idFromHref(link?.getAttribute("href") ?? null);
        if (!tid) continue;
        const seedTime = tr.querySelector("[title='Seed Time']")?.textContent?.trim() ?? "";
        rows.push({
            tid,
            seedTimeLeft: span.textContent?.trim() ?? "",
            seedTime,
        });
    }
    return rows;
}

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
        const rows = parseSnatchPage(html);
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
        const doc = new DOMParser().parseFromString(html, "text/html");
        const h4 =
            doc.querySelector("#maincolumn > div:nth-child(1) > div.cblock-header > h4") ??
            doc.querySelector(".cblock-header h4");
        const name = h4?.textContent?.trim();
        return name && name.length > 0 ? name : null;
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

        // 3. walk snatchlist
        const rows = await walkSnatchlist(uid);
        if (rows === null) {
            await log("abort", { name: "session expired / snatchlist unavailable" });
            return;
        }

        // 4. eligible = Seed Time Left === "done"
        const done = rows.filter((r) => r.seedTimeLeft.trim().toLowerCase() === "done");
        await log("info", { name: `run: ${rows.length} snatched, ${done.length} done, dryRun=${config.dryRun}` });

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
