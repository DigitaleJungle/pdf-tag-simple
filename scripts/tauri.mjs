// Wrapper around the Tauri CLI so "npm run tauri dev" always runs with
// src-tauri/tauri.dev.conf.json merged in. That config gives dev its own
// identifier, and therefore its own app data + WebView storage folders, so a
// dev session can never read or write the production library.
// Every other command (build, info, ...) is passed through unchanged.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cli = require.resolve("@tauri-apps/cli/tauri.js");

const args = process.argv.slice(2);
const hasConfig = args.some(a => a === "-c" || a === "--config" || a.startsWith("--config="));
if (args[0] === "dev" && !hasConfig) {
    args.push("--config", "src-tauri/tauri.dev.conf.json");
}

const result = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" });
process.exit(result.status ?? 1);
