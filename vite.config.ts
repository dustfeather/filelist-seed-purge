import { defineConfig, Plugin } from "vite";
import { crx } from "@crxjs/vite-plugin";
import fs from "node:fs";
import path from "node:path";
import manifest from "./src/manifest.json";

// Same dist/ dir for both browsers; the BROWSER env var picks the target.
// crxjs always emits a Chrome MV3 manifest (background.service_worker). For a
// Firefox build we rewrite the background into an event page
// (background.scripts), so neither browser logs a manifest warning. Default
// (unset/anything else) = Chrome, where crxjs's output is already correct and
// we leave it untouched.
const TARGET = process.env.BROWSER === "firefox" ? "firefox" : "chrome";

function crossBrowserManifest(): Plugin {
    return {
        name: "cross-browser-manifest",
        writeBundle(options) {
            if (TARGET !== "firefox") return; // Chrome: crxjs output is correct as-is.
            const outDir = options.dir ?? "dist";
            const manifestPath = path.resolve(outDir, "manifest.json");
            const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
            if (m.background?.service_worker) {
                m.background.scripts = [m.background.service_worker];
                delete m.background.service_worker; // Firefox MV3 has no service worker.
            }
            fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
        },
    };
}

export default defineConfig({
    plugins: [crx({ manifest }), crossBrowserManifest()],
    build: {
        outDir: "dist",
    },
});
