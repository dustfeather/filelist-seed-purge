import { defineConfig, Plugin } from "vite";
import { crx } from "@crxjs/vite-plugin";
import fs from "node:fs";
import path from "node:path";
import manifest from "./src/manifest.json";

// A single dist/ ships to both Chrome and Firefox. Chrome uses
// background.service_worker; Firefox needs background.scripts. crxjs emits the
// worker form, so mirror it into scripts for Firefox (Firefox ignores the
// service_worker key, Chrome ignores scripts).
function firefoxBackgroundScripts(): Plugin {
    return {
        name: "firefox-background-scripts",
        writeBundle(options) {
            const outDir = options.dir ?? "dist";
            const manifestPath = path.resolve(outDir, "manifest.json");
            const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
            if (m.background?.service_worker && !m.background.scripts) {
                m.background.scripts = [m.background.service_worker];
                fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
            }
        },
    };
}

export default defineConfig({
    plugins: [crx({ manifest }), firefoxBackgroundScripts()],
    build: {
        outDir: "dist",
        rollupOptions: {
            // Offscreen doc is loaded at runtime via chrome.offscreen, not from
            // the manifest, so crxjs won't auto-detect it — declare it here.
            input: {
                offscreen: "src/offscreen/offscreen.html",
            },
        },
    },
});
