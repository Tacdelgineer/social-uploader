const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface EncryptedValue {
  version: 1;
  iv: string;
  ciphertext: string;
}

interface SignedState {
  nonce: string;
  expiresAt: number;
}

export async function encryptJson(value: unknown, secret: string): Promise<string> {
  const key = await importEncryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return JSON.stringify({
    version: 1,
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
  } satisfies EncryptedValue);
}

export async function decryptJson<T>(value: string, secret: string): Promise<T> {
  const parsed = JSON.parse(value) as Partial<EncryptedValue>;
  if (parsed.version !== 1 || !parsed.iv || !parsed.ciphertext) {
    throw new Error("Encrypted OAuth data has an unsupported format.");
  }
  const key = await importEncryptionKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(parsed.iv) },
    key,
    fromBase64Url(parsed.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

export async function createSignedState(
  secret: string,
  now = Date.now(),
): Promise<{ state: string; nonce: string }> {
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const payload = toBase64Url(
    encoder.encode(JSON.stringify({ nonce, expiresAt: now + 10 * 60 * 1000 } satisfies SignedState)),
  );
  return { state: `${payload}.${await sign(payload, secret)}`, nonce };
}

export async function verifySignedState(
  state: string,
  expectedNonce: string | null,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  const [payload, signature, extra] = state.split(".");
  if (!payload || !signature || extra || !expectedNonce) return false;
  const key = await importHmacKey(secret);
  const validSignature = await crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64Url(signature),
    encoder.encode(payload),
  );
  if (!validSignature) return false;
  try {
    const parsed = JSON.parse(decoder.decode(fromBase64Url(payload))) as Partial<SignedState>;
    return parsed.nonce === expectedNonce && typeof parsed.expiresAt === "number" && parsed.expiresAt > now;
  } catch {
    return false;
  }
}

function importEncryptionKey(secret: string): Promise<CryptoKey> {
  const bytes = fromBase64Url(secret);
  if (bytes.byteLength !== 32) {
    throw new Error("OAUTH_ENCRYPTION_KEY must be a base64-encoded 32-byte value.");
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function importHmacKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters.");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(value: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await importHmacKey(secret), encoder.encode(value));
  return toBase64Url(new Uint8Array(signature));
}

function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
