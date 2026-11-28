#!/usr/bin/env node
// CONTRACT §4.8 / §7 items 4 and 13 (ROADMAP MF-4, §6.6): banned words in user-visible
// UI copy.
//
// Pass 1 (frontend): parses every src-frontend/**/*.ts and *.tsx file with the
// TypeScript compiler (already a devDependency) and checks the text people can see:
// JSX text, string and template literals, and string values of JSX attributes.
// Identifiers, import paths, className values, object keys and type-level strings are
// exempt, as are "code-like" literals with no spaces (event names, ids such as
// "purge-progress", "agent-status", "agentOffline").
//
// Pass 2 (Rust core, since 1.2): every string literal in src-tauri/src/**/*.rs is
// checked for the word "agent" only, because Rust strings reach the screen as command
// errors, event payloads, the tray tooltip and saved reports. Exempt: #[cfg(test)] and
// #[test] items, comments, attributes, literals without spaces ("nexum-agent.exe",
// "agent-status"), arguments of logging and assertion macros (eprintln!, println!,
// format_args!, panic!, assert!, the log macros) and of .expect(…), and literals that
// are only compared with (starts_with, contains, ==, match arms). The sidecar
// (nexum-agent/**) is not scanned: it is frozen in 1.2 and its texts were reviewed by
// hand (CONTRACT §4.8.1).
//
// A hit is allowed only when ".github/copy-allowlist.txt" lists it as
// "<path>:<line>" (one line) or "<path>:<line>:<word>" (one word on that line).
// CONTRACT §7 item 13: there are no exceptions for "agent". An allow-list entry never
// excuses it, and a word entry naming it is itself reported as an error.
//
// Usage: node .github/scripts/check-copy.mjs [repoRoot]
// Exit code 0 = clean, 1 = banned word found, 2 = script error.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createRequire } from "node:module";
import { lexRust, inRanges, enclosingCalls } from "./lib/rust-lex.mjs";

const root = process.argv[2] ?? process.cwd();
const require = createRequire(join(process.cwd(), "package.json"));
let ts;
try {
  ts = require("typescript");
} catch {
  console.error("check-copy: the 'typescript' package is required (run npm ci first).");
  process.exit(2);
}

const SRC = join(root, "src-frontend");
const RUST_SRC = join(root, "src-tauri", "src");
const ALLOWLIST = join(root, ".github", "copy-allowlist.txt");

// CONTRACT §4.8: case-insensitive, whole word. "purge" is banned as a button/CTA
// or heading; a static check cannot tell a CTA from prose, so every visible use
// is reported and genuine prose is allow-listed in review.
const BANNED = [
  ["deep purge", /\bdeep[\s-]+purge\b/i],
  ["purge", /\bpurge\b/i],
  // Vendor feature names are not claims: AMD "Precision Boost" / "Core Performance
  // Boost", Intel "Turbo Boost", Microsoft "Delivery Optimization".
  ["boost", /(?<!\b(precision|performance|turbo)\s)\bboost(s|ed|ing|er)?\b/i],
  ["optimize", /(?<!\bdelivery\s)\boptimi[sz](e|es|ed|ing|er|ation)\b/i],
  ["speed up", /\bspeed[\s-]+up\b/i],
  ["free RAM", /\bfree[\s-]+(up\s+)?(ram|memory)\b/i],
  ["junk", /\bjunk\b/i],
  ["trash", /\btrash\b/i],
  ["outdated", /\boutdated\b/i],
  // CONTRACT §4.8 [NEW 1.2]: nothing a user can read says "agent" (also "agents",
  // "agent's"). \b keeps "reagent" out; identifiers such as "userAgent" have no space
  // and are exempt as code-like literals.
  ["agent", /\bagents?\b/i],
];
// The Rust pass checks this word only (CONTRACT §7 item 13).
const RUST_BANNED = BANNED.filter(([label]) => label === "agent");
// Words that can never be allow-listed.
const NEVER_ALLOWED = new Set(["agent"]);

// JSX attributes whose values are never shown to people.
const NON_VISIBLE_ATTRS = new Set([
  "className", "class", "id", "key", "style", "href", "src", "type", "role", "name",
  "htmlFor", "tabIndex", "target", "rel", "accent", "tone", "variant", "size", "icon",
  "data-testid", "viewBox", "d", "fill", "stroke", "xmlns", "autoComplete", "inputMode",
]);
// Call expressions whose string arguments are not UI copy.
const NON_VISIBLE_CALLS = new Set([
  "invoke", "listen", "emit", "once", "require", "import", "querySelector",
  "querySelectorAll", "getElementById", "addEventListener", "removeEventListener",
  "dispatchEvent", "CustomEvent", "Event", "getItem", "setItem", "removeItem",
  "includes", "startsWith", "endsWith", "indexOf", "split", "replace", "match", "test",
  "RegExp", "cn", "clsx", "classNames", "Symbol",
]);

// Rust macros whose string arguments go to stderr, stdout or a panic message, and
// methods whose string argument is a panic message or a pattern to compare with.
const RUST_LOG_MACROS = new Set([
  "eprintln", "eprint", "println", "print", "format_args", "dbg",
  "panic", "unreachable", "unimplemented", "todo",
  "assert", "assert_eq", "assert_ne", "debug_assert", "debug_assert_eq", "debug_assert_ne",
  "trace", "debug", "info", "warn", "error",
]);
const RUST_NON_VISIBLE_CALLS = new Set([
  "expect", "starts_with", "ends_with", "contains", "strip_prefix", "strip_suffix",
  "eq", "ne", "eq_ignore_ascii_case", "find", "rfind", "matches", "split", "rsplit",
  "split_once", "rsplit_once", "trim_start_matches", "trim_end_matches",
]);

function toPosix(p) {
  return p.split(sep).join("/");
}

function loadAllowlist() {
  const lines = new Set();
  const words = new Set();
  if (!existsSync(ALLOWLIST)) return { lines, words };
  for (const raw of readFileSync(ALLOWLIST, "utf8").split(/\r?\n/)) {
    const entry = raw.replace(/#.*$/, "").trim();
    if (!entry) continue;
    const m = entry.match(/^(.+?):(\d+)(?::(.+))?$/);
    if (!m) {
      console.error(`copy-allowlist: ignoring malformed entry "${entry}" (expected path:line or path:line:word)`);
      continue;
    }
    const key = `${toPosix(m[1].trim())}:${Number(m[2])}`;
    if (m[3]) words.add(`${key}:${m[3].trim().toLowerCase()}`);
    else lines.add(key);
  }
  return { lines, words };
}

function* walk(dir, exts) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "target") yield* walk(full, exts);
    } else if (e.isFile() && exts.some((x) => e.name.endsWith(x)) && !e.name.endsWith(".d.ts")) {
      yield full;
    }
  }
}

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

// True when a string literal is not user-visible because of where it sits.
function isExemptPosition(node) {
  let child = node;
  let p = node.parent;
  // Climb through wrappers that do not change visibility.
  while (
    p &&
    (ts.isParenthesizedExpression(p) || ts.isConditionalExpression(p) ||
      ts.isBinaryExpression(p) || ts.isAsExpression(p) || ts.isTemplateSpan(p) ||
      ts.isTemplateExpression(p) || ts.isJsxExpression(p) || ts.isArrayLiteralExpression(p) ||
      ts.isSatisfiesExpression?.(p))
  ) {
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      // Comparisons (x === "purge") are logic, not copy.
      if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken ||
        op === ts.SyntaxKind.InKeyword
      ) return true;
    }
    child = p;
    p = p.parent;
  }
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isLiteralTypeNode(p) || ts.isTypeNode(p)) return true;
  if (ts.isPropertyAssignment(p) && p.name === child) return true; // { "key": ... }
  if (ts.isElementAccessExpression(p) && p.argumentExpression === child) return true; // obj["key"]
  if (ts.isCaseClause(p)) return true; // case "purge":
  if (ts.isJsxAttribute(p)) {
    const n = p.name.getText();
    return NON_VISIBLE_ATTRS.has(n) || n.startsWith("on") && /^on[A-Z]/.test(n);
  }
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
    const name = calleeName(p.expression);
    if (name && NON_VISIBLE_CALLS.has(name)) return true;
  }
  return false;
}

// True when a Rust string literal cannot reach the screen because of where it sits.
function rustLiteralIsExempt(code, lit) {
  const chain = enclosingCalls(code, lit.start);
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i];
    if (c.attribute) return true; // #[serde(rename = "…")], #[doc = "…"]
    if (c.macro && RUST_LOG_MACROS.has(c.name)) return true;
    if (i === 0 && !c.macro && RUST_NON_VISIBLE_CALLS.has(c.name)) return true;
  }
  // Comparisons and match arms: x == "…", "…" == x, "…" => …, "…" | "…" => …
  const before = code.slice(Math.max(0, lit.start - 12), lit.start).trimEnd();
  const after = code.slice(lit.end, lit.end + 12).trimStart();
  if (/(==|!=)$/.test(before)) return true;
  if (/^(==|!=|=>)/.test(after)) return true;
  if (/^\|(?!\|)/.test(after) || /(?<!\|)\|$/.test(before)) return true;
  return false;
}

function main() {
  if (!existsSync(SRC)) {
    console.error("check-copy: src-frontend/ not found");
    process.exit(2);
  }
  const allow = loadAllowlist();
  const used = new Set();
  const hits = [];
  let files = 0;

  for (const w of allow.words) {
    const word = w.slice(w.lastIndexOf(":") + 1);
    if (NEVER_ALLOWED.has(word)) {
      hits.push({
        rel: ".github/copy-allowlist.txt", line: 1, label: word,
        snippet: `allow-list entry "${w}" is not permitted: "${word}" has no exceptions (CONTRACT §7 item 13)`,
      });
      used.add(w);
    }
  }
  const allowed = (key, label) => {
    const l = label.toLowerCase();
    if (NEVER_ALLOWED.has(l)) return false;
    const wkey = `${key}:${l}`;
    if (allow.lines.has(key)) { used.add(key); return true; }
    if (allow.words.has(wkey)) { used.add(wkey); return true; }
    return false;
  };

  // Pass 1: frontend (.ts and .tsx).
  for (const file of walk(SRC, [".ts", ".tsx"])) {
    files++;
    const rel = toPosix(relative(root, file));
    const text = readFileSync(file, "utf8");
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);

    const check = (node, value, codeLikeExempt) => {
      if (!value || !/[A-Za-z]/.test(value)) return;
      // Code-like literal (no whitespace): ids, event names, CSS tokens, paths.
      if (codeLikeExempt && !/\s/.test(value.trim())) return;
      for (const [label, re] of BANNED) {
        if (!re.test(value)) continue;
        // Report on the line where the word actually is.
        const start = node.getStart(sf);
        const raw = text.slice(start, node.getEnd());
        const idx = raw.search(re);
        const pos = idx >= 0 ? start + idx : start;
        const line = sf.getLineAndCharacterOfPosition(pos).line + 1;
        const key = `${rel}:${line}`;
        if (allowed(key, label)) continue;
        hits.push({ rel, line, label, snippet: value.replace(/\s+/g, " ").trim().slice(0, 120) });
        if (label === "deep purge") break; // do not double-report the inner "purge"
      }
    };

    const visit = (node) => {
      if (ts.isJsxText(node)) {
        check(node, node.text, false);
      } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (!isExemptPosition(node)) {
          // A literal directly as JSX attribute value or child expression is visible
          // even without spaces (e.g. title="Purge").
          const direct = node.parent && (ts.isJsxAttribute(node.parent) || ts.isJsxExpression(node.parent));
          check(node, node.text, !direct);
        }
      } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        const tpl = node.parent && (ts.isTemplateExpression(node.parent) ? node.parent : node.parent.parent);
        // A piece without whitespace is code-like (a path such as `…\purge-logs\${name}`).
        if (!tpl || !isExemptPosition(tpl)) check(node, node.text, true);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // Pass 2: Rust string literals (the word "agent" only).
  let rustFiles = 0;
  if (existsSync(RUST_SRC)) {
    for (const file of walk(RUST_SRC, [".rs"])) {
      rustFiles++;
      const rel = toPosix(relative(root, file));
      const text = readFileSync(file, "utf8");
      const { code, strings, tests } = lexRust(text);
      for (const lit of strings) {
        const value = lit.value;
        if (!value || !/\s/.test(value.trim())) continue; // code-like: no whitespace
        const matched = RUST_BANNED.filter(([, re]) => re.test(value));
        if (!matched.length) continue;
        if (inRanges(lit.start, tests)) continue;
        if (rustLiteralIsExempt(code, lit)) continue;
        for (const [label, re] of matched) {
          // Report on the line where the word is (literals can span lines).
          const raw = text.slice(lit.start, lit.end);
          const idx = raw.search(re);
          const line = lit.line + (idx > 0 ? raw.slice(0, idx).split("\n").length - 1 : 0);
          if (allowed(`${rel}:${line}`, label)) continue;
          hits.push({ rel, line, label, snippet: value.replace(/\s+/g, " ").trim().slice(0, 120) });
        }
      }
    }
  }

  for (const k of [...allow.lines, ...allow.words]) {
    if (!used.has(k)) console.log(`::warning::copy-allowlist entry ${k} no longer matches a banned word (stale entry?)`);
  }

  if (hits.length) {
    console.log(`Copy-rules check FAILED: ${hits.length} banned word(s) in user-visible text (${files} .ts/.tsx files, ${rustFiles} .rs files).`);
    for (const h of hits) {
      console.log(`::error file=${h.rel},line=${h.line}::banned word "${h.label}" in UI copy (CONTRACT §4.8): "${h.snippet}"`);
    }
    console.log('Replace per CONTRACT §4.8 ("Trash"/"junk" -> "Reclaimable caches", "Deep Purge" -> "Cache cleanup") and');
    console.log('§4.8.1 ("agent" -> say what the person sees: "Not available right now", "Sensors", "Nexum").');
    console.log('Genuine exceptions go in .github/copy-allowlist.txt as path:line[:word]. "agent" has no exceptions.');
    process.exit(1);
  }
  console.log(`Copy-rules check OK: ${files} .ts/.tsx files, ${rustFiles} .rs files, ${BANNED.length} banned terms, ${allow.lines.size + allow.words.size} allow-list entries.`);
}

main();
