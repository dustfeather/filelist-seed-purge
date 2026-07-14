// Offscreen document (Chrome only): the service worker has no DOM, so HTML
// parsing happens here and results are messaged back. On Firefox the background
// runs as an event page with its own DOM, so this document is never created —
// the worker calls the parsers inline instead.
import { OffscreenRequest, OffscreenResponse } from "../types";
import { parseSnatchDom, parseDetailsDom } from "../parse";

chrome.runtime.onMessage.addListener(
    (msg: OffscreenRequest, _sender, sendResponse: (r: OffscreenResponse) => void) => {
        if (msg?.target !== "offscreen") return;
        if (msg.kind === "snatch") {
            sendResponse({ kind: "snatch", rows: parseSnatchDom(msg.html) });
        } else if (msg.kind === "details") {
            sendResponse({ kind: "details", name: parseDetailsDom(msg.html) });
        }
        return true;
    },
);
