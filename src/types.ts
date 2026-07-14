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
