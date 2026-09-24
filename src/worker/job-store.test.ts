import { describe, expect, it } from "vitest";
import type { StoredJob } from "../shared/contracts";
import {
  FAILED_MEDIA_RETENTION_MS,
  jobRequiresSource,
  normalizeOverallStatus,
  retryMediaExpiresAt,
} from "./job-store";

const base: StoredJob = {
  id: "c7f654b1-ea1d-4bfb-9a06-4fb57280eb76",
  schemaVersion: 6,
  title: "Scheduled",
  description: "Caption",
  scheduledAt: "2099-10-01T19:30:00.000Z",
  timezone: "America/Los_Angeles",
  videoDurationSeconds: 30,
  platforms: { youtube: true, instagram: true, tiktok: false },
  youtube: { visibility: "public", madeForKids: false },
  instagram: { shareToFeed: true },
  tiktok: {
    privacy: "SELF_ONLY",
    allowComments: false,
    allowDuet: false,
    allowStitch: false,
    coverTimestampMs: 0,
    consentConfirmed: false,
  },
  assets: {
    video: { key: "scheduled/id/video.mp4", originalName: "short.mp4", contentType: "video/mp4", size: 123 },
    thumbnail: { key: "scheduled/id/thumbnail.jpg", originalName: "cover.jpg", contentType: "image/jpeg", size: 45 },
  },
  status: "processing",
  platformStatus: { youtube: "scheduled", instagram: "pending" },
  createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:00:00.000Z",
};

describe("scheduled job state", () => {
  it("keeps a future provider handoff scheduled and retains its source", () => {
    const normalized = normalizeOverallStatus(base);
    expect(normalized.status).toBe("scheduled");
    expect(jobRequiresSource(normalized)).toBe(true);
  });

  it("releases media after all selected providers have custody", () => {
    const released: StoredJob = {
      ...base,
      platformStatus: { youtube: "scheduled", instagram: "published" },
      youtubeResult: {
        videoId: "video_123",
        acceptedAt: base.updatedAt,
        uploadStatus: "uploaded",
        privacyStatus: "private",
        publishAt: base.scheduledAt!,
        thumbnailApplied: true,
      },
      instagramResult: {
        containerId: "container_123",
        statusCode: "PUBLISHED",
        mediaTransferred: true,
        mediaId: "media_123",
      },
    };
    expect(jobRequiresSource(released)).toBe(false);
    expect(normalizeOverallStatus(released).status).toBe("scheduled");
  });

  it("retains a failed destination only until its fixed 24-hour retry deadline", () => {
    const failedAt = new Date("2026-09-24T08:00:00.000Z");
    const failed: StoredJob = {
      ...base,
      platforms: { youtube: false, instagram: true, tiktok: false },
      platformStatus: { instagram: "failed" },
      status: "failed",
      updatedAt: failedAt.toISOString(),
      retryMediaExpiresAt: new Date(failedAt.getTime() + FAILED_MEDIA_RETENTION_MS).toISOString(),
    };
    const deadline = retryMediaExpiresAt(failed);
    expect(deadline.toISOString()).toBe("2026-09-25T08:00:00.000Z");
    expect(jobRequiresSource(failed, new Date(deadline.getTime() - 1))).toBe(true);
    expect(jobRequiresSource(failed, deadline)).toBe(false);
  });

  it("does not retain cancelled media", () => {
    expect(jobRequiresSource({ ...base, status: "cancelled" })).toBe(false);
  });
});
