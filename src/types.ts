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
    /**
     * Delete trigger (either gate): a completed torrent in the category is purged
     * once qBit's `seeding_time` reaches this many hours (49h = 2d 1h). Default 49.
     */
    minSeedTimeHours: number;
    /**
     * Delete trigger (either gate): purge once qBit's `ratio` reaches this value.
     * OR'd with minSeedTimeHours — whichever trips first. Default 2.1.
     */
    maxRatio: number;
}

export type LogAction =
    | "purged"
    | "would-purge"
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
    /** Human-readable qBit seeding time at action time, e.g. "2d 1h" (context). */
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
