#!/usr/bin/env node
// CONTRACT §0 "Read-only tuning", §1.7.1 and §7 item 9: in v1.1 Nexum only READS
// AMD ADL tuning data. This check fails the build when any layer could write it.
//
// Rules (no allow-list):
//  1. No ADL entry point whose name contains the segment "_Set" (regex
//     /ADL2?_\w*_Set(?![a-z])\w*/) in nexum-agent/**/*.cs, src-tauri/src/**/*.rs or
//     src-frontend/**. "_Setting" (lowercase letter after "_Set") is a read and allowed.
//  2. Under nexum-agent/Tuning/**: no "_Set" segment at all (/_Set(?![a-z])/), so a
//     write entry point cannot be assembled from string pieces either.
//  3. Under nexum-agent/Tuning/**: DllImport / LibraryImport only in AdlNative.cs.
//  4. Under nexum-agent/Tuning/**: no GetProcAddress, NativeLibrary.*, function
//     pointers ("delegate* unmanaged"), Marshal.GetDelegateForFunctionPointer or
//     reflection-based invoke (System.Reflection, MethodInfo, InvokeMember, GetMethod().
//  5. AdlNative.cs: every ADL entry point it names is on the §1.7.1 whitelist, and its
//     imports are restricted to System32 (DefaultDllImportSearchPaths System32).
//  6. The ADL DLL name as a string literal ("atiadlxx...") appears only in
//     nexum-agent/Tuning/AdlNative.cs.
//
// Usage: node .github/scripts/check-tuning-readonly.mjs [repoRoot]
// Exit code 0 = clean, 1 = violation, 2 = script error.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.argv[2] ?? process.cwd();

// CONTRACT §1.7.1: the only ADL entry points Nexum may declare.
const WHITELIST = new Set([
  "ADL2_Main_Control_Create",
  "ADL2_Main_Control_Destroy",
  "ADL2_Adapter_NumberOfAdapters_Get",
  "ADL2_Adapter_AdapterInfo_Get",
  "ADL2_Adapter_Active_Get",
  "ADL2_Overdrive_Caps",
  "ADL2_Overdrive8_Init_Setting_Get",
  "ADL2_Overdrive8_Init_SettingX2_Get",
  "ADL2_Overdrive8_Current_Setting_Get",
  "ADL2_Overdrive8_Current_SettingX2_Get",
  "ADL2_OverdriveN_CountOfEvents_Get",
]);

const ADL_SET = /ADL2?_\w*_Set(?![a-z])\w*/;
const ANY_SET = /_Set(?![a-z])/;
const IMPORT = /\b(DllImport|LibraryImport)\b/;
const DYNAMIC = [
  ["GetProcAddress", /\bGetProcAddress\b/],
  ["NativeLibrary.", /\bNativeLibrary\s*\./],
  ["delegate* unmanaged", /delegate\s*\*\s*unmanaged/],
  ["Marshal.GetDelegateForFunctionPointer", /GetDelegateForFunctionPointer/],
  ["System.Reflection", /\bSystem\.Reflection\b/],
  ["MethodInfo", /\bMethodInfo\b/],
  ["InvokeMember", /\bInvokeMember\b/],
  ["GetMethod(", /\.GetMethod\s*\(/],
  ["DynamicMethod", /\bDynamicMethod\b/],
];

const TREES = [
  { dir: "nexum-agent", exts: [".cs"] },
  { dir: "src-tauri/src", exts: [".rs"] },
  { dir: "src-frontend", exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] },
];
const SKIP_DIRS = new Set(["node_modules", "bin", "obj", "target", "dist", ".git"]);
const TUNING_PREFIX = "nexum-agent/Tuning/";
const ADL_NATIVE = "nexum-agent/Tuning/AdlNative.cs";

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
const fail = (file, line, msg, text = "") => hits.push({ file, line, msg, text: text.trim().slice(0, 160) });

let files = 0;
let tuningFiles = 0;
for (const { dir, exts } of TREES) {
  const abs = join(root, dir);
  if (!existsSync(abs)) {
    console.error(`check-tuning-readonly: missing source tree ${dir}`);
    process.exit(2);
  }
  for (const file of walk(abs, exts)) {
    files++;
    const rel = toPosix(relative(root, file));
    const inTuning = rel.startsWith(TUNING_PREFIX);
    if (inTuning) tuningFiles++;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, i) => {
      const n = i + 1;
      const m = text.match(ADL_SET);
      if (m) fail(rel, n, `ADL write entry point "${m[0]}" (read-only tuning, CONTRACT §1.7.1)`, text);
      else if (inTuning && ANY_SET.test(text)) fail(rel, n, `"_Set" segment under Tuning/ (CONTRACT §1.7.1)`, text);
      if (/["']atiadlxx/i.test(text) && rel !== ADL_NATIVE) fail(rel, n, `the ADL library name is used outside ${ADL_NATIVE}`, text);
      if (!inTuning) return;
      if (IMPORT.test(text) && rel !== ADL_NATIVE) fail(rel, n, `native import outside AdlNative.cs (CONTRACT §1.7.1)`, text);
      for (const [label, re] of DYNAMIC) {
        if (re.test(text)) fail(rel, n, `"${label}" is forbidden under Tuning/ (CONTRACT §1.7.1)`, text);
      }
    });

    if (rel === ADL_NATIVE) {
      const src = lines.join("\n");
      // Every imported entry point: the EntryPoint = "..." of the attribute, else the name
      // of the extern / partial method that follows it.
      let pendingEntry = null;
      let imports = 0;
      for (const [i, text] of lines.entries()) {
        const ep = text.match(/\bEntryPoint\s*=\s*"([^"]+)"/);
        if (ep) pendingEntry = ep[1];
        const decl = text.match(/\bstatic\b[^(;=]*\b(?:extern|partial)\b[^(;=]*?\b([A-Za-z_]\w*)\s*\(/) ??
          text.match(/\b(?:extern|partial)\b[^(;=]*\bstatic\b[^(;=]*?\b([A-Za-z_]\w*)\s*\(/);
        if (decl) {
          imports++;
          const name = pendingEntry ?? decl[1];
          pendingEntry = null;
          if (!WHITELIST.has(name)) fail(rel, i + 1, `imported entry point "${name}" is not on the CONTRACT §1.7.1 whitelist`, text);
        }
      }
      if (pendingEntry) fail(rel, lines.length, `EntryPoint "${pendingEntry}" without a following method declaration`);
      if ((imports > 0 || IMPORT.test(src)) && !/DllImportSearchPath\.System32/.test(src)) {
        fail(rel, 1, "ADL imports must be restricted with [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]");
      }
    }
  }
}

if (hits.length) {
  console.log(`Read-only tuning check FAILED: ${hits.length} finding(s).`);
  for (const h of hits) console.log(`::error file=${h.file},line=${h.line}::${h.msg}${h.text ? `: ${h.text}` : ""}`);
  console.log("Nexum v1.1 must never write GPU tuning settings (CONTRACT §0, §1.7.1; ROADMAP Q5). There is no allow-list.");
  process.exit(1);
}
console.log(
  `Read-only tuning check OK: ${files} source files scanned (${tuningFiles} under nexum-agent/Tuning/` +
    `${tuningFiles === 0 ? ", which does not exist yet" : ""}).`,
);
