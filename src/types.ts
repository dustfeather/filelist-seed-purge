export interface Config {
    /** qBittorrent WebUI base URL (localhost auth-bypass expected). */
    qbitUrl: string;
    /** qBit category to scope torrents/info + matching; new downloads land here. */
    category: string;
    /** When true, never call torrents/delete or torrents/add — only log intent. */
    dryRun: boolean;
    /**
     * Floor for auto-download: a FreeLeech torrent is only added if doing so keeps
     * projected free disk space at or above this many GiB. Default 100.
     */
    minFreeSpaceGb: number;
}

export type LogAction =
    | "purged"
    | "would-purge"
    | "skip-nomatch"
    | "skip-ambiguous"
    | "skip-fetcherror"
    | "thanked"
    | "thanks-error"
    | "downloaded"
    | "would-download"
    | "skip-nospace"
    | "skip-nosize"
    | "abort"
    | "info";

export interface LogEntry {
    ts: number;
    tid: string;
    name: string;
    /** Elapsed "Seed Time" text from the snatchlist row (context for the log). */
    seedTime: string;
    action: LogAction;
    hash?: string;
}

export interface StorageData {
    config: Config;
    log: LogEntry[];
    /** Persistent dedup set of filelist download ids already auto-downloaded. */
    downloadedIds: string[];
}

/** One article from qBit's parsed RSS (`GET /api/v2/rss/items?withData=true`). */
export interface RssArticle {
    title: string;
    description: string;
    /** Passkey-bearing .torrent URL qBit fetches on add. */
    torrentURL?: string;
    link?: string;
    id?: string;
    /** RFC-822-ish pubDate, e.g. "05 Jul 2026 22:33:11 +0000". */
    date?: string;
}

/** Feed-name → its articles, as returned by rss/items. */
export type RssItems = Record<string, { articles: RssArticle[] }>;

export interface SnatchRow {
    tid: string;
    /** "Seed Time Left" value, e.g. "Done" or "---" or an elapsed string. */
    seedTimeLeft: string;
    /** "Seed Time" elapsed value (context only). */
    seedTime: string;
}

/** Worker → offscreen request to parse a filelist HTML page. */
export type OffscreenRequest =
    | { target: "offscreen"; kind: "snatch"; html: string }
    | { target: "offscreen"; kind: "details"; html: string };

/** offscreen → worker responses. `null` signals an unparseable/expired page. */
export type OffscreenResponse =
    | { kind: "snatch"; rows: SnatchRow[] | null }
    | { kind: "details"; name: string | null };
