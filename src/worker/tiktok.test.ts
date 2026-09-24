import { describe, expect, it } from "vitest";
import type { DraftRequest, TikTokCreatorInfo } from "../shared/contracts";
import { calculateTikTokChunks, validateCreatorSettings } from "./tiktok";

const mebibyte = 1024 * 1024;

const draft: DraftRequest = {
  id: "c7f654b1-ea1d-4bfb-9a06-4fb57280eb76",
  title: "A short",
  description: "Caption",
  scheduledAt: null,
  timezone: "America/Los_Angeles",
  videoDurationSeconds: 30,
  platforms: { youtube: false, instagram: false, tiktok: true },
  youtube: { visibility: "public", madeForKids: false },
  instagram: { shareToFeed: true },
  tiktok: {
    privacy: "SELF_ONLY",
    allowComments: true,
    allowDuet: false,
    allowStitch: false,
    coverTimestampMs: 1_000,
  },
  assets: {
    video: { key: "uploads/id/video.mp4", originalName: "short.mp4", contentType: "video/mp4", size: 70 * mebibyte },
    thumbnail: { key: "uploads/id/thumbnail.jpg", originalName: "cover.jpg", contentType: "image/jpeg", size: 45 },
  },
};

const creator: TikTokCreatorInfo = {
  username: "creator",
  nickname: "Creator",
  privacyLevelOptions: ["SELF_ONLY"],
  commentDisabled: false,
  duetDisabled: false,
  stitchDisabled: false,
  maxVideoDurationSeconds: 180,
};

describe("TikTok Direct Post", () => {
  it("uses one whole upload below 64 MiB and multiple valid chunks above it", () => {
    expect(calculateTikTokChunks(4 * mebibyte)).toEqual({ chunkSize: 4 * mebibyte, totalChunkCount: 1 });
    const chunks = calculateTikTokChunks(70 * mebibyte);
    expect(chunks.totalChunkCount).toBe(2);
    expect(chunks.chunkSize).toBe(35 * mebibyte);
  });

  it("accepts SELF_ONLY and creator-supported interaction settings", () => {
    expect(() => validateCreatorSettings(draft, creator)).not.toThrow();
  });

  it("rejects unavailable privacy, interactions, duration, or cover timestamps", () => {
    expect(() => validateCreatorSettings(draft, { ...creator, privacyLevelOptions: [] })).toThrow("SELF_ONLY");
    expect(() => validateCreatorSettings(draft, { ...creator, commentDisabled: true })).toThrow("comments");
    expect(() => validateCreatorSettings({ ...draft, videoDurationSeconds: 181 }, creator)).toThrow("limit");
    expect(() =>
      validateCreatorSettings(
        { ...draft, tiktok: { ...draft.tiktok, coverTimestampMs: 30_000 } },
        creator,
      ),
    ).toThrow("cover timestamp");
  });
});
