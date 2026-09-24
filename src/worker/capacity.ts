import { R2_STORAGE_CAP_BYTES, type PresignRequest } from "../shared/contracts";

const LEDGER_KEY = "_system/storage-cap-ledger.json";
const PRESIGN_TTL_SECONDS = 15 * 60;
const CLEANUP_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DRAFT_AND_LEDGER_RESERVE_BYTES = 64 * 1024;
const MAX_CAS_ATTEMPTS = 8;

interface LedgerEntry {
  jobId: string;
  mediaBytes: number;
  metadataReserveBytes: number;
  keys: string[];
  createdAt: string;
  presignExpiresAt: string;
  cleanupAt: string;
}

interface StorageLedger {
  schemaVersion: 1;
  updatedAt: string;
  entries: Record<string, LedgerEntry>;
}

interface BucketSnapshot {
  storedBytes: number;
  sizesByKey: Map<string, number>;
}

export interface TemporaryStorageMetrics {
  usedBytes: number;
  capBytes: number;
  usedPercent: number;
  temporaryObjectCount: number;
  oldestTemporaryObject: {
    key: string;
    size: number;
    uploadedAt: string;
  } | null;
}

export interface CapacityReservation {
  limitBytes: number;
  committedBytes: number;
  availableBytes: number;
  expiresIn: number;
}

export class CapacityExceededError extends Error {
  constructor() {
    super("This upload would exceed the 8 GB temporary R2 storage cap.");
    this.name = "CapacityExceededError";
  }
}

export class DuplicateJobError extends Error {
  constructor() {
    super("An upload reservation already exists for this draft.");
    this.name = "DuplicateJobError";
  }
}

export async function getTemporaryStorageMetrics(
  bucket: R2Bucket,
): Promise<TemporaryStorageMetrics> {
  let cursor: string | undefined;
  let usedBytes = 0;
  let temporaryObjectCount = 0;
  let oldestTemporaryObject: TemporaryStorageMetrics["oldestTemporaryObject"] = null;

  do {
    const page = await bucket.list({ cursor, limit: 1000 });
    for (const object of page.objects) {
      usedBytes += object.size;
      if (object.key.startsWith("_system/")) continue;
      temporaryObjectCount += 1;
      const uploadedAt = object.uploaded.toISOString();
      if (!oldestTemporaryObject || uploadedAt < oldestTemporaryObject.uploadedAt) {
        oldestTemporaryObject = { key: object.key, size: object.size, uploadedAt };
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return {
    usedBytes,
    capBytes: R2_STORAGE_CAP_BYTES,
    usedPercent: Math.min(100, (usedBytes / R2_STORAGE_CAP_BYTES) * 100),
    temporaryObjectCount,
    oldestTemporaryObject,
  };
}

export async function reserveUploadCapacity(
  bucket: R2Bucket,
  input: PresignRequest,
  objectKeys: string[],
): Promise<CapacityReservation> {
  const mediaBytes = input.files.reduce((sum, file) => sum + file.size, 0);

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const now = new Date();
    const currentObject = await bucket.get(LEDGER_KEY);
    const currentLedger = currentObject ? parseLedger(await currentObject.text()) : emptyLedger(now);
    const snapshot = await snapshotBucket(bucket);
    const entries = reconcileEntries(currentLedger.entries, snapshot, now);

    if (entries[input.jobId]) throw new DuplicateJobError();

    const currentCommitted = calculateCommittedBytes(snapshot, entries, now);
    const createdAt = now.toISOString();
    entries[input.jobId] = {
      jobId: input.jobId,
      mediaBytes,
      metadataReserveBytes: DRAFT_AND_LEDGER_RESERVE_BYTES,
      keys: objectKeys,
      createdAt,
      presignExpiresAt: new Date(now.getTime() + PRESIGN_TTL_SECONDS * 1000).toISOString(),
      cleanupAt: new Date(now.getTime() + CLEANUP_FALLBACK_MS).toISOString(),
    };

    const nextLedger: StorageLedger = { schemaVersion: 1, updatedAt: createdAt, entries };
    const nextBody = JSON.stringify(nextLedger);
    const ledgerGrowth = Math.max(0, byteLength(nextBody) - (currentObject?.size ?? 0));
    const projectedBytes =
      currentCommitted + mediaBytes + DRAFT_AND_LEDGER_RESERVE_BYTES + ledgerGrowth;

    if (projectedBytes > R2_STORAGE_CAP_BYTES) throw new CapacityExceededError();

    const written = await bucket.put(LEDGER_KEY, nextBody, {
      onlyIf: currentObject
        ? { etagMatches: currentObject.etag }
        : { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
      customMetadata: { purpose: "storage-cap-ledger" },
    });

    if (written) {
      return {
        limitBytes: R2_STORAGE_CAP_BYTES,
        committedBytes: projectedBytes,
        availableBytes: Math.max(0, R2_STORAGE_CAP_BYTES - projectedBytes),
        expiresIn: PRESIGN_TTL_SECONDS,
      };
    }
  }

  throw new Error("Storage capacity changed too quickly. Please retry the upload.");
}

export function calculateOutstandingBytes(
  entry: LedgerEntry,
  sizesByKey: ReadonlyMap<string, number>,
  now: Date,
): number {
  if (new Date(entry.presignExpiresAt).getTime() <= now.getTime()) return 0;
  const uploadedMediaBytes = entry.keys.reduce((sum, key) => sum + (sizesByKey.get(key) ?? 0), 0);
  const draftExists = sizesByKey.has(`drafts/${entry.jobId}.json`);
  return (
    Math.max(0, entry.mediaBytes - uploadedMediaBytes) +
    (draftExists ? 0 : entry.metadataReserveBytes)
  );
}

function calculateCommittedBytes(
  snapshot: BucketSnapshot,
  entries: Record<string, LedgerEntry>,
  now: Date,
): number {
  const outstandingBytes = Object.values(entries).reduce(
    (sum, entry) => sum + calculateOutstandingBytes(entry, snapshot.sizesByKey, now),
    0,
  );
  return snapshot.storedBytes + outstandingBytes;
}

function reconcileEntries(
  entries: Record<string, LedgerEntry>,
  snapshot: BucketSnapshot,
  now: Date,
): Record<string, LedgerEntry> {
  return Object.fromEntries(
    Object.entries(entries).filter(([, entry]) => {
      const hasMedia = entry.keys.some((key) => snapshot.sizesByKey.has(key));
      const hasDraft = snapshot.sizesByKey.has(`drafts/${entry.jobId}.json`);
      const presignActive = new Date(entry.presignExpiresAt).getTime() > now.getTime();
      const cleanupPending = new Date(entry.cleanupAt).getTime() > now.getTime();
      return presignActive || hasMedia || hasDraft || cleanupPending;
    }),
  );
}

async function snapshotBucket(bucket: R2Bucket): Promise<BucketSnapshot> {
  let cursor: string | undefined;
  let storedBytes = 0;
  const sizesByKey = new Map<string, number>();

  do {
    const page = await bucket.list({ cursor, limit: 1000 });
    for (const object of page.objects) {
      storedBytes += object.size;
      sizesByKey.set(object.key, object.size);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return { storedBytes, sizesByKey };
}

function emptyLedger(now: Date): StorageLedger {
  return { schemaVersion: 1, updatedAt: now.toISOString(), entries: {} };
}

function parseLedger(value: string): StorageLedger {
  const parsed = JSON.parse(value) as Partial<StorageLedger>;
  if (parsed.schemaVersion !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
    throw new Error("The R2 storage-cap ledger is invalid; uploads are paused for safety.");
  }
  return parsed as StorageLedger;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
