#!/usr/bin/env node
// Tests for the CI policy and release scripts themselves ("who checks the checkers").
// No network, no secrets: signatures are made with a throw-away key generated here, and
// the minisign verifier is checked against the published test vectors of the
// minisign-verify crate (the library the app uses).
//
// Usage: node .github/scripts/selftest.mjs      (from the repository root, after npm ci)
// Exit code 0 = all passed, 1 = a test failed.

import { generateKeyPairSync, sign as edSign, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lexRust, inRanges, enclosingCalls } from "./lib/rust-lex.mjs";
import { parseSemver, compareSemver } from "./lib/semver.mjs";
import { decodePublicKey, decodeSignature, verifyMinisign, trustedFields } from "./lib/minisign.mjs";
import {
  parseTag, installerName, changelogNotes, checkNotes, verifyInstaller, buildManifest,
  checkManifestShape, planRelease, gateDecision, updaterConfig, cmdMake, cmdVerify, CheckError,
  rehearseManifest, isRehearsalTag,
} from "./updater-manifest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
}
function eq(actual, expected, what = "value") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}
function ok(cond, what) {
  if (!cond) throw new Error(what);
}
function throws(fn, pattern, what) {
  try {
    fn();
  } catch (e) {
    if (pattern && !pattern.test(e.message)) throw new Error(`${what}: wrong error "${e.message}"`);
    return;
  }
  throw new Error(`${what}: expected an error`);
}

// ------------------------------------------------------------------ SemVer

test("semver: the preview channel order", () => {
  const order = ["1.1.0", "1.2.0-preview.1", "1.2.0-preview.2", "1.2.0-preview.10", "1.2.0", "1.2.1", "1.3.0-preview.1", "1.3.0"];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) {
      eq(compareSemver(order[i], order[j]), Math.sign(i - j), `${order[i]} vs ${order[j]}`);
    }
  }
});
test("semver: spec examples and rejects", () => {
  const spec = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let i = 1; i < spec.length; i++) eq(compareSemver(spec[i - 1], spec[i]), -1, `${spec[i - 1]} < ${spec[i]}`);
  eq(compareSemver("1.0.0+a", "1.0.0+b"), 0, "build metadata is ignored");
  for (const bad of ["1.2", "v1.2.0", "1.2.0-", "01.2.0", "1.2.0-preview.01", "", "1.2.0.0"]) {
    eq(parseSemver(bad), null, `"${bad}"`);
  }
});

// ------------------------------------------------------------------ minisign

// Test vectors from https://github.com/jedisct1/rust-minisign-verify (MIT): the 4 bytes
// "test", signed in legacy mode ("Ed") and in pre-hashed mode ("ED").
const VEC_PUB = Buffer.from("untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n").toString("base64");
const VEC_LEGACY = Buffer.from(
  "untrusted comment: signature from minisign secret key\n" +
  "RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\n" +
  "trusted comment: timestamp:1555779966\tfile:test\n" +
  "QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==\n").toString("base64");
const VEC_PREHASHED = Buffer.from(
  "untrusted comment: signature from minisign secret key\n" +
  "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\n" +
  "trusted comment: timestamp:1556193335\tfile:test\n" +
  "y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n").toString("base64");

test("minisign: published vectors verify (legacy and pre-hashed)", () => {
  const a = verifyMinisign(Buffer.from("test"), VEC_LEGACY, VEC_PUB);
  eq([a.prehashed, a.keyIdHex, a.fields.file], [false, "E7620F1842B4E81F", "test"]);
  const b = verifyMinisign(Buffer.from("test"), VEC_PREHASHED, VEC_PUB);
  eq([b.prehashed, b.fields.timestamp], [true, "1556193335"]);
});
test("minisign: changed file, changed trusted comment and wrong key are refused", () => {
  throws(() => verifyMinisign(Buffer.from("tesT"), VEC_PREHASHED, VEC_PUB), /does not match the file/, "changed file");
  const text = Buffer.from(VEC_PREHASHED, "base64").toString("utf8").replace("file:test", "file:tesu");
  throws(() => verifyMinisign(Buffer.from("test"), Buffer.from(text).toString("base64"), VEC_PUB), /trusted comment was changed/, "changed comment");
  const other = makeKey();
  throws(() => verifyMinisign(Buffer.from("test"), VEC_PREHASHED, other.pubkey), /signed with key/, "wrong key");
  throws(() => decodeSignature("not base64!"), /base64/, "garbage");
});
test("minisign: trusted comment fields", () => {
  eq(trustedFields("timestamp:1\tfile:Nexum_1.2.0_x64-setup.exe\tversion:1.2.0"), { timestamp: "1", file: "Nexum_1.2.0_x64-setup.exe", version: "1.2.0" });
  eq(trustedFields("timestamp:1\tfile:a-version:2.zip").version, undefined, "a version inside the file name is not a field");
});

// A throw-away signer that writes what `tauri signer sign` writes (CLI 2.12).
function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const keyId = randomBytes(8);
  const line = Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64");
  const pubkey = Buffer.from(`untrusted comment: minisign public key: TEST\n${line}\n`).toString("base64");
  const signFile = (data, trusted) => {
    const sig = edSign(null, createHash("blake2b512").update(data).digest(), privateKey);
    const global = edSign(null, Buffer.concat([sig, Buffer.from(trusted)]), privateKey);
    const sigLine = Buffer.concat([Buffer.from("ED"), keyId, sig]).toString("base64");
    return Buffer.from(`untrusted comment: signature from tauri secret key\n${sigLine}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`).toString("base64");
  };
  return { pubkey, signFile };
}

const PREFIX = "https://github.com/captainRapipo/nexum/releases/download/";
test("manifest: build, shape check and installer verification", () => {
  const key = makeKey();
  const data = randomBytes(4096);
  const version = "1.2.0-preview.3";
  const signature = key.signFile(data, `timestamp:1764273600\tfile:${installerName(version)}\tversion:${version}`);
  const sig = verifyInstaller({ data, signature, pubkey: key.pubkey, version });
  eq(sig.fields.version, version);
  const url = `${PREFIX}v${version}/Nexum_${version}_x64-setup-UNSIGNED-PREVIEW.exe`;
  const m = buildManifest({ version, notes: "- One\n- Two", pubDate: "2026-11-27T20:00:00Z", url, signature });
  eq(Object.keys(m), ["version", "notes", "pub_date", "platforms"]);
  eq(Object.keys(m.platforms), ["windows-x86_64", "windows-x86_64-nsis"]);
  eq(checkManifestShape(m, { version, prefix: PREFIX }).url, url);

  const bad = (patch, re, what) => throws(() => checkManifestShape({ ...structuredClone(m), ...patch }, { version, prefix: PREFIX }), re, what);
  bad({ version: "1.2.0" }, /expected "1\.2\.0-preview\.3"/, "wrong version");
  bad({ pub_date: "27 Nov 2026" }, /RFC 3339/, "bad date");
  bad({ notes: "The agent restarts faster." }, /copy rules/, "banned word in notes");
  const p = structuredClone(m.platforms);
  p["windows-x86_64"].url = `https://example.org/Nexum_${version}_x64-setup.exe`;
  bad({ platforms: p }, /differ|does not start with/, "foreign url");
  const q = structuredClone(m.platforms);
  for (const k of Object.keys(q)) q[k].url = `${PREFIX}v1.1.0/Nexum_1.1.0_x64-setup.exe`;
  bad({ platforms: q }, /does not point into release v1\.2\.0-preview\.3/, "url of another release");
  const r = structuredClone(m.platforms);
  delete r["windows-x86_64-nsis"];
  bad({ platforms: r }, /no platforms\["windows-x86_64-nsis"\]/, "missing platform key");
});
test("manifest: anti-rollback (an older signed installer under a newer version is refused)", () => {
  const key = makeKey();
  const data = randomBytes(1024);
  const old = key.signFile(data, `timestamp:1\tfile:${installerName("1.1.0")}\tversion:1.1.0`);
  throws(() => verifyInstaller({ data, signature: old, pubkey: key.pubkey, version: "1.2.0" }), /made for a file named "Nexum_1\.1\.0_x64-setup\.exe"/, "old file name");
  const noVersion = key.signFile(data, `timestamp:1\tfile:${installerName("1.2.0")}`);
  throws(() => verifyInstaller({ data, signature: noVersion, pubkey: key.pubkey, version: "1.2.0" }), /carries no version/, "no version field");
  const otherVersion = key.signFile(data, `timestamp:1\tfile:${installerName("1.2.0")}\tversion:1.1.0`);
  throws(() => verifyInstaller({ data, signature: otherVersion, pubkey: key.pubkey, version: "1.2.0" }), /bound to version "1\.1\.0"/, "version mismatch");
  const tampered = Buffer.from(data);
  tampered[10] ^= 1;
  const good = key.signFile(data, `timestamp:1\tfile:${installerName("1.2.0")}\tversion:1.2.0`);
  throws(() => verifyInstaller({ data: tampered, signature: good, pubkey: key.pubkey, version: "1.2.0" }), /signature check failed/, "tampered bytes");
});
test("manifest: a rehearsal (local files, nothing published) passes the same checks", () => {
  const key = makeKey();
  const data = randomBytes(2048);
  const version = "1.2.0-preview.0";
  const signature = key.signFile(data, `timestamp:1\tfile:${installerName(version)}\tversion:${version}`);
  const args ={ data, signature, pubkey: key.pubkey, prefix: PREFIX, notes: "- One", pubDate: "2026-11-28T10:00:00Z" };
  const r = rehearseManifest({ ...args, tag: `v${version}` });
  eq(r.channels, "preview");
  eq(r.manifest.version, version);
  eq(r.manifest.platforms["windows-x86_64-nsis"].url, `${PREFIX}v${version}/${installerName(version)}`);
  throws(() => rehearseManifest({ ...args, tag: "v1.3.0-preview.0" }), /made for a file named/, "signature of another version");
  throws(() => rehearseManifest({ ...args, tag: "main" }), /not a release tag/, "not a tag");
  // A rehearsal never produces the manifest of a version a release can have.
  for (const real of ["v1.2.0", "v1.2.0-preview.1"]) {
    const realVersion = real.slice(1);
    const realSig = key.signFile(data, `timestamp:1\tfile:${installerName(realVersion)}\tversion:${realVersion}`);
    throws(() => rehearseManifest({ ...args, signature: realSig, tag: real }), /must use a tag of the form vX\.Y\.Z-preview\.0/, `rehearsal of ${real}`);
  }
  const other = makeKey();
  throws(() => rehearseManifest({ ...args, pubkey: other.pubkey, tag: `v${version}` }), /signature check failed/, "wrong key");
});
test("manifest: the repository's public key is a minisign key", () => {
  const cfg = updaterConfig({ plugins: { updater: {
    pubkey: "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDNENzc3OERFRDk0Qzc0QTYKUldTbWRFelozbmgzUFh5azMwYUR6bjF6MUNIU3dGNVRsRURvQnVVclZEL1FUc05PMVF1eTJKU2UK",
    endpoints: ["https://github.com/captainRapipo/nexum/releases/download/updates/stable.json"],
  } } });
  eq(cfg.prefix, PREFIX);
  eq(decodePublicKey(cfg.pubkey).keyIdHex, "3D7778DED94C74A6");
  eq(updaterConfig({ plugins: { updater: { pubkey: "x", endpoints: ["https://example.org/updates/stable.json"] } } }).prefix, null);
});

// ------------------------------------------------------------------ plan, notes, gate

test("plan: tags, channels and the key", () => {
  const base = { confVersion: "1.2.0", otherVersions: { "package.json": "1.2.0" }, hasPubkey: true, cliVersion: "2.12.6" };
  eq(planRelease({ ...base, ref: "refs/heads/main", hasKey: true }).release, false);
  eq(planRelease({ ...base, ref: "refs/pull/7/merge", hasKey: false }).updater, false);
  const p = planRelease({ ...base, ref: "refs/tags/v1.2.0-preview.1", hasKey: true });
  eq([p.release, p.version, p.channel, p.updater], [true, "1.2.0-preview.1", "preview", true]);
  const s = planRelease({ ...base, ref: "refs/tags/v1.2.0", hasKey: true });
  eq([s.version, s.channel, s.updater], ["1.2.0", "stable", true]);
  const f = planRelease({ ...base, ref: "refs/tags/v1.2.0", hasKey: false });
  eq([f.release, f.version, f.channel, f.updater, f.warnings.length], [true, "1.2.0", "", false, 1]);
  throws(() => planRelease({ ...base, ref: "refs/tags/v1.2.0-rc1", hasKey: true }), /not a release tag/, "rc tag");
  throws(() => planRelease({ ...base, ref: "refs/tags/v1.3.0", hasKey: true }), /does not match the committed version/, "version drift");
  throws(() => planRelease({ ...base, otherVersions: { "src-tauri/Cargo.toml": "1.1.0" }, ref: "refs/tags/v1.2.0", hasKey: true }), /must be equal/, "Cargo.toml drift");
  throws(() => planRelease({ ...base, hasPubkey: false, ref: "refs/tags/v1.2.0", hasKey: true }), /no plugins\.updater\.pubkey/, "key without pubkey");
  throws(() => planRelease({ ...base, cliVersion: "2.9.3", ref: "refs/tags/v1.2.0", hasKey: true }), /older than 2\.12\.0/, "old CLI");
  eq(parseTag("v1.2.0-preview.1").base, "1.2.0");
  eq(parseTag("updates"), null);
});
test("plan: preview number 0 is for rehearsals, and rehearsals use nothing else", () => {
  const base = { confVersion: "1.2.0", otherVersions: { "package.json": "1.2.0" }, hasPubkey: true, cliVersion: "2.12.6", hasKey: true };
  eq([parseTag("v1.2.0-preview.0").previewNumber, parseTag("v1.2.0-preview.12").previewNumber, parseTag("v1.2.0").previewNumber], [0, 12, null]);
  eq([isRehearsalTag(parseTag("v1.2.0-preview.0")), isRehearsalTag(parseTag("v1.2.0-preview.1")), isRehearsalTag(parseTag("v1.2.0")), isRehearsalTag(null)], [true, false, false, false]);
  // A rehearsal: planned exactly like a preview tag, signed, on the preview channel.
  const r = planRelease({ ...base, ref: "refs/tags/v1.2.0-preview.0", rehearsal: true });
  eq([r.release, r.version, r.channel, r.updater], [true, "1.2.0-preview.0", "preview", true]);
  // The real update key never signs a version a release can have outside a release.
  throws(() => planRelease({ ...base, ref: "refs/tags/v1.2.0", rehearsal: true }), /must use a tag of the form vX\.Y\.Z-preview\.0/, "rehearsal of a stable version");
  throws(() => planRelease({ ...base, ref: "refs/tags/v1.2.0-preview.1", rehearsal: true }), /must use a tag of the form vX\.Y\.Z-preview\.0/, "rehearsal of a real preview");
  // And a pushed tag never uses the rehearsal number.
  throws(() => planRelease({ ...base, ref: "refs/tags/v1.2.0-preview.0" }), /kept for rehearsals/, "pushed preview.0 tag");
  // A branch build stays a branch build, rehearsal flag or not.
  eq(planRelease({ ...base, ref: "refs/heads/main", rehearsal: false }).release, false);
});
test("notes: changelog section as plain text", () => {
  const md = "# Changelog\n\n## 1.3.0\n\n- Later\n\n## 1.2.0\n\n### New\n\n- A **new** look, see [the docs](https://example.org).\n* Updates from `inside` the app.\n\n\n\n## 1.1.0\n\n- Old\n";
  eq(changelogNotes(md, "1.2.0-preview.4"), "New\n\n- A new look, see the docs.\n- Updates from inside the app.");
  eq(changelogNotes(md, "1.1.0"), "- Old");
  // Source lines are hard-wrapped; a bullet or a paragraph becomes one line.
  const wrapped = "## 2.0.0\n\n### Head\n\n- A bullet that is\n  wrapped in the source.\n- Next.\n\nA paragraph\nover two lines.\n";
  eq(changelogNotes(wrapped, "2.0.0"), "Head\n\n- A bullet that is wrapped in the source.\n- Next.\n\nA paragraph over two lines.");
  eq(changelogNotes(md, "9.9.9"), null);
  ok(checkNotes("Clean and tidy.").length === 0, "clean notes");
  ok(checkNotes("x".repeat(4001)).length === 1, "too long");
  ok(checkNotes("Restart the agent").length === 1, "banned word");
});
test("gate: never replace a newer manifest with an older one", () => {
  eq(gateDecision("1.2.0", null, false).upload, true);
  eq(gateDecision("1.2.0", '{"version":"1.2.0-preview.2"}', false).upload, true);
  eq(gateDecision("1.2.0", '{"version":"1.2.0"}', false).upload, true);
  eq(gateDecision("1.2.1", '{"version":"1.3.0-preview.1"}', false).upload, false);
  eq(gateDecision("1.2.1", '{"version":"1.3.0-preview.1"}', true).upload, true);
  eq(gateDecision("1.2.0", "<html>not json", false).upload, true);
});

// ------------------------------------------------------------------ Rust lexer

const RUST = `
// a comment with "agent" in it and an unbalanced quote "
/* block /* nested "agent" */ still comment */
const A: &str = "Hardware agent offline";
const B: &str = r#"raw "agent" text"#;
const C: char = '"';
fn f<'a>(x: &'a str) -> &'a str { x }
fn g() {
    eprintln!("[nexum] agent pipe error: {}", 1);
    let _ = format!("Could not talk to the hardware agent: {}", 2);
    if x.starts_with("Hardware agent starting") {}
    let e = '\\'';
    let s = "two \\
             lines agent";
}
#[cfg(test)]
mod tests {
    #[test]
    fn t() { assert_eq!(x, "the agent is down"); let y = "test agent text"; }
}
#[serde(rename = "agent status")]
struct S;
`;
test("rust lexer: strings, comments, chars, lifetimes, tests", () => {
  const { code, strings, tests } = lexRust(RUST);
  eq(code.length, RUST.length, "code keeps its length");
  ok(!/agent/.test(code.replace(/hardware_agent/g, "")), "no string or comment text is left in code");
  const values = strings.map((s) => s.value);
  ok(values.includes("Hardware agent offline"), "plain string");
  ok(values.includes('raw "agent" text'), "raw string");
  ok(values.includes("two lines agent"), "line continuation");
  ok(!values.some((v) => v.includes("comment")), "comments are not strings");
  eq(strings.find((s) => s.value === "Hardware agent offline").line, 4, "line number");
  const inTest = strings.filter((s) => inRanges(s.start, tests)).map((s) => s.value);
  eq(inTest, ["the agent is down", "test agent text"], "strings inside #[cfg(test)]");
  const call = (v) => enclosingCalls(code, strings.find((s) => s.value.startsWith(v)).start);
  eq(call("[nexum] agent pipe")[0], { name: "eprintln", macro: true, attribute: false });
  eq(call("Could not talk")[0], { name: "format", macro: true, attribute: false });
  eq(call("Hardware agent starting")[0].name, "starts_with");
  eq(call("agent status").at(-1).attribute, true);
  eq(call("Hardware agent offline"), []);
});

// ------------------------------------------------------------------ the checks, on fixtures

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "nexum-selftest-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}
function run(script, dir) {
  const r = spawnSync(process.execPath, [join(here, script), dir], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const CSP = "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'";
const UPDATER_CONF = { pubkey: "x", endpoints: ["https://github.com/captainRapipo/nexum/releases/download/updates/stable.json"], requireSignedVersion: true };
const confWith = (updater) => JSON.stringify({ app: { security: { csp: CSP } }, plugins: { updater } });
const UPDATER_RS = 'use tauri_plugin_updater::UpdaterExt;\nconst URL: &str = "https://github.com/captainRapipo/nexum/releases/download/updates/stable.json";\n';
const baseTree = (extra = {}) => ({
  "src-tauri/src/lib.rs": "mod updater;\nfn main() {\n    builder\n        .plugin(tauri_plugin_updater::Builder::new().build())\n        .run();\n}\n",
  "src-tauri/src/updater.rs": 'use tauri_plugin_updater::UpdaterExt;\nconst URL: &str = "https://github.com/captainRapipo/nexum/releases/download/updates/stable.json";\nfn c(app: &App) { let _ = app.updater_builder(); }\n#[cfg(test)]\nmod tests { const BAD: &str = "https://evil.example/x.exe"; }\n',
  "src-tauri/capabilities/default.json": '{ "permissions": ["core:default"] }',
  "src-tauri/tauri.conf.json": JSON.stringify({ app: { security: { csp: CSP } }, plugins: { updater: UPDATER_CONF } }),
  "nexum-agent/Program.cs": "class P {}\n",
  "src-frontend/main.ts": "export const x = 1;\n",
  "package.json": '{ "dependencies": {} }',
  ".github/network-allowlist.txt": "src-tauri/src/updater.rs\nsrc-tauri/src/lib.rs:4   # registration\n",
  ...extra,
});

test("check-network: the updater module and its registration line pass", () => {
  const dir = fixture(baseTree());
  const r = run("check-network.mjs", dir);
  rmSync(dir, { recursive: true, force: true });
  ok(r.code === 0, r.out);
});
test("check-network: switches spelled out as off, comments, strings and tests are not findings", () => {
  const dir = fixture(baseTree({
    "src-tauri/tauri.conf.json": confWith({ ...UPDATER_CONF, allowDowngrades: false, dangerousAcceptInvalidCerts: false }),
    "src-tauri/src/lib.rs": "mod updater;\nfn main() {\n    builder\n        .plugin(tauri_plugin_updater::Builder::new().build()) // the only line\n        .run();\n}\n",
    "src-tauri/src/updater.rs": UPDATER_RS +
      "// The plugin's own `install` and download_and_install are never called.\n" +
      'const T: &str = "never .install( or .pubkey( here";\n' +
      "fn install_dir() {}\nfn f() { install_dir(); provider().install_default(); }\n" +
      "#[cfg(test)]\nmod tests { fn t(u: Update) { let _ = u.install(vec![]); } }\n",
  }));
  const r = run("check-network.mjs", dir);
  rmSync(dir, { recursive: true, force: true });
  ok(r.code === 0, r.out);
});
const netCases = [
  ["a moved registration line", { ".github/network-allowlist.txt": "src-tauri/src/updater.rs\nsrc-tauri/src/lib.rs:3\n" }, /list it as "src-tauri\/src\/lib\.rs:4"/],
  ["another whole file in the allow-list", { ".github/network-allowlist.txt": "src-tauri/src/updater.rs\nsrc-tauri/src/lib.rs:4\nsrc-tauri/src/agent.rs\n" }, /cannot be allow-listed/],
  ["a frontend line in the allow-list", { ".github/network-allowlist.txt": "src-tauri/src/updater.rs\nsrc-tauri/src/lib.rs:4\nsrc-frontend/main.ts:1\n" }, /cannot be allow-listed/],
  ["fetch( in the frontend", { "src-frontend/main.ts": 'export const x = fetch("https://example.org");\n' }, /network API "fetch\("/],
  ["the updater plugin used outside the module", { "src-tauri/src/agent.rs": "use tauri_plugin_updater::UpdaterExt;\n" }, /network API "tauri_plugin_updater"/],
  ["an HTTP client in the sidecar", { "nexum-agent/Program.cs": "var c = new HttpClient();\n" }, /network API "HttpClient"/],
  ["an updater: permission", { "src-tauri/capabilities/default.json": '{ "permissions": ["core:default", "updater:default"] }' }, /"updater:" permission/],
  ["the JS updater package", { "package.json": '{ "dependencies": { "@tauri-apps/plugin-updater": "^2" } }' }, /@tauri-apps\/plugin-updater/],
  ["a wider CSP", { "src-tauri/tauri.conf.json": JSON.stringify({ app: { security: { csp: "connect-src 'self' ipc: http://ipc.localhost https://github.com" } } }) }, /CSP connect-src/],
  ["a foreign endpoint", { "src-tauri/tauri.conf.json": JSON.stringify({ app: { security: { csp: CSP } }, plugins: { updater: { endpoints: ["https://example.org/stable.json"] } } }) }, /updater endpoint/],
  ["an updater that does not require the signed version", { "src-tauri/tauri.conf.json": confWith({ pubkey: "x", endpoints: UPDATER_CONF.endpoints }) }, /requireSignedVersion must be true/],
  ["requireSignedVersion switched off", { "src-tauri/tauri.conf.json": confWith({ ...UPDATER_CONF, requireSignedVersion: false }) }, /requireSignedVersion must be true/],
  ["downgrades allowed in the configuration", { "src-tauri/tauri.conf.json": confWith({ ...UPDATER_CONF, allowDowngrades: true }) }, /allowDowngrades must stay off/],
  ["certificate checks switched off in the configuration", { "src-tauri/tauri.conf.json": confWith({ ...UPDATER_CONF, dangerousAcceptInvalidCerts: true }) }, /dangerousAcceptInvalidCerts must stay off/],
  ["plain http allowed in the configuration", { "src-tauri/tauri.conf.json": confWith({ ...UPDATER_CONF, dangerousInsecureTransportProtocol: true }) }, /dangerousInsecureTransportProtocol must stay off/],
  ["a kebab-case spelling of a switch", { "src-tauri/tauri.conf.json": confWith({ ...UPDATER_CONF, "allow-downgrades": true }) }, /plugins\.updater\.allow-downgrades is not allowed/],
  ["installer arguments in the configuration", { "src-tauri/tauri.conf.json": confWith({ ...UPDATER_CONF, windows: { installerArgs: ["/D=C:\\x"] } }) }, /plugins\.updater\.windows is not allowed/],
  ["another public key at registration", { "src-tauri/src/lib.rs": 'mod updater;\nfn main() {\n    builder\n        .plugin(tauri_plugin_updater::Builder::new().pubkey("other").build())\n        .run();\n}\n' }, /registered as \.plugin\(tauri_plugin_updater::Builder::new\(\)\.build\(\)\)/],
  ["the plugin's own installer", { "src-tauri/src/updater.rs": UPDATER_RS + "async fn i(u: Update) { let _ = u.download_and_install(|_, _| {}, || {}).await; }\n" }, /must not use "download_and_install"/],
  ["the plugin's install()", { "src-tauri/src/updater.rs": UPDATER_RS + "fn i(u: Update, b: Vec<u8>) { let _ = u.install(b); }\n" }, /must not use "\.install\("/],
  ["a public key set in code", { "src-tauri/src/updater.rs": UPDATER_RS + 'fn c(app: &App) { let _ = app.updater_builder().pubkey("other"); }\n' }, /must not use "\.pubkey\("/],
  ["certificate checks switched off in code", { "src-tauri/src/updater.rs": UPDATER_RS + "fn c(b: ClientBuilder) -> ClientBuilder { b.danger_accept_invalid_certs(true) }\n" }, /must not use "danger_accept_invalid_certs"/],
  ["another host in the updater", { "src-tauri/src/updater.rs": 'use tauri_plugin_updater::UpdaterExt;\nconst M: &str = "https://objects.githubusercontent.com/x";\n' }, /the only host it may name/],
];
for (const [name, patch, re] of netCases) {
  test(`check-network: fails on ${name}`, () => {
    const dir = fixture(baseTree(patch));
    const r = run("check-network.mjs", dir);
    rmSync(dir, { recursive: true, force: true });
    ok(r.code === 1, `exit ${r.code}: ${r.out}`);
    ok(re.test(r.out), `message not found in: ${r.out}`);
  });
}

const wf = (uses) => ({ ".github/workflows/build.yml": `jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v5\n${uses}` });
test("check-actions-pinned: commits, GitHub's own actions and local workflows pass", () => {
  const dir = fixture(wf('      - uses: Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0 # v2.9.3\n      - name: Sign\n        uses: "signpath/github-action-submit-signing-request@c92b958760219087e01f8d67a1669ed57afe2627"\n  manifest:\n    uses: ./.github/workflows/update-manifest.yml\n'));
  const r = run("check-actions-pinned.mjs", dir);
  rmSync(dir, { recursive: true, force: true });
  ok(r.code === 0 && /2 third-party reference\(s\)/.test(r.out), r.out);
});
for (const [name, line] of [
  ["a tag", "      - uses: Swatinem/rust-cache@v2\n"],
  ["a branch", "      - uses: dtolnay/rust-toolchain@stable\n"],
  ["a short commit", "      - uses: softprops/action-gh-release@8a0cd65\n"],
  ["a container image", "      - uses: docker://alpine:3\n"],
  ["a tag inside a named step", "      - name: Release\n        uses: softprops/action-gh-release@v3\n"],
]) {
  test(`check-actions-pinned: fails on ${name}`, () => {
    const dir = fixture(wf(line));
    const r = run("check-actions-pinned.mjs", dir);
    rmSync(dir, { recursive: true, force: true });
    ok(r.code === 1 && /not pinned to a commit/.test(r.out), `exit ${r.code}: ${r.out}`);
  });
}

const copyTree = (extra = {}) => ({
  "src-frontend/a.tsx": 'export const A = () => <p title="Not available right now">Sensors</p>;\nexport const id = "agent-status";\nif (x === "agent offline") {}\n',
  "src-frontend/lib/t.ts": 'export const EVENT = "agentOffline";\nexport type T = "agent offline";\nexport const ok = "Try again";\n',
  "src-tauri/src/a.rs": 'const N: &str = "nexum-agent.exe";\nfn f() { eprintln!("agent exited: {}", 1); let _ = x.contains("agent text"); }\n#[cfg(test)]\nmod t { const X: &str = "Hardware agent offline"; }\n',
  ...extra,
});
test("check-copy: identifiers, comparisons, logs and tests pass", () => {
  const dir = fixture(copyTree());
  const r = run("check-copy.mjs", dir);
  rmSync(dir, { recursive: true, force: true });
  ok(r.code === 0, r.out);
});
const copyCases = [
  ["JSX text", { "src-frontend/b.tsx": "export const B = () => <p>Agent offline</p>;\n" }, /b\.tsx,line=1::banned word "agent"/],
  ["a JSX attribute", { "src-frontend/b.tsx": 'export const B = () => <p title="Agent">x</p>;\n' }, /banned word "agent"/],
  ["a .ts string", { "src-frontend/lib/s.ts": 'export const T = "Restart the hardware agent";\n' }, /s\.ts,line=1::banned word "agent"/],
  ["an older banned word in .ts", { "src-frontend/lib/s.ts": 'export const T = "Empty the trash now";\n' }, /banned word "trash"/],
  ["a Rust error string", { "src-tauri/src/b.rs": 'fn f() -> Result<(), String> {\n    Err("Hardware agent is not running".to_string())\n}\n' }, /b\.rs,line=2::banned word "agent"/],
  ["a Rust format! payload", { "src-tauri/src/b.rs": 'fn f() { s.message = format!("Agent: {}", m); }\n' }, /banned word "agent"/],
  ["an allow-list entry for agent", { "src-frontend/b.tsx": "export const B = () => <p>Agent offline</p>;\n", ".github/copy-allowlist.txt": "src-frontend/b.tsx:1:agent\n" }, /has no exceptions/],
];
for (const [name, patch, re] of copyCases) {
  test(`check-copy: fails on ${name}`, () => {
    const dir = fixture(copyTree(patch));
    const r = run("check-copy.mjs", dir);
    rmSync(dir, { recursive: true, force: true });
    ok(r.code === 1, `exit ${r.code}: ${r.out}`);
    ok(re.test(r.out), `message not found in: ${r.out}`);
  });
}
test("check-copy: a line allow-list entry does not excuse agent", () => {
  const dir = fixture(copyTree({ "src-frontend/b.tsx": "export const B = () => <p>Agent junk</p>;\n", ".github/copy-allowlist.txt": "src-frontend/b.tsx:1\n" }));
  const r = run("check-copy.mjs", dir);
  rmSync(dir, { recursive: true, force: true });
  ok(r.code === 1 && /banned word "agent"/.test(r.out) && !/banned word "junk"/.test(r.out), r.out);
});

// ------------------------------------------------------------------ make + verify, with a fake GitHub

async function testAsync(name, fn) {
  const log = console.log;
  console.log = () => {};
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  } finally {
    console.log = log;
  }
}
async function rejects(promise, pattern, what) {
  try {
    await promise;
  } catch (e) {
    if (!(e instanceof CheckError)) throw new Error(`${what}: not a check failure: ${e.message}`);
    if (!pattern.test(e.message)) throw new Error(`${what}: wrong error "${e.message}"`);
    return;
  }
  throw new Error(`${what}: expected a failure`);
}

function releaseFixture({ tag, prerelease, draft = false, sign = true, tamper = false, suffix = "" }) {
  const version = tag.slice(1);
  const key = makeKey();
  const data = randomBytes(8192);
  const signature = key.signFile(data, `timestamp:1764273600\tfile:${installerName(version)}\tversion:${version}`);
  const asset = `Nexum_${version}_x64-setup${suffix}.exe`;
  const base = `${PREFIX}${tag}/`;
  const served = new Map([[`${base}${asset}`, tamper ? randomBytes(8192) : data]]);
  if (sign) served.set(`${base}${asset}.sig`, Buffer.from(signature));
  const dir = fixture({
    "tauri.conf.json": JSON.stringify({ plugins: { updater: { pubkey: key.pubkey, endpoints: [`${PREFIX}updates/stable.json`] } } }),
    "CHANGELOG.md": "# Changelog\n\n## 1.2.0\n\n- Something new.\n",
    "release.json": JSON.stringify({
      tag_name: tag, draft, prerelease, published_at: "2026-11-27T20:00:00Z",
      assets: [...served.keys()].map((u) => ({ name: u.slice(base.length), browser_download_url: u })),
    }),
  });
  const fetchImpl = async (url) => (served.has(String(url)) ? new Response(served.get(String(url))) : new Response("not found", { status: 404 }));
  const args = { release: join(dir, "release.json"), out: join(dir, "out"), config: join(dir, "tauri.conf.json"), changelog: join(dir, "CHANGELOG.md") };
  return { dir, args, fetchImpl, version };
}

const realFetch = globalThis.fetch;
const savedOutput = process.env.GITHUB_OUTPUT;
delete process.env.GITHUB_OUTPUT;
delete process.env.NEXUM_UPDATE_VERIFY_PUBKEY;

await testAsync("make + verify: a published preview becomes a manifest that verifies", async () => {
  const f = releaseFixture({ tag: "v1.2.0-preview.2", prerelease: true, suffix: "-UNSIGNED-PREVIEW" });
  globalThis.fetch = f.fetchImpl;
  await cmdMake(f.args);
  const manifest = JSON.parse(readFileSync(join(f.args.out, "manifest.json"), "utf8"));
  eq([manifest.version, manifest.notes, manifest.pub_date], ["1.2.0-preview.2", "- Something new.", "2026-11-27T20:00:00Z"]);
  ok(manifest.platforms["windows-x86_64-nsis"].url.endsWith("/v1.2.0-preview.2/Nexum_1.2.0-preview.2_x64-setup-UNSIGNED-PREVIEW.exe"), "url");
  await cmdVerify({ manifest: join(f.args.out, "manifest.json"), tag: "v1.2.0-preview.2", config: f.args.config });
  await rejects(cmdVerify({ manifest: join(f.args.out, "manifest.json"), tag: "v1.2.0", config: f.args.config }), /manifest version/, "wrong tag");
  rmSync(f.dir, { recursive: true, force: true });
});
await testAsync("make: a stable release goes to both channels", async () => {
  const f = releaseFixture({ tag: "v1.2.0", prerelease: false });
  globalThis.fetch = f.fetchImpl;
  const out = join(f.dir, "gh-output");
  process.env.GITHUB_OUTPUT = out;
  try {
    await cmdMake(f.args);
  } finally {
    delete process.env.GITHUB_OUTPUT;
  }
  ok(/^channels=stable preview$/m.test(readFileSync(out, "utf8")), "channels output");
  rmSync(f.dir, { recursive: true, force: true });
});
const makeFailures = [
  ["a draft", { tag: "v1.2.0", prerelease: false, draft: true }, /is a draft/],
  ["a preview tag that is not a pre-release", { tag: "v1.2.0-preview.1", prerelease: false, suffix: "-UNSIGNED-PREVIEW" }, /not marked as a pre-release/],
  ["a stable tag marked pre-release", { tag: "v1.2.0", prerelease: true }, /marked as a pre-release/],
  ["a release without .sig", { tag: "v1.2.0", prerelease: false, sign: false }, /has no Nexum_1\.2\.0_x64-setup\.exe\.sig/],
  ["an installer that was replaced after signing", { tag: "v1.2.0", prerelease: false, tamper: true }, /signature check failed/],
];
for (const [name, opts, re] of makeFailures) {
  await testAsync(`make: refuses ${name}`, async () => {
    const f = releaseFixture(opts);
    globalThis.fetch = f.fetchImpl;
    await rejects(cmdMake(f.args), re, name);
    ok(!existsSync(join(f.args.out, "manifest.json")), "no manifest may be written");
    rmSync(f.dir, { recursive: true, force: true });
  });
}
await testAsync("key rotation: NEXUM_UPDATE_VERIFY_PUBKEY replaces the config key for the checks", async () => {
  const f = releaseFixture({ tag: "v1.2.0", prerelease: false });
  globalThis.fetch = f.fetchImpl;
  const conf = JSON.parse(readFileSync(f.args.config, "utf8"));
  const oldKey = conf.plugins.updater.pubkey;
  conf.plugins.updater.pubkey = makeKey().pubkey; // the config already carries the NEW key
  writeFileSync(f.args.config, JSON.stringify(conf));
  await rejects(cmdMake(f.args), /signed with key/, "new key in config, old signature");
  process.env.NEXUM_UPDATE_VERIFY_PUBKEY = oldKey;
  try {
    await cmdMake(f.args);
  } finally {
    delete process.env.NEXUM_UPDATE_VERIFY_PUBKEY;
  }
  rmSync(f.dir, { recursive: true, force: true });
});

globalThis.fetch = realFetch;
if (savedOutput !== undefined) process.env.GITHUB_OUTPUT = savedOutput;

// ------------------------------------------------------------------ result

if (failures.length) {
  console.log(`CI script self-test FAILED: ${failures.length} of ${passed + failures.length}`);
  for (const f of failures) console.log(`::error::${f}`);
  process.exit(1);
}
console.log(`CI script self-test OK: ${passed} tests.`);
