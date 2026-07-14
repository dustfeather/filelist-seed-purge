// Offscreen document: the service worker has no DOM, so all HTML parsing
// (DOMParser + querySelector) happens here and results are messaged back.
import { OffscreenRequest, OffscreenResponse, SnatchRow } from "../types";

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

/** Extract a torrent's full name from its details page h4, or null. */
function parseDetailsName(html: string): string | null {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const h4 =
        doc.querySelector("#maincolumn > div:nth-child(1) > div.cblock-header > h4") ??
        doc.querySelector(".cblock-header h4");
    const name = h4?.textContent?.trim();
    return name && name.length > 0 ? name : null;
}

chrome.runtime.onMessage.addListener(
    (msg: OffscreenRequest, _sender, sendResponse: (r: OffscreenResponse) => void) => {
        if (msg?.target !== "offscreen") return;
        if (msg.kind === "snatch") {
            sendResponse({ kind: "snatch", rows: parseSnatchPage(msg.html) });
        } else if (msg.kind === "details") {
            sendResponse({ kind: "details", name: parseDetailsName(msg.html) });
        }
        return true;
    },
);
