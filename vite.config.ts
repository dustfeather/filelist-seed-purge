import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./src/manifest.json";

// Chrome-only, private/unpacked. No Firefox shim (unlike filelist-ext).
export default defineConfig({
    plugins: [crx({ manifest })],
    build: {
        outDir: "dist",
    },
});
