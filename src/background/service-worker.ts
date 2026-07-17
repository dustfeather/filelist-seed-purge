import { storage } from "../storage";
import { Config, LogAction, RssArticle, RssItems } from "../types";

const GIB = 1024 ** 3;

// Single cadence for the whole qBit-local flow (purge + RSS download). qBit
// refreshes the filelist RSS feed ~every minute; the purge check is a cheap
// torrents/info read, so both run together every minute.
const ALARM_NAME = "seed-cycle";
const CYCLE_MINUTES = 1;
const THANKS_DELAY_MS = 1000;

const FILELIST_ORIGIN = "https://filelist.io";
const THANKS_URL = `${FILELIST_ORIGIN}/thanks.php`;

/** Guards against a second cycle overlapping the current one. */
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

// qBit's WebUI rejects/warns on requests whose Origin doesn't match its own
// host (CSRF guard). Our fetches carry the extension's origin, so qBit logs
// "Origin header & Target origin mismatch". Rewrite the Origin header on
// qBit-bound requests to the qBit origin via declarativeNetRequest, keeping
// qBit's CSRF protection on. Session rule (cleared on restart) rebuilt from
// config each run. No-op on browsers without a working DNR (e.g. Firefox MV3
// dynamic rules) — the request still succeeds, qBit just keeps logging.
const QBIT_ORIGIN_RULE_ID = 1;

async function syncQbitOriginRule(config: Config): Promise<void> {
    if (!chrome.declarativeNetRequest?.updateSessionRules) return;
    let origin: string;
    try {
        origin = new URL(config.qbitUrl).origin;
    } catch {
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [QBIT_ORIGIN_RULE_ID],
        });
        return;
    }
    await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [QBIT_ORIGIN_RULE_ID],
        addRules: [
            {
                id: QBIT_ORIGIN_RULE_ID,
                priority: 1,
                action: {
                    type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
                    requestHeaders: [
                        {
                            header: "Origin",
                            operation: chrome.declarativeNetRequest.HeaderOperation.SET,
                            value: origin,
                        },
                    ],
                },
                condition: {
                    urlFilter: `${origin}/`,
                    resourceTypes: [
                        chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
                        chrome.declarativeNetRequest.ResourceType.OTHER,
                    ],
                },
            },
        ],
    });
}

// ---- filelist session ---------------------------------------------------
// The extension no longer scrapes filelist to decide deletions (that's now a
// pure qBit `seeding_time` check). The session is only used to say-thanks for a
// torrent as it's removed — a courtesy POST that needs the logged-in uid.

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
    /** Total seconds spent seeding (cumulative, persisted). Present on torrents/info. */
    seeding_time?: number;
    /** Share ratio (uploaded / downloaded). Present on torrents/info. */
    ratio?: number;
    /** Bytes still to download (0 once complete). Present on torrents/info. */
    amount_left?: number;
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

/**
 * Read a torrent's `comment` (torrents/properties) and pull the filelist id out
 * of it. filelist .torrent files carry their details/download URL in the comment
 * (…filelist.io/details.php?id=N), which is the tid say-thanks needs. Returns
 * null when qBit is unreachable or the comment holds no filelist id.
 */
async function qbitFilelistId(config: Config, hash: string): Promise<string | null> {
    const base = config.qbitUrl.replace(/\/+$/, "");
    try {
        const resp = await fetch(`${base}/api/v2/torrents/properties?hash=${encodeURIComponent(hash)}`);
        if (!resp.ok) return null;
        const data = (await resp.json()) as { comment?: string };
        const comment = data.comment ?? "";
        if (!/filelist|details\.php|download\.php/i.test(comment)) return null;
        const m = comment.match(/[?&]id=(\d+)/);
        return m ? m[1] : null;
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

/** GET sync/maindata → bytes free on the drive holding qBit's default save path. */
async function fetchFreeSpace(config: Config): Promise<number | null> {
    const base = config.qbitUrl.replace(/\/+$/, "");
    try {
        const resp = await fetch(`${base}/api/v2/sync/maindata?rid=0`);
        if (!resp.ok) return null;
        const data = (await resp.json()) as { server_state?: { free_space_on_disk?: number } };
        const free = data.server_state?.free_space_on_disk;
        return typeof free === "number" ? free : null;
    } catch {
        return null;
    }
}

/**
 * Sum bytes still to be written by in-progress torrents (any category — the disk
 * is shared). free_space_on_disk only reflects data already written, so queued
 * downloads must be reserved against the free-space floor. Returns null on
 * failure so the caller skips the pass rather than accounting on bad data.
 */
async function fetchReservedBytes(config: Config): Promise<number | null> {
    const base = config.qbitUrl.replace(/\/+$/, "");
    try {
        const resp = await fetch(`${base}/api/v2/torrents/info`);
        if (!resp.ok) return null;
        const all = (await resp.json()) as QbitTorrent[];
        return all.filter((t) => t.progress < 1).reduce((sum, t) => sum + (t.amount_left ?? 0), 0);
    } catch {
        return null;
    }
}

/** Tag stamped on every auto-downloaded torrent (distinguishes RSS adds in qBit). */
const RSS_TAG = "rss";

/**
 * POST torrents/add for one .torrent URL into the configured category, tagged
 * `rss`. qBit fetches the passkey-bearing URL itself. qBit answers 200
 * "Ok."/"Fails." so a 2xx alone isn't success — treat a "Fails." body as failure.
 */
async function qbitAdd(config: Config, url: string): Promise<boolean> {
    const base = config.qbitUrl.replace(/\/+$/, "");
    const body = new URLSearchParams({
        urls: url,
        category: config.category,
        tags: RSS_TAG,
    });
    try {
        const resp = await fetch(`${base}/api/v2/torrents/add`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
        });
        if (!resp.ok) return false;
        const text = (await resp.text()).trim().toLowerCase();
        return text !== "fails.";
    } catch {
        return false;
    }
}

/** GET rss/items?withData=true → flattened article list across all feeds. */
async function fetchRssArticles(config: Config): Promise<RssArticle[] | null> {
    const base = config.qbitUrl.replace(/\/+$/, "");
    try {
        const resp = await fetch(`${base}/api/v2/rss/items?withData=true`);
        if (!resp.ok) return null;
        const feeds = (await resp.json()) as RssItems;
        return Object.values(feeds).flatMap((f) => f?.articles ?? []);
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
// We thank a torrent only as we remove it (live mode), not in bulk — so filelist
// sees at most one action per purged torrent. The log-based dedup below keeps a
// failed-delete retry from re-thanking, and the list verify self-heals any tid
// whose "thanked" entry has aged out of the 500-entry log.

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

type ThankOutcome = "thanked" | "error" | "rate-limited";

/**
 * Thank one tid, verifying membership before logging. A successful `add` already
 * returns the thankers list, so we only spend a second `list` request when `add`
 * didn't confirm us — this halves action spend against the hourly cap. Logs the
 * outcome; returns "rate-limited" so the caller stops thanking for the cycle.
 */
async function thankOne(tid: string, uid: string): Promise<ThankOutcome> {
    const add = await thanksPost("add", tid); // fire the thank (idempotent)
    if (!add.ok && add.rateLimited) return "rate-limited";

    // Fresh thank: `add` returns the list with us. Otherwise (already-thanked /
    // error) confirm membership with one `list` read.
    let inList = listHasUid(add, uid);
    let list: ThanksResult | null = null;
    if (!inList) {
        list = await thanksPost("list", tid);
        if (!list.ok && list.rateLimited) return "rate-limited";
        inList = listHasUid(list, uid);
    }

    if (inList) {
        await log("thanked", { tid });
        return "thanked";
    }
    const detail = !add.ok
        ? `add ${add.reason}`
        : add.data.err
          ? `add err: ${add.data.err}`
          : list && !list.ok
            ? `list ${list.reason}`
            : `not in list (add status=${add.data.status})`;
    await log("thanks-error", { tid, name: detail });
    return "error";
}

// ---- purge --------------------------------------------------------------

/** Seconds → compact qBit-style seed time, e.g. "2d 1h" / "3h 12m" / "5m". */
function fmtSeedTime(sec: number): string {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

/**
 * Delete every completed torrent in the category that trips either gate: qBit
 * `seeding_time` has reached the configured hours (the qBit WebUI renders this as
 * "seeded for 2d 1h"), OR `ratio` has reached maxRatio. Governed by dryRun: logs
 * `would-purge` and deletes nothing when on. As each torrent is removed (live
 * mode only) we say-thanks on filelist for it — best-effort, gated on being
 * logged in and the torrent's comment carrying a filelist id; never blocks the
 * delete.
 */
async function purgePass(config: Config): Promise<void> {
    const torrents = await fetchQbitTorrents(config);
    if (torrents === null) {
        await log("abort", { name: `qBit unreachable at ${config.qbitUrl}` });
        return;
    }

    const thresholdSec = Math.max(0, config.minSeedTimeHours) * 3600;
    const maxRatio = config.maxRatio;
    const isDue = (t: QbitTorrent): boolean =>
        (t.seeding_time ?? 0) >= thresholdSec || (t.ratio ?? 0) >= maxRatio;
    const due = torrents.filter(isDue);
    await log("info", {
        name: `purge: ${torrents.length} complete, ${due.length} due (seeded ≥ ${config.minSeedTimeHours}h or ratio ≥ ${maxRatio}), dryRun=${config.dryRun}`,
    });
    if (due.length === 0) return;

    // Thanks needs a filelist session; deletion is qBit-local and doesn't.
    const uid = await getUid();
    const alreadyThanked = await thankedTids();
    let thanksRateLimited = false;

    for (const t of due) {
        // Log both metrics + which gate tripped for context.
        const gate = (t.seeding_time ?? 0) >= thresholdSec ? "time" : "ratio";
        const human = `${fmtSeedTime(t.seeding_time ?? 0)} r${(t.ratio ?? 0).toFixed(2)} [${gate}]`;

        if (config.dryRun) {
            await log("would-purge", { name: t.name, seedTime: human, hash: t.hash });
            continue;
        }

        // Say-thanks as part of removal (best-effort). Skip silently when we
        // can't (no session, no filelist id, already thanked, or capped out).
        const tid = await qbitFilelistId(config, t.hash);
        if (tid && uid && !thanksRateLimited && !alreadyThanked.has(tid)) {
            const outcome = await thankOne(tid, uid);
            if (outcome === "rate-limited") {
                thanksRateLimited = true;
                await log("thanks-error", { tid, name: "rate-limited — backing off; resumes next cycle" });
            } else {
                alreadyThanked.add(tid);
            }
            await sleep(THANKS_DELAY_MS);
        }

        const ok = await qbitDelete(config, t.hash);
        if (ok) {
            await log("purged", { tid: tid ?? "-", name: t.name, seedTime: human, hash: t.hash });
        } else {
            await log("abort", { tid: tid ?? "-", name: `delete failed: ${t.name}`, seedTime: human, hash: t.hash });
        }
    }
}

// ---- RSS auto-download --------------------------------------------------

const FREELEECH_MARKER = "[freeleech]";

const SIZE_UNITS: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
};

/** Parse `Size: 40.66 GB` from an RSS description → bytes (binary units), or null. */
function parseSizeBytes(description: string): number | null {
    const m = description.match(/Size:\s*([\d.]+)\s*(TB|GB|MB|KB|B)\b/i);
    if (!m) return null;
    const value = parseFloat(m[1]);
    const unit = SIZE_UNITS[m[2].toUpperCase()];
    if (!Number.isFinite(value) || !unit) return null;
    return value * unit;
}

/** Extract the numeric filelist id from a download.php?id=N URL. */
function idFromDownloadUrl(url: string | undefined): string | null {
    if (!url) return null;
    const m = url.match(/[?&]id=(\d+)/);
    return m ? m[1] : null;
}

function fmtGb(bytes: number): string {
    return `${(bytes / GIB).toFixed(2)}GiB`;
}

/**
 * Pull newest-first [FreeLeech] torrents from qBit's parsed RSS and add them,
 * stopping each one that would drop projected free disk space below the floor
 * (a smaller/older entry may still fit, so skip — don't break). Reserves in-
 * progress downloads against actual free space. Governed by dryRun: logs
 * `would-download` and adds nothing when on. Dedup is persistent so a purged
 * torrent is never re-fetched.
 */
async function downloadPass(config: Config): Promise<void> {
    const articles = await fetchRssArticles(config);
    if (articles === null) {
        await log("abort", { name: "rss/items unavailable" });
        return;
    }

    const free = await fetchFreeSpace(config);
    const reserved = await fetchReservedBytes(config);
    if (free === null || reserved === null) {
        await log("abort", { name: "qBit disk-space query failed; skipping downloads" });
        return;
    }

    const doneSet = new Set(await storage.getDownloadedIds());
    const threshold = config.minFreeSpaceGb * GIB;

    // FreeLeech, not already downloaded, newest-first (LIFO).
    const candidates = articles
        .filter((a) => (a.title ?? "").toLowerCase().includes(FREELEECH_MARKER))
        .filter((a) => {
            const id = idFromDownloadUrl(a.torrentURL ?? a.link ?? a.id);
            return id !== null && !doneSet.has(id);
        })
        .sort((a, b) => Date.parse(b.date ?? "") - Date.parse(a.date ?? ""));

    let projected = free - reserved;
    await log("info", {
        name: `download: ${candidates.length} freeleech candidate(s), free=${fmtGb(free)} reserved=${fmtGb(reserved)} floor=${config.minFreeSpaceGb}GiB dryRun=${config.dryRun}`,
    });

    for (const a of candidates) {
        const url = a.torrentURL ?? a.link ?? a.id;
        const id = idFromDownloadUrl(url) as string; // filtered non-null above
        const name = (a.title ?? "").replace(/\s+/g, " ").trim();

        const size = parseSizeBytes(a.description ?? "");
        if (size === null) {
            await log("skip-nosize", { tid: id, name });
            continue;
        }

        if (projected - size < threshold) {
            await log("skip-nospace", { tid: id, name, seedTime: fmtGb(size) });
            continue; // keep evaluating older/smaller entries
        }

        projected -= size; // reserve in both modes so the sequence simulates correctly

        if (config.dryRun) {
            await log("would-download", { tid: id, name, seedTime: fmtGb(size) });
            continue;
        }

        if (await qbitAdd(config, url as string)) {
            await storage.addDownloadedId(id);
            await log("downloaded", { tid: id, name, seedTime: fmtGb(size) });
        } else {
            projected += size; // add failed → return the reserved space
            await log("abort", { tid: id, name: `add failed: ${name}` });
        }
    }
}

// ---- cycle --------------------------------------------------------------

/**
 * One qBit-local cycle: purge seed-time-expired torrents (which frees disk),
 * then run the RSS download pass to refill. Guarded against overlapping ticks.
 */
async function runCycle(): Promise<void> {
    if (running) return;
    running = true;
    try {
        const config = await storage.getConfig();
        // Rewrite Origin on qBit-bound requests to match qBit's host (CSRF).
        await syncQbitOriginRule(config);
        await purgePass(config);
        await downloadPass(config);
    } finally {
        running = false;
    }
}

// ---- wiring -------------------------------------------------------------

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void runCycle();
});

chrome.runtime.onInstalled.addListener(() => {
    void setupAlarm();
    void runCycle(); // immediate first pass (dry-run default, safe)
});

chrome.runtime.onStartup.addListener(() => {
    void setupAlarm();
});
