#!/usr/bin/env node
// MF-11 / CONTRACT §0, §2.15.1, §7 items 3 and 12: Nexum makes exactly one kind of
// network request, the update check (and the update download after a click), and all of
// that code lives in ONE file: src-tauri/src/updater.rs.
//
// This check fails when:
//   1. a network-client API appears in the Rust core, the C# sidecar or the frontend
//      outside the allow-list (.github/network-allowlist.txt);
//   2. the allow-list holds anything other than the updater module (whole file) and the
//      one line in src-tauri/src/lib.rs that registers the updater plugin;
//   3. the WebView could reach the updater plugin or the network by itself: a capability
//      grants an "updater:" permission, package.json lists @tauri-apps/plugin-updater,
//      or the CSP connect-src is wider than 'self' ipc: http://ipc.localhost;
//   4. the updater names a host other than this repository on github.com: a URL in a
//      string literal of updater.rs (outside tests), or an endpoint in tauri.conf.json.
//
// The frontend and the sidecar stay at zero: nothing there can be allow-listed.
//
// Usage: node .github/scripts/check-network.mjs [repoRoot]
// Exit code 0 = clean, 1 = finding, 2 = script error.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { lexRust, inRanges } from "./lib/rust-lex.mjs";

const root = process.argv[2] ?? process.cwd();
const ALLOWLIST = join(root, ".github", "network-allowlist.txt");

// The only file that may contain network code, and the only other file that may mention
// the updater plugin (one line: its registration). CONTRACT §2.15.1 rule 7.
const UPDATER_MODULE = "src-tauri/src/updater.rs";
const PLUGIN_HOST_FILE = "src-tauri/src/lib.rs";
const PLUGIN_REGISTRATION = /\btauri_plugin_updater::Builder\b/;
// The only place updates come from (CONTRACT §2.15.1 rule 1, UPDATE_REPO_URL in types.ts).
const UPDATE_REPO_URL = "https://github.com/captainRapipo/nexum";
const UPDATE_ENDPOINT_PREFIX = `${UPDATE_REPO_URL}/releases/download/updates/`;
// CONTRACT §2.15.1 rule 6.
const CSP_CONNECT_SRC = ["'self'", "ipc:", "http://ipc.localhost"];

// Each rule: a label (what is reported) and a regex. Leading boundaries keep
// identifiers such as "IHttpClientFactory" matching while "prefetch(" or the
// device-name text "hyper-v" do not.
const RULES = [
  ["reqwest", /\breqwest\b/],
  ["ureq", /\bureq\b/],
  ["hyper", /\bhyper(::|_util\b)|\bextern\s+crate\s+hyper\b/],
  ["HttpClient", /(?<![A-Za-z0-9_])HttpClient/],
  ["WebClient", /(?<![A-Za-z0-9_])WebClient/],
  ["HttpWebRequest", /(?<![A-Za-z0-9_])HttpWebRequest/],
  ["TcpClient", /(?<![A-Za-z0-9_])TcpClient/],
  ["TcpListener", /(?<![A-Za-z0-9_])TcpListener/],
  ["TcpStream", /(?<![A-Za-z0-9_])TcpStream/],
  ["UdpClient", /(?<![A-Za-z0-9_])UdpClient/],
  ["UdpSocket", /(?<![A-Za-z0-9_])UdpSocket/],
  ["HttpListener", /(?<![A-Za-z0-9_])HttpListener/],
  ["WebSocket", /(?<![A-Za-z0-9_])WebSocket/],
  ["XMLHttpRequest", /(?<![A-Za-z0-9_])XMLHttpRequest/],
  ["EventSource", /(?<![A-Za-z0-9_])EventSource\s*\(/],
  ["sendBeacon", /\bsendBeacon\b/],
  ["fetch(", /(?<![A-Za-z0-9_$])fetch\s*\(/],
  ["axios", /\baxios\b/],
  // [1.2] The updater plugin is a network client: using it anywhere but the updater
  // module is a finding (CONTRACT §7 item 12).
  ["tauri_plugin_updater", /\btauri_plugin_updater\b/],
  ["updater_builder", /\bupdater_builder\b/],
  ["plugin-updater (JS)", /@tauri-apps\/plugin-updater/],
];

// Scanned trees (CONTRACT §7.3) and the file types that count as source there.
const TREES = [
  { dir: "src-tauri/src", exts: [".rs"] },
  { dir: "nexum-agent", exts: [".cs"] },
  { dir: "src-frontend", exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".html"] },
];
const SKIP_DIRS = new Set(["node_modules", "bin", "obj", "target", "dist", ".git"]);

function toPosix(p) {
  return p.split(sep).join("/");
}

const problems = [];
function problem(file, line, text) {
  problems.push({ file, line, text });
}

// Allow-list entries: "<path>" (whole file) or "<path>:<line>".
function loadAllowlist() {
  const files = new Set();
  const lines = new Set();
  if (!existsSync(ALLOWLIST)) return { files, lines };
  readFileSync(ALLOWLIST, "utf8").split(/\r?\n/).forEach((raw, i) => {
    const entry = raw.replace(/#.*$/, "").trim();
    if (!entry) return;
    const m = entry.match(/^(.+?)(?::(\d+))?$/);
    const path = toPosix(m[1].trim());
    if (/\s/.test(path)) {
      problem(".github/network-allowlist.txt", i + 1, `malformed entry "${entry}" (expected "<path>" or "<path>:<line>")`);
      return;
    }
    if (m[2] === undefined) {
      if (path !== UPDATER_MODULE) {
        problem(".github/network-allowlist.txt", i + 1,
          `"${path}" cannot be allow-listed: the only whole-file entry is ${UPDATER_MODULE} (CONTRACT §7 item 12)`);
        return;
      }
      files.add(path);
    } else {
      if (path !== PLUGIN_HOST_FILE) {
        problem(".github/network-allowlist.txt", i + 1,
          `"${entry}" cannot be allow-listed: the only line entry is the updater plugin registration in ${PLUGIN_HOST_FILE} (CONTRACT §7 item 12)`);
        return;
      }
      lines.add(`${path}:${Number(m[2])}`);
    }
  });
  if (lines.size > 1) {
    problem(".github/network-allowlist.txt", 1,
      `${lines.size} line entries for ${PLUGIN_HOST_FILE}; exactly one line registers the updater plugin`);
  }
  return { files, lines };
}

function* walk(dir, exts) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full, exts);
    } else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) {
      yield full;
    }
  }
}

function readJson(rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    problem(rel, 1, `not valid JSON: ${e.message}`);
    return null;
  }
}

// 3. The WebView must not reach the updater plugin or the network by itself.
function checkWebViewSurface() {
  const capDir = join(root, "src-tauri", "capabilities");
  for (const file of walk(capDir, [".json", ".json5", ".toml"])) {
    const rel = toPosix(relative(root, file));
    readFileSync(file, "utf8").split(/\r?\n/).forEach((text, i) => {
      if (/["']updater:[^"']*["']/.test(text)) {
        problem(rel, i + 1, `capability grants an "updater:" permission; the plugin's own commands must stay unreachable from the WebView (CONTRACT §2.15.2): ${text.trim()}`);
      }
    });
  }

  const pkg = readJson("package.json");
  if (pkg) {
    for (const group of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      if (pkg[group] && "@tauri-apps/plugin-updater" in pkg[group]) {
        problem("package.json", 1, `${group} lists @tauri-apps/plugin-updater; the frontend has no updater or network API (CONTRACT §0)`);
      }
    }
  }

  const conf = readJson("src-tauri/tauri.conf.json");
  if (conf) {
    const csp = conf.app?.security?.csp;
    if (typeof csp === "string") {
      const directive = csp.split(";").map((d) => d.trim().split(/\s+/)).find((d) => d[0] === "connect-src");
      const got = directive ? directive.slice(1) : null;
      if (!got || got.length !== CSP_CONNECT_SRC.length || CSP_CONNECT_SRC.some((s) => !got.includes(s))) {
        problem("src-tauri/tauri.conf.json", 1,
          `CSP connect-src must stay "${CSP_CONNECT_SRC.join(" ")}" (CONTRACT §2.15.1 rule 6), found "${got ? got.join(" ") : "(none)"}"`);
      }
    } else {
      problem("src-tauri/tauri.conf.json", 1, "app.security.csp is missing or not a string");
    }
    // 4. Endpoints: this repository's "updates" release only.
    const endpoints = conf.plugins?.updater?.endpoints;
    if (endpoints !== undefined) {
      if (!Array.isArray(endpoints)) {
        problem("src-tauri/tauri.conf.json", 1, "plugins.updater.endpoints is not an array");
      } else {
        for (const url of endpoints) {
          if (typeof url !== "string" || !url.startsWith(UPDATE_ENDPOINT_PREFIX)) {
            problem("src-tauri/tauri.conf.json", 1,
              `updater endpoint "${url}" is not under ${UPDATE_ENDPOINT_PREFIX} (CONTRACT §2.15.2)`);
          }
        }
      }
    }
  }
}

// 4. No other host is named in the updater (string literals outside tests).
function checkUpdaterHosts() {
  const abs = join(root, UPDATER_MODULE);
  if (!existsSync(abs)) return false;
  const text = readFileSync(abs, "utf8");
  const { strings, tests } = lexRust(text);
  for (const lit of strings) {
    if (inRanges(lit.start, tests)) continue;
    for (const m of lit.value.matchAll(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>\\)]+/g)) {
      const url = m[0];
      if (url === UPDATE_REPO_URL || url.startsWith(`${UPDATE_REPO_URL}/`)) continue;
      problem(UPDATER_MODULE, lit.line,
        `the updater names "${url}"; the only host it may name is ${UPDATE_REPO_URL} (CONTRACT §2.15.1 rule 1)`);
    }
  }
  return true;
}

function main() {
  const allow = loadAllowlist();
  const usedLines = new Set();
  let files = 0;
  let updaterLines = 0;
  const registrationLines = [];

  for (const { dir, exts } of TREES) {
    const abs = join(root, dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      console.error(`check-network: missing source tree ${dir}`);
      process.exit(2);
    }
    for (const file of walk(abs, exts)) {
      files++;
      const rel = toPosix(relative(root, file));
      const wholeFile = allow.files.has(rel);
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((text, i) => {
        if (rel === PLUGIN_HOST_FILE && PLUGIN_REGISTRATION.test(text)) registrationLines.push(i + 1);
        for (const [label, re] of RULES) {
          if (!re.test(text)) continue;
          if (wholeFile) { updaterLines++; continue; }
          const key = `${rel}:${i + 1}`;
          if (allow.lines.has(key)) {
            usedLines.add(key);
            // The allow-listed line may be the plugin registration and nothing else.
            if (label !== "tauri_plugin_updater" || !PLUGIN_REGISTRATION.test(text)) {
              problem(rel, i + 1, `the allow-listed line is not the updater plugin registration (found "${label}"): ${text.trim().slice(0, 160)}`);
            }
            continue;
          }
          let hint = "";
          if (rel === PLUGIN_HOST_FILE && label === "tauri_plugin_updater" && PLUGIN_REGISTRATION.test(text)) {
            hint = ` — this is the plugin registration: list it as "${PLUGIN_HOST_FILE}:${i + 1}" in .github/network-allowlist.txt (the line number moved or was never listed)`;
          }
          problem(rel, i + 1, `network API "${label}" is not allowed here (MF-11)${hint}: ${text.trim().slice(0, 160)}`);
        }
      });
    }
  }

  for (const key of allow.lines) {
    if (usedLines.has(key)) continue;
    const where = registrationLines.length ? ` The registration is on line ${registrationLines.join(", ")} now.` : "";
    problem(".github/network-allowlist.txt", 1, `entry ${key} does not point at the updater plugin registration any more.${where}`);
  }
  if (registrationLines.length > 1) {
    problem(PLUGIN_HOST_FILE, registrationLines[1], `the updater plugin is registered on ${registrationLines.length} lines (${registrationLines.join(", ")}); CONTRACT §2.15.1 rule 7 allows one`);
  }

  checkWebViewSurface();
  const hasUpdater = checkUpdaterHosts();
  if (allow.files.has(UPDATER_MODULE) && !hasUpdater) {
    console.log(`::warning::${UPDATER_MODULE} is allow-listed but does not exist (yet).`);
  }

  if (problems.length) {
    console.log(`No-network check FAILED: ${problems.length} finding(s) in ${files} source files.`);
    for (const p of problems) console.log(`::error file=${p.file},line=${p.line}::${p.text}`);
    console.log(`Nexum's only network code is the updater in ${UPDATER_MODULE} (CONTRACT §2.15). Nothing else can be`);
    console.log("allow-listed; the frontend and the sidecar must stay free of network APIs.");
    process.exit(1);
  }
  console.log(
    `No-network check OK: ${files} source files, ${RULES.length} patterns. Allowed: ${UPDATER_MODULE}` +
      ` (${hasUpdater ? `${updaterLines} matching line(s)` : "not present"})` +
      `${allow.lines.size ? ` and ${[...allow.lines].join(", ")}` : ""}.`,
  );
}

main();
