import { Config, LogEntry, StorageData } from "./types";

/** Cap the in-storage log to the newest N entries (ring buffer). */
export const LOG_CAP = 500;

const DEFAULTS: StorageData = {
    config: {
        qbitUrl: "http://127.0.0.1:8181",
        category: "auto-download",
        dryRun: true,
    },
    log: [],
};

async function get<K extends keyof StorageData>(key: K): Promise<StorageData[K]> {
    const result = await chrome.storage.local.get(key);
    return (result[key] ?? DEFAULTS[key]) as StorageData[K];
}

async function set<K extends keyof StorageData>(key: K, value: StorageData[K]): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
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
};
