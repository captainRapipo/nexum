#!/usr/bin/env node
// CONTRACT §4.8 / §7.4 (ROADMAP MF-4, §6.6): banned words in user-visible UI copy.
//
// Parses every src-frontend/**/*.tsx file with the TypeScript compiler (already a
// devDependency) and checks the text people can see: JSX text, string and
// template literals, and string values of JSX attributes. Identifiers, import
// paths, className values, object keys and type-level strings are exempt, as are
// "code-like" literals with no spaces (event names, ids such as "purge-progress").
//
// A hit is allowed only when ".github/copy-allowlist.txt" lists it as
// "<path>:<line>" (one line) or "<path>:<line>:<word>" (one word on that line).
//
// Usage: node .github/scripts/check-copy.mjs [repoRoot]
// Exit code 0 = clean, 1 = banned word found, 2 = script error.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createRequire } from "node:module";

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
];

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

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") yield* walk(full);
    } else if (e.isFile() && e.name.endsWith(".tsx")) {
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

function main() {
  if (!existsSync(SRC)) {
    console.error("check-copy: src-frontend/ not found");
    process.exit(2);
  }
  const allow = loadAllowlist();
  const used = new Set();
  const hits = [];
  let files = 0;

  for (const file of walk(SRC)) {
    files++;
    const rel = toPosix(relative(root, file));
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

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
        const wkey = `${key}:${label.toLowerCase()}`;
        if (allow.lines.has(key)) { used.add(key); continue; }
        if (allow.words.has(wkey)) { used.add(wkey); continue; }
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
        if (!tpl || !isExemptPosition(tpl)) check(node, node.text, false);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  for (const k of [...allow.lines, ...allow.words]) {
    if (!used.has(k)) console.log(`::warning::copy-allowlist entry ${k} no longer matches a banned word (stale entry?)`);
  }

  if (hits.length) {
    console.log(`Copy-rules check FAILED: ${hits.length} banned word(s) in user-visible text (${files} .tsx files).`);
    for (const h of hits) {
      console.log(`::error file=${h.rel},line=${h.line}::banned word "${h.label}" in UI copy (CONTRACT §4.8): "${h.snippet}"`);
    }
    console.log('Replace per CONTRACT §4.8 ("Trash"/"junk" -> "Reclaimable caches", "Deep Purge" -> "Cache cleanup",');
    console.log('top-bar button "Clean caches (F9)"). Genuine exceptions go in .github/copy-allowlist.txt as path:line[:word].');
    process.exit(1);
  }
  console.log(`Copy-rules check OK: ${files} .tsx files, ${BANNED.length} banned terms, ${allow.lines.size + allow.words.size} allow-list entries.`);
}

main();
