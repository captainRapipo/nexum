// SemVer 2.0.0 parsing and precedence, for the release scripts (no dependency).
// Precedence is what the in-app updater uses to decide "strictly newer"
// (CONTRACT §2.15.2): 1.2.0-preview.1 < 1.2.0-preview.2 < 1.2.0 < 1.3.0-preview.1.

const RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseSemver(text) {
  if (typeof text !== "string") return null;
  const m = RE.exec(text.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".") : [],
    build: m[5] ?? null,
  };
}

// -1 when a < b, 0 when equal in precedence, 1 when a > b. Throws on invalid input.
export function compareSemver(a, b) {
  const x = typeof a === "string" ? parseSemver(a) : a;
  const y = typeof b === "string" ? parseSemver(b) : b;
  if (!x || !y) throw new Error(`not a SemVer version: ${!x ? a : b}`);
  for (const k of ["major", "minor", "patch"]) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  // A version without a pre-release part is greater than one with it.
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  const n = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < n; i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1; // fewer fields = lower
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      const d = BigInt(p) - BigInt(q);
      if (d !== 0n) return d < 0n ? -1 : 1;
    } else if (pn !== qn) {
      return pn ? -1 : 1; // numeric identifiers are lower than alphanumeric ones
    } else if (p !== q) {
      return p < q ? -1 : 1; // ASCII order
    }
  }
  return 0;
}
