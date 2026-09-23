import { describe, expect, it } from "vitest";
import { extensionFor, validateDraftRequest, validatePresignRequest } from "./validation";

const id = "c7f654b1-ea1d-4bfb-9a06-4fb57280eb76";

describe("upload validation", () => {
  it("accepts an MP4 upload and maps its extension", () => {
    expect(extensionFor("video", "video/mp4")).toBe("mp4");
    expect(
      validatePresignRequest({ jobId: id, kind: "video", fileName: "short.mp4", contentType: "video/mp4", size: 123 }),
    ).not.toBeNull();
  });

  it("rejects invalid types and oversized thumbnails", () => {
    expect(
      validatePresignRequest({ jobId: id, kind: "video", fileName: "short.mov", contentType: "video/quicktime", size: 123 }),
    ).toBeNull();
    expect(
      validatePresignRequest({ jobId: id, kind: "thumbnail", fileName: "cover.png", contentType: "image/png", size: 11 * 1024 * 1024 }),
    ).toBeNull();
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

