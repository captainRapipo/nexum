#!/usr/bin/env node
// MF-11 / CONTRACT §7.3: Nexum has no network code. This check fails on any
// network-client API in the Rust core, the C# sidecar or the frontend unless the
// exact file:line is listed in .github/network-allowlist.txt.
//
// Usage: node .github/scripts/check-network.mjs [repoRoot]
// Exit code 0 = clean, 1 = unapproved network API found, 2 = script error.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.argv[2] ?? process.cwd();
const ALLOWLIST = join(root, ".github", "network-allowlist.txt");

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

function loadAllowlist() {
  const allowed = new Set();
  if (!existsSync(ALLOWLIST)) return allowed;
  for (const raw of readFileSync(ALLOWLIST, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    // Format: <repo-relative path>:<line>   e.g. src-tauri/src/foo.rs:42
    const m = line.match(/^(.+):(\d+)$/);
    if (!m) {
      console.error(`network-allowlist: ignoring malformed entry "${line}" (expected path:line)`);
      continue;
    }
    allowed.add(`${toPosix(m[1].trim())}:${Number(m[2])}`);
  }
  return allowed;
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

function main() {
  const allowed = loadAllowlist();
  const usedAllow = new Set();
  const hits = [];
  let files = 0;

  for (const { dir, exts } of TREES) {
    const abs = join(root, dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      console.error(`check-network: missing source tree ${dir}`);
      process.exit(2);
    }
    for (const file of walk(abs, exts)) {
      files++;
      const rel = toPosix(relative(root, file));
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((text, i) => {
        for (const [label, re] of RULES) {
          if (!re.test(text)) continue;
          const key = `${rel}:${i + 1}`;
          if (allowed.has(key)) {
            usedAllow.add(key);
          } else {
            hits.push({ key, label, text: text.trim().slice(0, 160) });
          }
        }
      });
    }
  }

  for (const key of allowed) {
    if (!usedAllow.has(key)) {
      console.log(`::warning::network-allowlist entry ${key} no longer matches any network API (stale entry?)`);
    }
  }

  if (hits.length) {
    console.log(`MF-11 no-network check FAILED: ${hits.length} unapproved network API use(s) in ${files} files.`);
    for (const h of hits) {
      const [path, line] = [h.key.slice(0, h.key.lastIndexOf(":")), h.key.slice(h.key.lastIndexOf(":") + 1)];
      console.log(`::error file=${path},line=${line}::network API "${h.label}" is not allowed (MF-11): ${h.text}`);
    }
    console.log("Nexum must not contain network code. If a use is genuinely required, it needs owner approval and an");
    console.log("entry '<path>:<line>' in .github/network-allowlist.txt with a comment explaining why.");
    process.exit(1);
  }
  console.log(`MF-11 no-network check OK: ${files} source files scanned, ${RULES.length} patterns, ${allowed.size} allow-list entries.`);
}

main();
