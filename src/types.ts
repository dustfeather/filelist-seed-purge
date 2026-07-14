export interface Config {
    /** qBittorrent WebUI base URL (localhost auth-bypass expected). */
    qbitUrl: string;
    /** qBit category to scope torrents/info + matching. */
    category: string;
    /** When true, never call torrents/delete — only log `would-purge`. */
    dryRun: boolean;
}

export type LogAction =
    | "purged"
    | "would-purge"
    | "skip-nomatch"
    | "skip-ambiguous"
    | "skip-fetcherror"
    | "thanked"
    | "thanks-error"
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
}

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
