import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const ENVELOPE_PROPERTY = "_tahEncryptedState";
const ALGORITHM = "aes-256-gcm";
const VERSION = 1;
const MAX_STATE_BYTES = 8 * 1024 * 1024;

type EncryptedEnvelope = {
  [ENVELOPE_PROPERTY]: {
    algorithm: typeof ALGORITHM;
    ciphertext: string;
    iv: string;
    tag: string;
    version: typeof VERSION;
  };
};

function encryptionKey(): Buffer | null {
  const raw = process.env.TAH_STATE_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const value = raw.startsWith("base64:") ? raw.slice(7) : raw;
  const key = /^[a-f0-9]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64url");
  if (key.length !== 32) {
    throw new Error("TAH_STATE_ENCRYPTION_KEY must encode exactly 32 bytes");
  }
  return key;
}

function associatedData(purpose: string): Buffer {
  return Buffer.from(`traffic-armour:${purpose}:v${VERSION}`, "utf8");
}

function isEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = (value as EncryptedEnvelope)[ENVELOPE_PROPERTY];
  return Boolean(
    envelope
      && envelope.version === VERSION
      && envelope.algorithm === ALGORITHM
      && typeof envelope.iv === "string"
      && typeof envelope.tag === "string"
      && typeof envelope.ciphertext === "string",
  );
}

function atomicPrivateWrite(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Windows ACLs are managed by the account running the service.
    }
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch {}
    }
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch {}
    }
  }
}

export function readEncryptedJsonSync<T>(filePath: string, fallback: T, purpose: string): T {
  if (!existsSync(filePath)) return structuredClone(fallback);
  const size = statSync(filePath).size;
  if (size > MAX_STATE_BYTES) throw new Error(`Encrypted state exceeds ${MAX_STATE_BYTES} bytes`);
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isEnvelope(parsed)) {
    if (process.env.NODE_ENV === "production" || process.env.TAH_REQUIRE_ENCRYPTED_STATE === "true") {
      throw new Error(`Legacy plaintext state is forbidden for ${purpose}`);
    }
    return parsed as T;
  }
  const key = encryptionKey();
  if (!key) throw new Error(`TAH_STATE_ENCRYPTION_KEY is required to decrypt ${purpose}`);
  const envelope = parsed[ENVELOPE_PROPERTY];
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, "base64url"));
  decipher.setAAD(associatedData(purpose));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]);
  if (plaintext.byteLength > MAX_STATE_BYTES) throw new Error("Decrypted state exceeds the configured limit");
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function writeEncryptedJsonSync(filePath: string, value: unknown, purpose: string): void {
  const key = encryptionKey();
  if (!key) {
    if (process.env.NODE_ENV === "production" || process.env.TAH_REQUIRE_ENCRYPTED_STATE === "true") {
      throw new Error(`TAH_STATE_ENCRYPTION_KEY is required to persist ${purpose}`);
    }
    atomicPrivateWrite(filePath, value);
    return;
  }
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  if (plaintext.byteLength > MAX_STATE_BYTES) throw new Error(`State exceeds ${MAX_STATE_BYTES} bytes`);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(associatedData(purpose));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  atomicPrivateWrite(filePath, {
    [ENVELOPE_PROPERTY]: {
      algorithm: ALGORITHM,
      ciphertext: ciphertext.toString("base64url"),
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      version: VERSION,
    },
  } satisfies EncryptedEnvelope);
}
