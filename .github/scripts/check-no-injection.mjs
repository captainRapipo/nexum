#!/usr/bin/env node
// CONTRACT §0 "Anti-cheat stance" + the README / SECURITY.md "never" list ("Inject code
// into other processes"). Frame capture runs next to games protected by anti-cheat
// software, so Nexum must never use the APIs that inject code into, hook, or read/write
// the memory of another process, or post window messages to other processes.
//
// Fails on any of the APIs below in src-tauri/src/**, nexum-agent/**/*.cs and
// src-frontend/**. There is no allow-list: none of them has a legitimate use in Nexum.
// (OpenProcess is not listed: the Rust core uses it with query-only rights on Nexum's
// own processes. Code review covers that rule.)
//
// Usage: node .github/scripts/check-no-injection.mjs [repoRoot]
// Exit code 0 = clean, 1 = forbidden API found, 2 = script error.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.argv[2] ?? process.cwd();

const RULES = [
  // Code injection / remote execution
  ["CreateRemoteThread", /\bCreateRemoteThread(Ex)?\b/],
  ["NtCreateThreadEx / RtlCreateUserThread", /\b(NtCreateThreadEx|ZwCreateThreadEx|RtlCreateUserThread)\b/],
  ["QueueUserAPC", /\b(QueueUserAPC2?|NtQueueApcThread(Ex)?)\b/],
  ["SetThreadContext", /\b(SetThreadContext|Wow64SetThreadContext|NtSetContextThread)\b/],
  ["VirtualAllocEx / VirtualProtectEx", /\b(VirtualAllocEx|VirtualAlloc2|VirtualProtectEx|NtAllocateVirtualMemory|NtProtectVirtualMemory)\b/],
  ["Read/WriteProcessMemory", /\b(ReadProcessMemory|WriteProcessMemory|NtReadVirtualMemory|NtWriteVirtualMemory|Toolhelp32ReadProcessMemory)\b/],
  ["NtMapViewOfSection", /\b(NtMapViewOfSection|ZwMapViewOfSection|MapViewOfFile2|MapViewOfFileNuma2)\b/],
  ["DebugActiveProcess", /\b(DebugActiveProcess|DebugSetProcessKillOnExit)\b/],
  // Hooks
  ["SetWindowsHookEx", /\bSetWindowsHookEx[AW]?\b/],
  ["SetWinEventHook", /\bSetWinEventHook\b/],
  ["Detours / MinHook", /\b(DetourAttach|DetourTransactionBegin|MH_CreateHook|MH_EnableHook)\b/],
  // Window messages to other processes
  ["PostMessage / SendMessage", /\b(PostMessage[AW]?|SendMessage[AW]?|SendMessageTimeout[AW]?|SendNotifyMessage[AW]?|PostThreadMessage[AW]?|BroadcastSystemMessage(Ex)?[AW]?)\b/],
];

const TREES = [
  { dir: "src-tauri/src", exts: [".rs"] },
  { dir: "nexum-agent", exts: [".cs"] },
  { dir: "src-frontend", exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] },
];
const SKIP_DIRS = new Set(["node_modules", "bin", "obj", "target", "dist", ".git"]);
const toPosix = (p) => p.split(sep).join("/");

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

const hits = [];
let files = 0;
for (const { dir, exts } of TREES) {
  const abs = join(root, dir);
  if (!existsSync(abs)) {
    console.error(`check-no-injection: missing source tree ${dir}`);
    process.exit(2);
  }
  for (const file of walk(abs, exts)) {
    files++;
    const rel = toPosix(relative(root, file));
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((text, i) => {
        for (const [label, re] of RULES) {
          if (re.test(text)) hits.push({ rel, line: i + 1, label, text: text.trim().slice(0, 160) });
        }
      });
  }
}

if (hits.length) {
  console.log(`No-injection check FAILED: ${hits.length} forbidden API use(s).`);
  for (const h of hits) console.log(`::error file=${h.rel},line=${h.line}::"${h.label}" is forbidden (CONTRACT §0 anti-cheat stance): ${h.text}`);
  process.exit(1);
}
console.log(`No-injection check OK: ${files} source files scanned, ${RULES.length} API groups.`);
