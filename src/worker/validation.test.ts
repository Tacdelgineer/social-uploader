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

  it("counts only bytes not yet materialized in R2 plus short-lived ledger headroom", () => {
    const sizes = new Map([[`uploads/${id}/video.mp4`, 700]]);
    expect(calculateOutstandingBytes(activeEntry, sizes, new Date("2026-09-23T00:05:00.000Z"))).toBe(400);
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
    videoDurationSeconds: 30,
    platforms: { youtube: true, instagram: false, tiktok: false },
    youtube: { visibility: "public", madeForKids: false },
    instagram: { shareToFeed: true },
    tiktok: {
      privacy: "SELF_ONLY",
      allowComments: false,
      allowDuet: false,
      allowStitch: false,
      coverTimestampMs: 0,
    },
    assets: {
      video: { key: `uploads/${id}/video.mp4`, originalName: "short.mp4", contentType: "video/mp4", size: 123 },
      thumbnail: { key: `uploads/${id}/thumbnail.png`, originalName: "cover.png", contentType: "image/png", size: 45 },
    },
  };

  it("accepts a valid draft", () => {
    expect(validateDraftRequest(validDraft, new Date("2026-09-23T00:00:00.000Z"))).not.toBeNull();
  });

  it("requires at least one platform and job-scoped asset keys", () => {
    expect(
      validateDraftRequest(
        { ...validDraft, platforms: { youtube: false, instagram: false, tiktok: false } },
        new Date("2026-09-23T00:00:00.000Z"),
      ),
    ).toBeNull();
    expect(
      validateDraftRequest({
        ...validDraft,
        assets: { ...validDraft.assets, video: { ...validDraft.assets.video, key: "uploads/other/video.mp4" } },
      }, new Date("2026-09-23T00:00:00.000Z")),
    ).toBeNull();
  });

  it("accepts Instagram and TikTok together with a JPEG cover", () => {
    expect(
      validateDraftRequest(
        {
          ...validDraft,
          scheduledAt: null,
          platforms: { youtube: false, instagram: true, tiktok: true },
          assets: {
            ...validDraft.assets,
            thumbnail: {
              key: `uploads/${id}/thumbnail.jpg`,
              originalName: "cover.jpg",
              contentType: "image/jpeg",
              size: 45,
            },
          },
        },
        new Date("2026-09-23T00:00:00.000Z"),
      ),
    ).not.toBeNull();
  });

  it("requires a future native schedule and YouTube-compatible thumbnail", () => {
    expect(
      validateDraftRequest(
        { ...validDraft, scheduledAt: "2026-09-22T23:00:00.000Z" },
        new Date("2026-09-23T00:00:00.000Z"),
      ),
    ).toBeNull();
    expect(
      validateDraftRequest(
        {
          ...validDraft,
          assets: {
            ...validDraft.assets,
            thumbnail: {
              key: `uploads/${id}/thumbnail.webp`,
              originalName: "cover.webp",
              contentType: "image/webp",
              size: 45,
            },
          },
        },
        new Date("2026-09-23T00:00:00.000Z"),
      ),
    ).toBeNull();
  });
});
