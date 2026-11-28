#!/usr/bin/env node
// CONTRACT §7 item 15 / §4.9 "Done means": design hygiene of the light theme.
//
// Reports, per file, in src-frontend/**/*.{ts,tsx}:
//   1. hex colour literals outside components/ui/tones.ts, components/ui/echartsTheme.ts
//      and lib/mock.ts (colours come from the tokens in styles/nexum.css);
//   2. retired class patterns of the dark theme: text-slate-*, bg-white/…, border-white/…,
//      divide-white/…, bg-black/…, text-rose-*, text-purple-*, bg-purple-*,
//      shadow-[…rgba…], the legacy colour names (teal, gold, rose, cyan, silver, muted,
//      canvas-0, canvas-1) used as a utility, and "uppercase" + "tracking-[…]" labels;
//   3. every variant="primary" (crimson) button, so a reviewer can confirm there is one
//      per screen. This list is information, never a failure.
//
// REPORT-ONLY by default (exit code 0) while the 1.2 redesign is being integrated.
// With --enforce, findings of kind 1 and 2 fail the job (exit code 1).
//
// Usage: node .github/scripts/check-design.mjs [--enforce] [repoRoot]

import { readFileSync, readdirSync, existsSync, appendFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const args = process.argv.slice(2);
const enforce = args.includes("--enforce");
const root = args.find((a) => !a.startsWith("--")) ?? process.cwd();
const SRC = join(root, "src-frontend");

const HEX_EXEMPT = new Set([
  "src-frontend/components/ui/tones.ts",
  "src-frontend/components/ui/echartsTheme.ts",
  "src-frontend/lib/mock.ts",
]);
// #rgb, #rgba, #rrggbb, #rrggbbaa at the start of a value (after a quote, space, colon,
// comma or bracket), so "#12" in prose and URL fragments such as "…/page#add" do not match.
const HEX = /(?<=["'`\s:,(\[])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9A-Za-z_-])/g;

const UTIL = "(?:text|bg|border|ring|fill|stroke|from|to|via|divide|outline|decoration|shadow|accent|caret|placeholder)";
const RETIRED = [
  ["text-slate-*", /\btext-slate-\d{2,3}\b/g],
  ["bg-white/…", /\bbg-white\/(?:\[[^\]]+\]|\d+)/g],
  ["border-white/… or divide-white/…", /\b(?:border|divide)-white\/(?:\[[^\]]+\]|\d+)/g],
  ["bg-black/…", /\bbg-black\/(?:\[[^\]]+\]|\d+)/g],
  ["text-rose-*", /\btext-rose-\d{2,3}\b/g],
  ["text-purple-* or bg-purple-*", /\b(?:text|bg)-purple-\d{2,3}\b/g],
  ["shadow-[…rgba…]", /\bshadow-\[[^\]]*rgba[^\]]*\]/g],
  ["legacy colour name", new RegExp(`(?<![\\w-])${UTIL}-(?:teal|gold|rose|cyan|silver|muted|canvas-0|canvas-1)(?![\\w-])`, "g")],
];
const SHOUTING = /\buppercase\b[^\n]*\btracking-\[|\btracking-\[[^\n]*\buppercase\b/;
const PRIMARY = /\bvariant\s*=\s*(?:"primary"|'primary'|\{\s*["']primary["']\s*\})/g;

function toPosix(p) {
  return p.split(sep).join("/");
}
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") yield* walk(full);
    } else if (e.isFile() && /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) {
      yield full;
    }
  }
}

if (!existsSync(SRC)) {
  console.error("check-design: src-frontend/ not found");
  process.exit(2);
}

const findings = []; // { rel, line, kind, text }
const primaries = new Map(); // rel -> [lines]
let files = 0;

for (const file of walk(SRC)) {
  files++;
  const rel = toPosix(relative(root, file));
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((text, i) => {
    const code = text.replace(/^\s*(\/\/|\*|\/\*).*$/, ""); // whole-line comments
    if (!code) return;
    if (!HEX_EXEMPT.has(rel)) {
      for (const m of code.matchAll(HEX)) findings.push({ rel, line: i + 1, kind: "hex colour", text: m[0] });
    }
    for (const [kind, re] of RETIRED) {
      for (const m of code.matchAll(re)) findings.push({ rel, line: i + 1, kind, text: m[0] });
    }
    if (SHOUTING.test(code)) findings.push({ rel, line: i + 1, kind: "uppercase + tracking-[…] label", text: "uppercase tracking-[…]" });
    for (const _ of code.matchAll(PRIMARY)) {
      if (!primaries.has(rel)) primaries.set(rel, []);
      primaries.get(rel).push(i + 1);
    }
  });
}

const byKind = new Map();
const byFile = new Map();
for (const f of findings) {
  byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
  byFile.set(f.rel, (byFile.get(f.rel) ?? 0) + 1);
}

const out = [];
out.push(`### Design hygiene (CONTRACT §4.9, ${enforce ? "enforcing" : "report-only"})`);
out.push("");
out.push(`${findings.length} finding(s) in ${byFile.size} of ${files} files.`);
if (findings.length) {
  out.push("");
  out.push("| Pattern | Count |", "| --- | ---: |");
  for (const [k, n] of [...byKind].sort((a, b) => b[1] - a[1])) out.push(`| ${k} | ${n} |`);
  out.push("");
  out.push("| File | Count |", "| --- | ---: |");
  for (const [k, n] of [...byFile].sort((a, b) => b[1] - a[1])) out.push(`| \`${k}\` | ${n} |`);
}
out.push("");
out.push(`\`variant="primary"\` (crimson, one per screen): ${[...primaries.values()].reduce((s, l) => s + l.length, 0)} use(s) in ${primaries.size} file(s).`);
if (primaries.size) {
  out.push("");
  out.push("| File | Lines |", "| --- | --- |");
  for (const [k, l] of [...primaries].sort()) out.push(`| \`${k}\` | ${l.join(", ")} |`);
}
const report = out.join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");

if (findings.length) {
  const level = enforce ? "error" : "warning";
  // Keep the annotation count sane: one per file, with its first findings.
  for (const [rel] of byFile) {
    const mine = findings.filter((f) => f.rel === rel);
    const sample = mine.slice(0, 5).map((f) => `${f.line}: ${f.text}`).join("; ");
    console.log(`::${level} file=${rel},line=${mine[0].line}::${mine.length} design finding(s) (CONTRACT §4.9): ${sample}${mine.length > 5 ? "; …" : ""}`);
  }
  if (enforce) process.exit(1);
}
