// A small Rust lexer for the CI policy checks (check-copy.mjs, check-network.mjs).
// It is not a parser: it only separates string literals and comments from code, so a
// check can look at the text of string literals without being fooled by comments, by a
// quote inside a char literal ('"'), by raw strings (r#"…"#) or by lifetimes ('a).
//
// lexRust(text) returns:
//   code     the source with every comment, string body and char literal replaced by
//            spaces (same length, same line breaks), for structural scans
//   strings  [{ start, end, line, value }] for every string literal: offsets in the
//            source, 1-based line of the opening quote, and the decoded text
//   tests    [[start, end]] ranges covered by #[cfg(test)] / #[test] items
//
// Helpers: inRanges(pos, ranges), enclosingCalls(code, pos).

const IDENT = /[A-Za-z0-9_]/;

function decode(body, raw) {
  if (raw) return body;
  return body
    .replace(/\\\r?\n[ \t\r\n]*/g, "") // line continuation
    .replace(/\\u\{([0-9a-fA-F_]{1,8})\}/g, (_, h) => {
      const cp = parseInt(h.replace(/_/g, ""), 16);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : " ";
    })
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([nrt0])/g, " ")
    .replace(/\\(["'\\])/g, "$1");
}

export function lexRust(text) {
  const n = text.length;
  const out = text.split("");
  const strings = [];
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  // Line number of every offset, built once.
  const lineAt = new Uint32Array(n + 1);
  {
    let l = 1;
    for (let k = 0; k < n; k++) {
      lineAt[k] = l;
      if (text[k] === "\n") l++;
    }
    lineAt[n] = l;
  }

  let i = 0;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];

    // Line comment (also doc comments).
    if (c === "/" && d === "/") {
      let j = i;
      while (j < n && text[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    // Block comment; Rust block comments nest.
    if (c === "/" && d === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") { depth++; j += 2; }
        else if (text[j] === "*" && text[j + 1] === "/") { depth--; j += 2; }
        else j++;
      }
      blank(i, j);
      i = j;
      continue;
    }

    const startsToken = !(i > 0 && IDENT.test(text[i - 1]));

    // Raw strings: r"…", r#"…"#, br#"…"#, cr#"…"#. The prefix must not be the tail of an
    // identifier, and r#ident (a raw identifier) is not a string.
    if (startsToken && (c === "r" || ((c === "b" || c === "c") && d === "r"))) {
      let j = i + (c === "r" ? 1 : 2);
      let hashes = 0;
      while (text[j] === "#") { hashes++; j++; }
      if (text[j] === '"') {
        const bodyStart = j + 1;
        const close = '"' + "#".repeat(hashes);
        const endIdx = text.indexOf(close, bodyStart);
        const bodyEnd = endIdx < 0 ? n : endIdx;
        const end = endIdx < 0 ? n : endIdx + close.length;
        strings.push({ start: i, end, line: lineAt[i], value: decode(text.slice(bodyStart, bodyEnd), true) });
        blank(bodyStart, bodyEnd);
        i = end;
        continue;
      }
    }

    // Ordinary, byte and C strings.
    if (c === '"' || (startsToken && (c === "b" || c === "c") && d === '"')) {
      const open = c === '"' ? i : i + 1;
      let j = open + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const bodyEnd = Math.min(j, n);
      const end = Math.min(j + 1, n);
      strings.push({ start: i, end, line: lineAt[i], value: decode(text.slice(open + 1, bodyEnd), false) });
      blank(open + 1, bodyEnd);
      i = end;
      continue;
    }

    // Char literal or lifetime.
    if (c === "'") {
      if (d === "\\") {
        let j = i + 2;
        while (j < n && text[j] !== "'" && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
        blank(i + 1, Math.min(j, n));
        i = Math.min(j + 1, n);
        continue;
      }
      // 'x' (one UTF-16 unit) or an astral character (two units).
      let close = -1;
      if (text[i + 2] === "'") close = i + 2;
      else if (text[i + 3] === "'" && d >= "\ud800" && d <= "\udbff") close = i + 3;
      if (close > 0) {
        blank(i + 1, close);
        i = close + 1;
        continue;
      }
      i++; // a lifetime such as 'a or 'static
      continue;
    }
    i++;
  }

  const code = out.join("");
  return { code, strings, tests: testRanges(code) };
}

// Ranges of items behind #[cfg(test)], #[cfg(all(test, …))] or #[test].
function testRanges(code) {
  const ranges = [];
  const re = /#\s*\[\s*(?:cfg\s*\(\s*(?:all\s*\(\s*)?test\s*[,)]|test\s*\])/g;
  let m;
  while ((m = re.exec(code))) {
    if (ranges.length && m.index < ranges[ranges.length - 1][1]) continue; // nested
    // End of this attribute.
    let j = matchClose(code, code.indexOf("[", m.index), "[", "]");
    if (j < 0) break;
    j++;
    // Further attributes on the same item.
    for (;;) {
      while (j < code.length && /\s/.test(code[j])) j++;
      if (code[j] === "#" && /^#\s*\[/.test(code.slice(j, j + 8))) {
        const e = matchClose(code, code.indexOf("[", j), "[", "]");
        if (e < 0) break;
        j = e + 1;
      } else break;
    }
    // The item ends at the first ';' or at the brace block that starts first.
    let depth = 0;
    let end = code.length;
    for (let k = j; k < code.length; k++) {
      const ch = code[k];
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (depth === 0 && ch === ";") { end = k + 1; break; }
      else if (depth === 0 && ch === "{") {
        const e = matchClose(code, k, "{", "}");
        end = e < 0 ? code.length : e + 1;
        break;
      }
    }
    ranges.push([m.index, end]);
  }
  return ranges;
}

function matchClose(code, openIdx, open, close) {
  if (openIdx < 0) return -1;
  let depth = 0;
  for (let k = openIdx; k < code.length; k++) {
    if (code[k] === open) depth++;
    else if (code[k] === close) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

export function inRanges(pos, ranges) {
  for (const [a, b] of ranges) if (pos >= a && pos < b) return true;
  return false;
}

// The chain of calls a position is an argument of, innermost first, climbing through
// '(' and '[' and stopping at the first enclosing '{' (a block or a closure body).
// Each entry: { name, macro, attribute } where name is the callee ("eprintln",
// "starts_with", "format"), macro is true for name!(…) and attribute is true for #[…].
export function enclosingCalls(code, pos) {
  const chain = [];
  let depth = 0;
  for (let k = pos - 1; k >= 0; k--) {
    const ch = code[k];
    if (ch === ")" || ch === "]" || ch === "}") depth++;
    else if (ch === "(" || ch === "[" || ch === "{") {
      if (depth > 0) { depth--; continue; }
      if (ch === "{") break;
      // What stands before this opener?
      let e = k;
      while (e > 0 && /\s/.test(code[e - 1])) e--;
      if (ch === "[" && (code[e - 1] === "#" || (code[e - 1] === "!" && code[e - 2] === "#"))) {
        chain.push({ name: "", macro: false, attribute: true });
        break;
      }
      let macro = false;
      if (code[e - 1] === "!") { macro = true; e--; }
      let s = e;
      while (s > 0 && IDENT.test(code[s - 1])) s--;
      chain.push({ name: code.slice(s, e), macro, attribute: false });
    }
  }
  return chain;
}
