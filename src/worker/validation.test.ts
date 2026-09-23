import { describe, expect, it } from "vitest";
import { calculateOutstandingBytes } from "./capacity";
import { extensionFor, validateDraftRequest, validatePresignRequest } from "./validation";

const id = "c7f654b1-ea1d-4bfb-9a06-4fb57280eb76";

describe("upload validation", () => {
  it("accepts an MP4 upload and maps its extension", () => {
    expect(extensionFor("video", "video/mp4")).toBe("mp4");
    expect(
      validatePresignRequest({
        jobId: id,
        files: [
          { kind: "video", fileName: "short.mp4", contentType: "video/mp4", size: 123 },
          { kind: "thumbnail", fileName: "cover.png", contentType: "image/png", size: 45 },
        ],
      }),
    ).not.toBeNull();
  });

  it("rejects invalid types and oversized thumbnails", () => {
    expect(
      validatePresignRequest({
        jobId: id,
        files: [
          { kind: "video", fileName: "short.mov", contentType: "video/quicktime", size: 123 },
          { kind: "thumbnail", fileName: "cover.png", contentType: "image/png", size: 45 },
        ],
      }),
    ).toBeNull();
    expect(
      validatePresignRequest({
        jobId: id,
        files: [
          { kind: "video", fileName: "short.mp4", contentType: "video/mp4", size: 123 },
          {
            kind: "thumbnail",
            fileName: "cover.png",
            contentType: "image/png",
            size: 11 * 1024 * 1024,
          },
        ],
      }),
    ).toBeNull();
  });

  it("requires exactly one video and one thumbnail", () => {
    expect(
      validatePresignRequest({
        jobId: id,
        files: [
          { kind: "video", fileName: "one.mp4", contentType: "video/mp4", size: 123 },
          { kind: "video", fileName: "two.mp4", contentType: "video/mp4", size: 456 },
        ],
      }),
    ).toBeNull();
  });
});

describe("capacity accounting", () => {
  const activeEntry = {
    jobId: id,
    mediaBytes: 1_000,
    metadataReserveBytes: 100,
    keys: [`uploads/${id}/video.mp4`, `uploads/${id}/thumbnail.png`],
    createdAt: "2026-09-23T00:00:00.000Z",
    presignExpiresAt: "2026-09-23T00:15:00.000Z",
    cleanupAt: "2026-09-30T00:00:00.000Z",
  };

  it("counts only bytes not yet materialized in R2 plus draft headroom", () => {
    const sizes = new Map([[`uploads/${id}/video.mp4`, 700]]);
    expect(calculateOutstandingBytes(activeEntry, sizes, new Date("2026-09-23T00:05:00.000Z"))).toBe(400);
    sizes.set(`drafts/${id}.json`, 50);
    expect(calculateOutstandingBytes(activeEntry, sizes, new Date("2026-09-23T00:05:00.000Z"))).toBe(300);
  });

  it("releases unused reservations when signed URLs expire", () => {
    expect(
      calculateOutstandingBytes(activeEntry, new Map(), new Date("2026-09-23T00:16:00.000Z")),
    ).toBe(0);
  });
});

describe("draft validation", () => {
  const validDraft = {
    id,
    title: "A short title",
    description: "Caption",
    scheduledAt: "2026-10-01T19:30:00.000Z",
    timezone: "America/Los_Angeles",
    platforms: { youtube: true, instagram: false, tiktok: true },
    assets: {
      video: { key: `uploads/${id}/video.mp4`, originalName: "short.mp4", contentType: "video/mp4", size: 123 },
      thumbnail: { key: `uploads/${id}/thumbnail.webp`, originalName: "cover.webp", contentType: "image/webp", size: 45 },
    },
  };

  it("accepts a valid draft", () => {
    expect(validateDraftRequest(validDraft)).not.toBeNull();
  });

  it("requires one platform and job-scoped asset keys", () => {
    expect(
      validateDraftRequest({ ...validDraft, platforms: { youtube: false, instagram: false, tiktok: false } }),
    ).toBeNull();
    expect(
      validateDraftRequest({
        ...validDraft,
        assets: { ...validDraft.assets, video: { ...validDraft.assets.video, key: "uploads/other/video.mp4" } },
      }),
    ).toBeNull();
  });
});
