import { AwsClient } from "aws4fetch";
import { R2_STORAGE_CAP_BYTES } from "../shared/contracts";
import type {
  ApiError,
  AssetKind,
  DraftRequest,
  PresignedUpload,
  PresignResponse,
  StoredDraft,
  UploadFileRequest,
} from "../shared/contracts";
import {
  CapacityExceededError,
  DuplicateJobError,
  reserveUploadCapacity,
} from "./capacity";
import { extensionFor, validateDraftRequest, validatePresignRequest } from "./validation";

interface Env {
  ASSETS: Fetcher;
  UPLOADS: R2Bucket;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({
        ok: true,
        service: "social-uploader",
        storage: "temporary-r2",
        storageCapBytes: R2_STORAGE_CAP_BYTES,
        cleanupFallbackDays: 7,
      });
    }

    if (url.pathname === "/api/uploads/presign" && request.method === "POST") {
      return createPresignedUpload(request, env);
    }

    if (url.pathname === "/api/drafts" && request.method === "POST") {
      return createDraft(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Not found." } satisfies ApiError, 404);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function createPresignedUpload(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const input = validatePresignRequest(body);
  if (!input) return json({ error: "Invalid upload request." } satisfies ApiError, 400);

  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    return json({ error: "R2 upload signing is not configured." } satisfies ApiError, 503);
  }

  const filesByKind = Object.fromEntries(
    input.files.map((file) => [file.kind, file]),
  ) as Record<AssetKind, UploadFileRequest>;
  const objectKeys = input.files.map((file) => objectKeyFor(input.jobId, file));
  let capacity;
  try {
    capacity = await reserveUploadCapacity(env.UPLOADS, input, objectKeys);
  } catch (error) {
    if (error instanceof CapacityExceededError) {
      return json({ error: error.message } satisfies ApiError, 507);
    }
    if (error instanceof DuplicateJobError) {
      return json({ error: error.message } satisfies ApiError, 409);
    }
    throw error;
  }

  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });

  const [video, thumbnail] = await Promise.all([
    signUpload(client, endpoint, env.R2_BUCKET_NAME, input.jobId, filesByKind.video, capacity.expiresIn),
    signUpload(
      client,
      endpoint,
      env.R2_BUCKET_NAME,
      input.jobId,
      filesByKind.thumbnail,
      capacity.expiresIn,
    ),
  ]);

  return json({
    uploads: { video, thumbnail },
    capacity: {
      limitBytes: capacity.limitBytes,
      committedBytes: capacity.committedBytes,
      availableBytes: capacity.availableBytes,
    },
  } satisfies PresignResponse);
}

async function signUpload(
  client: AwsClient,
  endpoint: string,
  bucketName: string,
  jobId: string,
  file: UploadFileRequest,
  expiresIn: number,
): Promise<PresignedUpload> {
  const objectKey = objectKeyFor(jobId, file);
  const objectUrl = `${endpoint}/${bucketName}/${objectKey}?X-Amz-Expires=${expiresIn}`;
  const signed = await client.sign(
    new Request(objectUrl, {
      method: "PUT",
      headers: {
        "content-length": String(file.size),
        "content-type": file.contentType,
      },
    }),
    { aws: { signQuery: true, allHeaders: true } },
  );
  return { uploadUrl: signed.url, objectKey, expiresIn };
}

function objectKeyFor(jobId: string, file: UploadFileRequest): string {
  return `uploads/${jobId}/${file.kind}.${extensionFor(file.kind, file.contentType)}`;
}

async function createDraft(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const input = validateDraftRequest(body);
  if (!input) return json({ error: "Invalid draft." } satisfies ApiError, 400);

  const assetError = await verifyAssets(input, env.UPLOADS);
  if (assetError) return json({ error: assetError } satisfies ApiError, 409);

  const now = new Date().toISOString();
  const draft: StoredDraft = {
    ...input,
    title: input.title.trim(),
    schemaVersion: 1,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };

  await env.UPLOADS.put(`drafts/${input.id}.json`, JSON.stringify(draft, null, 2), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { status: "draft", scheduledAt: input.scheduledAt ?? "" },
  });

  return json({ id: draft.id, status: draft.status, createdAt: draft.createdAt }, 201);
}

async function verifyAssets(input: DraftRequest, bucket: R2Bucket): Promise<string | null> {
  const [video, thumbnail] = await Promise.all([
    bucket.head(input.assets.video.key),
    bucket.head(input.assets.thumbnail.key),
  ]);
  if (!video || !thumbnail) return "Upload both files before saving the draft.";
  if (video.size !== input.assets.video.size || thumbnail.size !== input.assets.thumbnail.size) {
    return "An uploaded file size did not match the draft.";
  }
  return null;
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return null;
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
