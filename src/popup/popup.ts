import "./popup.css";
import { storage } from "../storage";
import { Config, LogEntry } from "../types";

const qbitUrlEl = document.getElementById("qbitUrl") as HTMLInputElement;
const categoryEl = document.getElementById("category") as HTMLInputElement;
const minFreeSpaceGbEl = document.getElementById("minFreeSpaceGb") as HTMLInputElement;
const minSeedTimeHoursEl = document.getElementById("minSeedTimeHours") as HTMLInputElement;
const maxRatioEl = document.getElementById("maxRatio") as HTMLInputElement;
const dryRunEl = document.getElementById("dryRun") as HTMLInputElement;
const dryBadgeEl = document.getElementById("dryBadge") as HTMLSpanElement;
const clearBtn = document.getElementById("clearBtn") as HTMLButtonElement;
const logBody = document.getElementById("logBody") as HTMLTableSectionElement;
const logCountEl = document.getElementById("logCount") as HTMLSpanElement;

function fmtTime(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function renderBadge(dryRun: boolean): void {
    if (dryRun) {
        dryBadgeEl.textContent = "dry-run";
        dryBadgeEl.classList.remove("live");
    } else {
        dryBadgeEl.textContent = "LIVE";
        dryBadgeEl.classList.add("live");
    }
}

function renderConfig(config: Config): void {
    qbitUrlEl.value = config.qbitUrl;
    categoryEl.value = config.category;
    minFreeSpaceGbEl.value = String(config.minFreeSpaceGb);
    minSeedTimeHoursEl.value = String(config.minSeedTimeHours);
    maxRatioEl.value = String(config.maxRatio);
    dryRunEl.checked = config.dryRun;
    renderBadge(config.dryRun);
}

function renderLog(log: LogEntry[]): void {
    logCountEl.textContent = `${log.length} ${log.length === 1 ? "entry" : "entries"}`;
    logBody.replaceChildren();

    if (log.length === 0) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 3;
        td.className = "empty";
        td.textContent = "No activity yet.";
        tr.appendChild(td);
        logBody.appendChild(tr);
        return;
    }

    for (const entry of log) {
        const tr = document.createElement("tr");

        const tTime = document.createElement("td");
        tTime.textContent = fmtTime(entry.ts);

        const tAct = document.createElement("td");
        tAct.className = `act act-${entry.action}`;
        tAct.textContent = entry.action;

        const tName = document.createElement("td");
        tName.className = "name";
        tName.textContent = entry.name || (entry.tid !== "-" ? `tid ${entry.tid}` : "");

        tr.append(tTime, tAct, tName);
        logBody.appendChild(tr);
    }
}

async function saveConfig(): Promise<void> {
    const minFree = Number.parseInt(minFreeSpaceGbEl.value, 10);
    const minSeed = Number.parseInt(minSeedTimeHoursEl.value, 10);
    const ratio = Number.parseFloat(maxRatioEl.value);
    const config: Config = {
        qbitUrl: qbitUrlEl.value.trim() || "http://127.0.0.1:8181",
        category: categoryEl.value.trim() || "auto-download",
        dryRun: dryRunEl.checked,
        minFreeSpaceGb: Number.isFinite(minFree) && minFree >= 0 ? minFree : 100,
        minSeedTimeHours: Number.isFinite(minSeed) && minSeed >= 0 ? minSeed : 49,
        maxRatio: Number.isFinite(ratio) && ratio >= 0 ? ratio : 2.1,
    };
    await storage.setConfig(config);
    renderBadge(config.dryRun);
}

qbitUrlEl.addEventListener("change", saveConfig);
categoryEl.addEventListener("change", saveConfig);
minFreeSpaceGbEl.addEventListener("change", saveConfig);
minSeedTimeHoursEl.addEventListener("change", saveConfig);
maxRatioEl.addEventListener("change", saveConfig);
dryRunEl.addEventListener("change", saveConfig);

clearBtn.addEventListener("click", async () => {
    await storage.clearLog();
    renderLog([]);
});

// Live-refresh the log while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.log) {
        renderLog((changes.log.newValue ?? []) as LogEntry[]);
    }
});

(async () => {
    renderConfig(await storage.getConfig());
    renderLog(await storage.getLog());
})();
