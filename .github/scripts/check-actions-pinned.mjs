#!/usr/bin/env node
// CONTRACT §7 item 14 (h): third-party actions are referenced by commit, never by a tag
// or branch that can be moved to different code. The build job holds the update signing
// key and the release jobs can write releases, so what runs there must not change
// without a commit in this repository.
//
// Passes:  uses: owner/action@<40 hex characters>   (a version comment after it is fine)
//          uses: actions/<name>@<anything>          (GitHub's own actions)
//          uses: ./.github/workflows/<file>         (workflows of this repository)
// Fails:   every other "uses:", including docker:// references.
//
// Usage: node .github/scripts/check-actions-pinned.mjs [repoRoot]
// Exit code 0 = clean, 1 = finding, 2 = script error.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? process.cwd();
const dir = join(root, ".github", "workflows");
if (!existsSync(dir)) {
  console.error("check-actions-pinned: no .github/workflows folder");
  process.exit(2);
}

const problems = [];
let files = 0;
let pinned = 0;
for (const name of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
  files++;
  const rel = `.github/workflows/${name}`;
  readFileSync(join(dir, name), "utf8").split(/\r?\n/).forEach((text, i) => {
    const m = /^\s*(?:-\s*)?uses:\s*(["']?)([^"'\s#]+)\1\s*(?:#.*)?$/.exec(text);
    if (!m) {
      if (/^\s*(?:-\s*)?uses:/.test(text)) problems.push({ rel, line: i + 1, text: `unreadable "uses:" line: ${text.trim()}` });
      return;
    }
    const ref = m[2];
    if (ref.startsWith("./")) return;
    if (/^actions\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._/-]+)?@[A-Za-z0-9._-]+$/.test(ref)) return;
    if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._/-]+)?@[0-9a-f]{40}$/.test(ref)) {
      pinned++;
      return;
    }
    problems.push({ rel, line: i + 1, text: `"${ref}" is not pinned to a commit: use owner/action@<40-character commit> with the version in a comment (CONTRACT §7 item 14 (h), docs/SIGNING.md "Pinned actions")` });
  });
}

if (problems.length) {
  console.log(`Pinned-actions check FAILED: ${problems.length} finding(s) in ${files} workflow file(s).`);
  for (const p of problems) console.log(`::error file=${p.rel},line=${p.line}::${p.text}`);
  process.exit(1);
}
console.log(`Pinned-actions check OK: ${files} workflow file(s), ${pinned} third-party reference(s), all pinned to a commit.`);
