import { Config, LogEntry, StorageData } from "./types";

/** Cap the in-storage log to the newest N entries (ring buffer). */
export const LOG_CAP = 500;

/** Cap the persistent dedup set so it can't grow without bound. */
export const DOWNLOADED_IDS_CAP = 1000;

const DEFAULTS: StorageData = {
    config: {
        qbitUrl: "http://127.0.0.1:8181",
        category: "auto-download",
        dryRun: true,
        minFreeSpaceGb: 100,
    },
    log: [],
    downloadedIds: [],
};

// Per-key backend. `config` lives in chrome.storage.sync so it survives an
// uninstall/reinstall and syncs across devices; `log` + `downloadedIds` stay in
// `local` because sync's quotas (102KB total / 8KB per item / 512 items / write
// rate) can't hold the 500-entry log or a large id set. Sync degrades to
// local-like behavior when the browser is signed out. Firefox honors
// storage.sync via browser_specific_settings.gecko.id (already in the manifest).
const AREA: { [K in keyof StorageData]: "local" | "sync" } = {
    config: "sync",
    log: "local",
    downloadedIds: "local",
};

async function get<K extends keyof StorageData>(key: K): Promise<StorageData[K]> {
    const result = await chrome.storage[AREA[key]].get(key);
    return (result[key] ?? DEFAULTS[key]) as StorageData[K];
}

async function set<K extends keyof StorageData>(key: K, value: StorageData[K]): Promise<void> {
    await chrome.storage[AREA[key]].set({ [key]: value });
}

export const storage = {
    getConfig: async (): Promise<Config> => ({ ...DEFAULTS.config, ...(await get("config")) }),
    setConfig: (v: Config) => set("config", v),

    getLog: () => get("log"),
    setLog: (v: LogEntry[]) => set("log", v),
    clearLog: () => set("log", []),

    /** Append one entry, newest-first, trimmed to LOG_CAP. */
    appendLog: async (entry: LogEntry): Promise<void> => {
        const log = await get("log");
        log.unshift(entry);
        if (log.length > LOG_CAP) log.length = LOG_CAP;
        await set("log", log);
    },

    getDownloadedIds: () => get("downloadedIds"),

    /** Record a download id (newest-first), trimmed to DOWNLOADED_IDS_CAP. */
    addDownloadedId: async (id: string): Promise<void> => {
        const ids = await get("downloadedIds");
        if (ids.includes(id)) return;
        ids.unshift(id);
        if (ids.length > DOWNLOADED_IDS_CAP) ids.length = DOWNLOADED_IDS_CAP;
        await set("downloadedIds", ids);
    },
};

export default storage;
