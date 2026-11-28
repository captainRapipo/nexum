// Minisign signature verification with Node's built-in crypto (no dependency), in the
// shapes the Tauri updater uses (CONTRACT §2.15.2):
//
//   public key   base64( "untrusted comment: minisign public key: <id>\n<base64 key>\n" )
//                key   = "Ed" + 8-byte key id + 32-byte Ed25519 public key
//   signature    base64( "untrusted comment: …\n<base64 sig>\ntrusted comment: …\n<base64 global sig>\n" )
//                sig   = "Ed" (the file itself is signed) or "ED" (its BLAKE2b-512 hash is
//                        signed) + 8-byte key id + 64-byte Ed25519 signature
//                global sig = Ed25519( sig bytes ‖ trusted comment )
//
// The trusted comment written by `tauri build` / `tauri signer sign` (tauri-cli 2.12+) is
// tab separated: "timestamp:<unix>\tfile:<name>\tversion:<app version>".
//
// This is the CI side of the check the app itself makes with the minisign-verify crate.
// It never touches a private key.

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function b64(text, what) {
  const clean = String(text).trim();
  if (!clean || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length % 4 !== 0) {
    throw new Error(`${what} is not base64`);
  }
  return Buffer.from(clean, "base64");
}

function keyIdHex(id) {
  // minisign prints the key id as a little-endian 64-bit number in upper-case hex.
  return Buffer.from(id).reverse().toString("hex").toUpperCase();
}

// The `pubkey` value of plugins.updater in tauri.conf.json.
export function decodePublicKey(tauriPubkey) {
  const text = b64(tauriPubkey, "the updater public key").toString("utf8");
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^untrusted comment:/i.test(l));
  if (!line) throw new Error("the updater public key has no key line");
  const raw = b64(line, "the updater public key line");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new Error("the updater public key is not a minisign Ed25519 public key");
  }
  const keyId = raw.subarray(2, 10);
  return { keyId, keyIdHex: keyIdHex(keyId), key: raw.subarray(10, 42) };
}

// The content of a .sig file / the `signature` value of an update manifest.
export function decodeSignature(tauriSignature) {
  const text = b64(tauriSignature, "the updater signature").toString("utf8");
  const lines = text.split(/\r?\n/);
  if (lines.length < 4 || !/^untrusted comment: /.test(lines[0]) || !/^trusted comment: /.test(lines[2])) {
    throw new Error("the updater signature is not a minisign signature (four lines expected)");
  }
  const raw = b64(lines[1], "the signature line");
  const alg = raw.subarray(0, 2).toString("latin1");
  if (raw.length !== 74 || (alg !== "Ed" && alg !== "ED")) {
    throw new Error("the signature line is not a minisign Ed25519 signature");
  }
  const globalSig = b64(lines[3], "the global signature line");
  if (globalSig.length !== 64) throw new Error("the global signature has the wrong length");
  const trustedComment = lines[2].slice("trusted comment: ".length);
  const keyId = raw.subarray(2, 10);
  return {
    prehashed: alg === "ED",
    keyId,
    keyIdHex: keyIdHex(keyId),
    sig: raw.subarray(10, 74),
    trustedComment,
    globalSig,
    fields: trustedFields(trustedComment),
  };
}

// "timestamp:1\tfile:a.exe\tversion:1.2.3" -> { timestamp: "1", file: "a.exe", version: "1.2.3" }
// The first occurrence of a key wins, as in the updater plugin.
export function trustedFields(trustedComment) {
  const fields = {};
  for (const part of String(trustedComment).split("\t")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const key = part.slice(0, i);
    if (!(key in fields)) fields[key] = part.slice(i + 1);
  }
  return fields;
}

function ed25519(publicKey32, message, signature64) {
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey32]), format: "der", type: "spki" });
  return edVerify(null, message, key, signature64);
}

// Throws unless `data` (a Buffer) carries a valid signature by `publicKey`, including
// the global signature that covers the trusted comment. Returns the decoded signature.
export function verifyMinisign(data, tauriSignature, tauriPubkey) {
  const pub = typeof tauriPubkey === "string" ? decodePublicKey(tauriPubkey) : tauriPubkey;
  const sig = typeof tauriSignature === "string" ? decodeSignature(tauriSignature) : tauriSignature;
  if (!sig.keyId.equals(pub.keyId)) {
    throw new Error(`signed with key ${sig.keyIdHex}, but the app trusts key ${pub.keyIdHex}`);
  }
  const message = sig.prehashed ? createHash("blake2b512").update(data).digest() : data;
  if (!ed25519(pub.key, message, sig.sig)) {
    throw new Error("the signature does not match the file");
  }
  const global = Buffer.concat([sig.sig, Buffer.from(sig.trustedComment, "utf8")]);
  if (!ed25519(pub.key, global, sig.globalSig)) {
    throw new Error("the trusted comment was changed after signing (global signature mismatch)");
  }
  return sig;
}
