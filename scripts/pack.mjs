// Package dist/ into the canonical release artifact the shared release-extension
// workflow collects: dist-artifacts/<base>-<target>-<tag>.<ext>
//   chrome -> .zip, firefox -> .xpi
// base/tag come from the workflow env (BASE/TAG); local dev falls back to the
// repo name and the manifest version.
import fs from "node:fs";
import { execSync } from "node:child_process";

const target = process.argv[2];
if (!target) {
    console.error("usage: node scripts/pack.mjs <target>");
    process.exit(1);
}

const ext = target === "firefox" ? "xpi" : "zip";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const manifest = JSON.parse(fs.readFileSync("src/manifest.json", "utf8"));
const base = process.env.BASE || pkg.name;
const tag = process.env.TAG || `v${manifest.version}`;

fs.mkdirSync("dist-artifacts", { recursive: true });
const out = `dist-artifacts/${base}-${target}-${tag}.${ext}`;
fs.rmSync(out, { force: true });
// -X strips extra file attributes for reproducible archives.
execSync(`cd dist && zip -r -X "../${out}" .`, { stdio: "inherit" });
console.log(`packed ${out}`);
