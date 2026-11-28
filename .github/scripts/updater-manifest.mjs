#!/usr/bin/env node
// Release-pipeline helper for the in-app updater (CONTRACT §2.15.2, §7 item 14).
// No dependencies; it never sees the private key (signing is done by the Tauri CLI).
//
//   plan        decide what a build is: a release or not, its version, its update
//               channel, whether updater artifacts are made; writes the --config
//               override for `tauri build`
//   notes       print the plain-text release notes of a version from docs/CHANGELOG.md
//   verify-sig  check a local installer against its .sig and the public key in
//               tauri.conf.json (signature, key, signed file name, signed version)
//   make        build the update manifest for a PUBLISHED GitHub release: downloads the
//               installer and its .sig from the public URLs and verifies them first
//   rehearse    the same manifest from LOCAL files, for a build that is not published
//               (a rehearsal run, build.yml): every check except "the URL answers 200"
//   verify      check a manifest file: shape, version = tag, URL prefix, URL answers
//               200, signed file name and version, and the signature of the downloaded
//               bytes against the public key in tauri.conf.json
//   gate        decide whether a manifest may replace the one that is published now
//               (never replace a newer version with an older one)
//
// Usage: node .github/scripts/updater-manifest.mjs <command> [--name value …]
// Exit code 0 = ok, 1 = check failed, 2 = usage or script error, 3 = gate says "keep
// the published manifest".

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { decodePublicKey, decodeSignature, verifyMinisign } from "./lib/minisign.mjs";
import { parseSemver, compareSemver } from "./lib/semver.mjs";

// The app refuses anything larger (CONTRACT §2.15.5 step 1).
export const MAX_INSTALLER_BYTES = 300 * 1024 * 1024;
// Shown as text in the update dialog, cut by the app at this length (UPDATE_NOTES_MAX_CHARS).
export const MAX_NOTES_CHARS = 4000;
// Tags that make a release: vX.Y.Z (stable) and vX.Y.Z-preview.N (preview).
const TAG_RE = /^v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))(-preview\.(0|[1-9]\d*))?$/;
// `tauri signer sign --app-version` and the version field in build signatures.
const MIN_CLI_FOR_UPDATER = "2.12.0";
// Release notes are shown inside the app, so the UI copy rules apply (CONTRACT §4.8).
const NOTES_BANNED = [
  /\bagents?\b/i, /\bdeep[\s-]+purge\b/i, /\bpurge\b/i, /\bboost(s|ed|ing|er)?\b/i,
  /\boptimi[sz](e|es|ed|ing|er|ation)\b/i, /\bspeed[\s-]+up\b/i,
  /\bfree[\s-]+(up\s+)?(ram|memory)\b/i, /\bjunk\b/i, /\btrash\b/i, /\boutdated\b/i,
];

export class CheckError extends Error {}
const fail = (msg) => { throw new CheckError(msg); };

// ---------------------------------------------------------------- small helpers

export function installerName(version) {
  return `Nexum_${version}_x64-setup.exe`;
}

export function parseTag(tag) {
  const m = TAG_RE.exec(tag ?? "");
  if (!m) return null;
  const preview = Boolean(m[5]);
  return { version: `${m[1]}${m[5] ?? ""}`, base: m[1], preview, channel: preview ? "preview" : "stable" };
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    fail(`${what} not found: ${path}`);
  }
  try {
    return JSON.parse(stripBom(text));
  } catch (e) {
    fail(`${what} is not valid JSON (${path}): ${e.message}`);
  }
}

// plugins.updater of tauri.conf.json: the public key, and the download prefix derived
// from the stable endpoint (…/releases/download/updates/stable.json).
export function updaterConfig(conf) {
  const u = conf?.plugins?.updater;
  const pubkey = typeof u?.pubkey === "string" && u.pubkey.trim() ? u.pubkey.trim() : null;
  const endpoint = Array.isArray(u?.endpoints) ? u.endpoints.find((e) => typeof e === "string") : null;
  let prefix = null;
  if (endpoint) {
    const m = /^(https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/)updates\/[A-Za-z0-9._-]+\.json$/.exec(endpoint);
    if (m) prefix = m[1];
  }
  return { pubkey, endpoint: endpoint ?? null, prefix };
}

function requireUpdaterConfig(configPath) {
  const cfg = updaterConfig(readJson(configPath, "Tauri config"));
  if (!cfg.pubkey) fail(`${configPath} has no plugins.updater.pubkey`);
  if (!cfg.prefix) {
    fail(`${configPath}: plugins.updater.endpoints[0] must be https://github.com/<owner>/<repo>/releases/download/updates/<channel>.json`);
  }
  // Key rotation (docs/SIGNING.md): the one release that carries a NEW public key must
  // still be signed with the OLD key, because installed copies trust the old one. For
  // that release the repository variable NEXUM_UPDATE_VERIFY_PUBKEY holds the old public
  // key, and every check verifies against it instead of the key in the config.
  const override = (process.env.NEXUM_UPDATE_VERIFY_PUBKEY ?? "").trim();
  if (override && override !== cfg.pubkey) {
    let o;
    try {
      o = decodePublicKey(override);
    } catch (e) {
      fail(`NEXUM_UPDATE_VERIFY_PUBKEY: ${e.message}`);
    }
    console.log(`::notice::Key rotation: verifying against NEXUM_UPDATE_VERIFY_PUBKEY (key ${o.keyIdHex}), not the key in ${configPath} (key ${decodePublicKey(cfg.pubkey).keyIdHex}).`);
    cfg.pubkey = override;
  }
  return cfg;
}

// The "## X.Y.Z" section of the changelog as plain text (it is shown as text in the
// update dialog). Returns null when the section does not exist.
export function changelogNotes(markdown, version) {
  const base = parseSemver(version);
  if (!base) return null;
  const wanted = `${base.major}.${base.minor}.${base.patch}`;
  const lines = stripBom(markdown).split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+\[?v?(\d+\.\d+\.\d+)\]?(?:\s|$)/.exec(lines[i]);
    if (!m) continue;
    if (start >= 0) { end = i; break; }
    if (m[1] === wanted) start = i + 1;
  }
  if (start < 0) return null;
  const inline = (l) => l
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links keep their text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
  // Source lines are hard-wrapped; the dialog wraps by itself. So a bullet or a
  // paragraph becomes ONE line, and "### Heading" becomes a line of its own.
  const out = [];
  let open = false; // the last line of `out` can take a continuation
  for (const raw of lines.slice(start, end)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      open = false;
      continue;
    }
    const heading = /^#{3,}\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (heading) {
      out.push(inline(heading[1]));
      open = false;
    } else if (bullet) {
      out.push(`- ${inline(bullet[1])}`);
      open = true;
    } else if (open) {
      out[out.length - 1] += ` ${inline(line)}`;
    } else {
      out.push(inline(line));
      open = true;
    }
  }
  const text = out.join("\n").trim();
  return text || null;
}

export function checkNotes(notes) {
  const problems = [];
  if (notes.length > MAX_NOTES_CHARS) {
    problems.push(`the notes are ${notes.length} characters; the app shows at most ${MAX_NOTES_CHARS}`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(notes)) problems.push("the notes contain control characters");
  for (const re of NOTES_BANNED) {
    const m = re.exec(notes);
    if (m) problems.push(`the notes contain "${m[0]}", which the UI copy rules ban (CONTRACT §4.8); they are shown inside the app`);
  }
  return problems;
}

function notesFor(changelogPath, version, { required }) {
  if (!changelogPath || !existsSync(changelogPath)) {
    if (required) fail(`changelog not found: ${changelogPath}`);
    return null;
  }
  const notes = changelogNotes(readFileSync(changelogPath, "utf8"), version);
  if (!notes) {
    const b = parseSemver(version);
    if (required) fail(`${changelogPath} has no "## ${b.major}.${b.minor}.${b.patch}" section; the update dialog shows it as "what changed"`);
    return null;
  }
  const problems = checkNotes(notes);
  if (problems.length) fail(`${changelogPath}: ${problems.join("; ")}`);
  return notes;
}

// Signature + key + signed file name + signed version of an installer.
export function verifyInstaller({ data, signature, pubkey, version }) {
  let sig;
  try {
    sig = verifyMinisign(data, signature, pubkey);
  } catch (e) {
    fail(`updater signature check failed: ${e.message}`);
  }
  const want = installerName(version);
  if (sig.fields.file !== want) {
    fail(`the signature was made for a file named "${sig.fields.file ?? "(none)"}", expected "${want}" (the app binds the version to this name, CONTRACT §2.15.5 step 2)`);
  }
  if (sig.fields.version === undefined) {
    fail(`the signature carries no version (sign with tauri-cli >= ${MIN_CLI_FOR_UPDATER}; by hand: tauri signer sign --app-version ${version})`);
  }
  const signed = parseSemver(sig.fields.version.replace(/^v/, ""));
  if (!signed || compareSemver(signed, version) !== 0 || sig.fields.version.replace(/^v/, "") !== version) {
    fail(`the signature is bound to version "${sig.fields.version}", expected "${version}"`);
  }
  return sig;
}

export function buildManifest({ version, notes, pubDate, url, signature }) {
  const entry = { signature, url };
  const manifest = { version };
  if (notes) manifest.notes = notes;
  if (pubDate) manifest.pub_date = pubDate;
  // Newer plugin versions look up "<os>-<arch>-<installer>" first, older ones only
  // "<os>-<arch>": both keys carry the same entry (CONTRACT §2.15.2).
  manifest.platforms = { "windows-x86_64": { ...entry }, "windows-x86_64-nsis": { ...entry } };
  return manifest;
}

// Everything about a manifest that can be checked without the network.
export function checkManifestShape(manifest, { version, prefix }) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("the manifest is not a JSON object");
  if (manifest.version !== version) fail(`manifest version is "${manifest.version}", expected "${version}" (the tag without "v")`);
  if (!parseSemver(manifest.version)) fail(`manifest version "${manifest.version}" is not SemVer`);
  if (manifest.notes !== undefined) {
    if (typeof manifest.notes !== "string") fail("manifest notes is not a string");
    const problems = checkNotes(manifest.notes);
    if (problems.length) fail(problems.join("; "));
  }
  if (manifest.pub_date !== undefined) {
    if (typeof manifest.pub_date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(manifest.pub_date) ||
        Number.isNaN(Date.parse(manifest.pub_date))) {
      fail(`manifest pub_date "${manifest.pub_date}" is not RFC 3339`);
    }
  }
  const p = manifest.platforms;
  const keys = ["windows-x86_64", "windows-x86_64-nsis"];
  for (const k of keys) {
    if (!p || typeof p[k] !== "object" || p[k] === null) fail(`manifest has no platforms["${k}"]`);
    if (typeof p[k].url !== "string" || typeof p[k].signature !== "string") fail(`platforms["${k}"] needs "url" and "signature" strings`);
  }
  const extra = Object.keys(p).filter((k) => !keys.includes(k));
  if (extra.length) fail(`manifest has unexpected platforms: ${extra.join(", ")}`);
  if (p[keys[0]].url !== p[keys[1]].url || p[keys[0]].signature !== p[keys[1]].signature) {
    fail("the two platform entries differ; both must carry the same url and signature");
  }
  const url = p[keys[0]].url;
  if (!url.startsWith(prefix)) fail(`url "${url}" does not start with ${prefix}`);
  if (!url.startsWith(`${prefix}v${version}/`)) fail(`url "${url}" does not point into release v${version}`);
  if (/[\s?#]/.test(url) || url.includes("..")) fail(`url "${url}" has unexpected characters`);
  let sig;
  try {
    sig = decodeSignature(p[keys[0]].signature);
  } catch (e) {
    fail(`manifest signature: ${e.message}`);
  }
  if (sig.fields.file !== installerName(version)) {
    fail(`the signature's trusted comment names "${sig.fields.file ?? "(none)"}", expected file:${installerName(version)}`);
  }
  return { url, signature: p[keys[0]].signature };
}

async function download(url, what) {
  let res;
  try {
    res = await fetch(url, { redirect: "follow", headers: { "user-agent": "nexum-release-check" } });
  } catch (e) {
    fail(`${what}: could not download ${url}: ${e.cause?.message ?? e.message}`);
  }
  if (res.status !== 200) fail(`${what}: ${url} answered HTTP ${res.status}, expected 200 (is the release still a draft?)`);
  const announced = Number(res.headers.get("content-length") ?? 0);
  if (announced > MAX_INSTALLER_BYTES) fail(`${what}: ${announced} bytes; the app refuses downloads over ${MAX_INSTALLER_BYTES} bytes`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_INSTALLER_BYTES) fail(`${what}: ${data.length} bytes; the app refuses downloads over ${MAX_INSTALLER_BYTES} bytes`);
  return data;
}

function output(pairs) {
  const file = process.env.GITHUB_OUTPUT;
  const text = Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  if (file) appendFileSync(file, text);
  for (const [k, v] of Object.entries(pairs)) console.log(`  ${k} = ${v}`);
}

// ---------------------------------------------------------------- commands

// Pure part of `plan`, unit-tested by selftest.mjs.
export function planRelease({ ref, hasKey, confVersion, otherVersions = {}, hasPubkey, cliVersion }) {
  const none = { release: false, version: confVersion, channel: "", updater: false, warnings: [] };
  if (!ref || !ref.startsWith("refs/tags/v")) return none;
  const tag = ref.slice("refs/tags/".length);
  const t = parseTag(tag);
  if (!t) fail(`tag "${tag}" is not a release tag. Use vX.Y.Z for a stable release or vX.Y.Z-preview.N for a preview.`);
  if (t.base !== confVersion) {
    fail(`tag ${tag} does not match the committed version ${confVersion} in src-tauri/tauri.conf.json (bump package.json, tauri.conf.json and Cargo.toml first)`);
  }
  for (const [file, v] of Object.entries(otherVersions)) {
    if (v !== confVersion) fail(`${file} says version ${v ?? "(none)"}, src-tauri/tauri.conf.json says ${confVersion}; they must be equal for a release`);
  }
  const warnings = [];
  let updater = false;
  if (!hasKey) {
    warnings.push("TAURI_SIGNING_PRIVATE_KEY is not set: this build gets no update channel and no updater signature, so it cannot update from inside the app.");
  } else if (!hasPubkey) {
    fail("TAURI_SIGNING_PRIVATE_KEY is set but src-tauri/tauri.conf.json has no plugins.updater.pubkey");
  } else {
    if (cliVersion && compareSemver(cliVersion, MIN_CLI_FOR_UPDATER) < 0) {
      fail(`@tauri-apps/cli ${cliVersion} is older than ${MIN_CLI_FOR_UPDATER}; updater signatures must carry the app version`);
    }
    updater = true;
  }
  return { release: true, tag, version: t.version, channel: updater ? t.channel : "", updater, warnings };
}

function cmdPlan(a) {
  const configPath = a.config ?? "src-tauri/tauri.conf.json";
  const conf = readJson(configPath, "Tauri config");
  const others = {};
  if (existsSync("package.json")) others["package.json"] = readJson("package.json", "package.json").version;
  if (existsSync("src-tauri/Cargo.toml")) {
    const m = /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(readFileSync("src-tauri/Cargo.toml", "utf8"));
    others["src-tauri/Cargo.toml"] = m ? m[1] : null;
  }
  const plan = planRelease({
    ref: a.ref ?? process.env.GITHUB_REF ?? "",
    hasKey: a["has-key"] === "true",
    confVersion: conf.version,
    otherVersions: others,
    hasPubkey: Boolean(updaterConfig(conf).pubkey),
    cliVersion: a["cli-version"] || null,
  });
  for (const w of plan.warnings) console.log(`::warning::${w}`);
  let override = "";
  if (plan.release) {
    // The notes shown in the update dialog must exist before a release is built.
    notesFor(a.changelog ?? "docs/CHANGELOG.md", plan.version, { required: true });
    override = a.out ?? "build/tauri.release.conf.json";
    const patch = { version: plan.version };
    if (plan.updater) patch.bundle = { createUpdaterArtifacts: true };
    mkdirSync(dirname(override), { recursive: true });
    writeFileSync(override, JSON.stringify(patch, null, 2) + "\n");
    console.log(`Release build ${plan.tag}: version ${plan.version}, update channel ${plan.channel || "(none)"}, updater artifacts ${plan.updater ? "on" : "off"}.`);
    console.log(`Config override ${override}: ${JSON.stringify(patch)}`);
  } else {
    console.log(`Not a release tag: building ${plan.version} as committed, without an update channel.`);
  }
  output({
    release: plan.release,
    version: plan.version,
    channel: plan.channel,
    updater: plan.updater,
    installer: installerName(plan.version),
    config: override,
  });
}

function cmdNotes(a) {
  if (!a.version) fail("notes: --version is required");
  const notes = notesFor(a.changelog ?? "docs/CHANGELOG.md", a.version, { required: true });
  if (a.out) writeFileSync(a.out, notes + "\n");
  else process.stdout.write(notes + "\n");
}

function cmdVerifySig(a) {
  for (const k of ["file", "sig", "version"]) if (!a[k]) fail(`verify-sig: --${k} is required`);
  const cfg = requireUpdaterConfig(a.config ?? "src-tauri/tauri.conf.json");
  const data = readFileSync(a.file);
  const signature = readFileSync(a.sig, "utf8").trim();
  const sig = verifyInstaller({ data, signature, pubkey: cfg.pubkey, version: a.version });
  console.log(`Updater signature OK: ${basename(a.file)} (${data.length} bytes), key ${sig.keyIdHex}, ${sig.trustedComment.replace(/\t/g, " | ")}`);
}

export async function cmdMake(a) {
  for (const k of ["release", "out"]) if (!a[k]) fail(`make: --${k} is required`);
  const cfg = requireUpdaterConfig(a.config ?? "src-tauri/tauri.conf.json");
  const rel = readJson(a.release, "release description");
  const t = parseTag(rel.tag_name);
  if (!t) fail(`release tag "${rel.tag_name}" is not vX.Y.Z or vX.Y.Z-preview.N`);
  if (rel.draft !== false) fail(`release ${rel.tag_name} is a draft; a manifest may only point at a published release`);
  if (t.preview && rel.prerelease !== true) fail(`tag ${rel.tag_name} is a preview but the release is not marked as a pre-release`);
  if (!t.preview && rel.prerelease === true) {
    fail(`tag ${rel.tag_name} is a stable version but the release is marked as a pre-release; untick "pre-release" or use a -preview.N tag`);
  }
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const names = [installerName(t.version), installerName(t.version).replace(/\.exe$/, "-UNSIGNED-PREVIEW.exe")];
  const installer = assets.find((x) => names.includes(x.name));
  if (!installer) fail(`release ${rel.tag_name} has no installer asset (${names.join(" or ")})`);
  const sigAsset = assets.find((x) => x.name === `${installer.name}.sig`);
  if (!sigAsset) {
    fail(`release ${rel.tag_name} has no ${installer.name}.sig; it was built without the updater signing key and cannot be offered through in-app updates`);
  }
  const url = installer.browser_download_url;
  if (typeof url !== "string" || !url.startsWith(`${cfg.prefix}${rel.tag_name}/`)) {
    fail(`installer URL "${url}" is not under ${cfg.prefix}${rel.tag_name}/`);
  }
  const signature = (await download(sigAsset.browser_download_url, "signature")).toString("utf8").trim();
  const data = await download(url, "installer");
  const sig = verifyInstaller({ data, signature, pubkey: cfg.pubkey, version: t.version });
  const notes = notesFor(a.changelog ?? "docs/CHANGELOG.md", t.version, { required: false });
  if (!notes) console.log(`::warning::no changelog section for ${t.base}; the update dialog will show no notes`);
  const manifest = buildManifest({
    version: t.version,
    notes,
    pubDate: typeof rel.published_at === "string" ? rel.published_at : null,
    url,
    signature,
  });
  checkManifestShape(manifest, { version: t.version, prefix: cfg.prefix });
  mkdirSync(a.out, { recursive: true });
  const file = join(a.out, "manifest.json");
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Manifest for ${rel.tag_name}: ${installer.name} (${data.length} bytes), key ${sig.keyIdHex}, ${sig.trustedComment.replace(/\t/g, " | ")}`);
  // A stable release goes to both channels; a preview only to "preview".
  output({ version: t.version, channels: t.preview ? "preview" : "stable preview", manifest: file });
}

// A manifest for files that are not published: what `make` would write for this
// installer if it were the asset of release <tag>. Verifies the signature first.
export function rehearseManifest({ data, signature, pubkey, prefix, tag, notes, pubDate }) {
  const t = parseTag(tag);
  if (!t) fail(`"${tag}" is not a release tag (vX.Y.Z or vX.Y.Z-preview.N)`);
  const sig = verifyInstaller({ data, signature, pubkey, version: t.version });
  const manifest = buildManifest({
    version: t.version,
    notes,
    pubDate,
    url: `${prefix}${tag}/${installerName(t.version)}`,
    signature,
  });
  checkManifestShape(manifest, { version: t.version, prefix });
  return { manifest, sig, channels: t.preview ? "preview" : "stable preview" };
}

function cmdRehearse(a) {
  for (const k of ["file", "sig", "tag", "out"]) if (!a[k]) fail(`rehearse: --${k} is required`);
  const cfg = requireUpdaterConfig(a.config ?? "src-tauri/tauri.conf.json");
  const t = parseTag(a.tag);
  if (!t) fail(`"${a.tag}" is not a release tag (vX.Y.Z or vX.Y.Z-preview.N)`);
  const { manifest, sig, channels } = rehearseManifest({
    data: readFileSync(a.file),
    signature: readFileSync(a.sig, "utf8").trim(),
    pubkey: cfg.pubkey,
    prefix: cfg.prefix,
    tag: a.tag,
    notes: notesFor(a.changelog ?? "docs/CHANGELOG.md", t.version, { required: true }),
    pubDate: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  });
  mkdirSync(a.out, { recursive: true });
  const file = join(a.out, "manifest.json");
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Rehearsal manifest OK (NOT published; its url does not exist): version ${manifest.version}, channel(s) ${channels}, key ${sig.keyIdHex}, signed as ${sig.fields.file} / ${sig.fields.version}.`);
  output({ version: t.version, channels, manifest: file });
}

export async function cmdVerify(a) {
  for (const k of ["manifest", "tag"]) if (!a[k]) fail(`verify: --${k} is required`);
  const cfg = requireUpdaterConfig(a.config ?? "src-tauri/tauri.conf.json");
  const t = parseTag(a.tag);
  if (!t) fail(`"${a.tag}" is not a release tag`);
  const manifest = readJson(a.manifest, "manifest");
  const { url, signature } = checkManifestShape(manifest, { version: t.version, prefix: cfg.prefix });
  const data = await download(url, "installer");
  const sig = verifyInstaller({ data, signature, pubkey: cfg.pubkey, version: t.version });
  console.log(`Manifest OK: version ${manifest.version}, ${url} answers 200 (${data.length} bytes), signature verifies with key ${sig.keyIdHex}, signed as ${sig.fields.file} / ${sig.fields.version}.`);
}

// Never replace a published manifest with an older version (the app would ignore it
// anyway, but users on the newer line would stop being offered anything).
export function gateDecision(newVersion, currentText, force) {
  if (currentText === null) return { upload: true, reason: "no manifest is published yet" };
  let current;
  try {
    current = JSON.parse(currentText);
  } catch {
    return { upload: true, reason: "the published manifest is not valid JSON" };
  }
  if (!parseSemver(current?.version)) return { upload: true, reason: "the published manifest has no valid version" };
  const c = compareSemver(newVersion, current.version);
  if (c > 0) return { upload: true, reason: `${newVersion} is newer than the published ${current.version}` };
  if (c === 0) return { upload: true, reason: `${newVersion} is already published; refreshing it` };
  if (force) return { upload: true, reason: `FORCED: replacing ${current.version} with the older ${newVersion}` };
  return { upload: false, reason: `the published ${current.version} is newer than ${newVersion}; keeping it` };
}

function cmdGate(a) {
  for (const k of ["manifest"]) if (!a[k]) fail(`gate: --${k} is required`);
  const manifest = readJson(a.manifest, "manifest");
  const currentText = a.current && existsSync(a.current) ? readFileSync(a.current, "utf8") : null;
  const d = gateDecision(manifest.version, currentText && currentText.trim() ? currentText : null, a.force === "true");
  console.log(`${a.channel ?? "channel"}: ${d.upload ? "upload" : "skip"} — ${d.reason}`);
  // Exit code 3 = keep the published manifest (not an error).
  if (!d.upload) process.exit(3);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) fail(`unexpected argument "${k}"`);
    const eq = k.indexOf("=");
    if (eq > 0) out[k.slice(2, eq)] = k.slice(eq + 1);
    else out[k.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const commands = { plan: cmdPlan, notes: cmdNotes, "verify-sig": cmdVerifySig, make: cmdMake, rehearse: cmdRehearse, verify: cmdVerify, gate: cmdGate };
  if (!commands[cmd]) {
    console.error(`usage: updater-manifest.mjs <${Object.keys(commands).join("|")}> [--name value …]`);
    process.exit(2);
  }
  try {
    await commands[cmd](parseArgs(rest));
  } catch (e) {
    if (e instanceof CheckError) {
      console.log(`::error::${e.message}`);
      process.exit(1);
    }
    console.error(e);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
