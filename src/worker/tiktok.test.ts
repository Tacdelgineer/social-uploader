import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftRequest, TikTokCreatorInfo } from "../shared/contracts";
import {
  calculateTikTokChunks,
  initializeTikTokDirectPost,
  isTikTokPrivateAccount,
  validateCreatorSettings,
} from "./tiktok";

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
    consentConfirmed: true,
  },
  assets: {
    video: { key: "uploads/id/video.mp4", originalName: "short.mp4", contentType: "video/mp4", size: 70 * mebibyte },
    thumbnail: { key: "uploads/id/thumbnail.jpg", originalName: "cover.jpg", contentType: "image/jpeg", size: 45 },
  },
};

const creator: TikTokCreatorInfo = {
  username: "creator",
  nickname: "Creator",
  privacyLevelOptions: ["FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
  commentDisabled: false,
  duetDisabled: false,
  stitchDisabled: false,
  maxVideoDurationSeconds: 180,
  isPrivateAccount: true,
};

describe("TikTok Direct Post", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses one whole upload below 64 MiB and multiple valid chunks above it", () => {
    expect(calculateTikTokChunks(4 * mebibyte)).toEqual({ chunkSize: 4 * mebibyte, totalChunkCount: 1 });
    const chunks = calculateTikTokChunks(70 * mebibyte);
    expect(chunks.totalChunkCount).toBe(2);
    expect(chunks.chunkSize).toBe(35 * mebibyte);
  });

  it("accepts SELF_ONLY and creator-supported interaction settings", () => {
    expect(() => validateCreatorSettings(draft, creator)).not.toThrow();
  });

  it("allows a creator-returned public privacy option only after production approval", () => {
    const publicDraft: DraftRequest = {
      ...draft,
      tiktok: { ...draft.tiktok, privacy: "PUBLIC_TO_EVERYONE" },
    };
    const publicCreator: TikTokCreatorInfo = {
      ...creator,
      privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
      isPrivateAccount: false,
    };
    expect(() => validateCreatorSettings(publicDraft, publicCreator)).toThrow("production approval");
    expect(() => validateCreatorSettings(publicDraft, publicCreator, true)).not.toThrow();
  });

  it("distinguishes public and private accounts from creator privacy options", () => {
    expect(isTikTokPrivateAccount(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"])).toBe(false);
    expect(isTikTokPrivateAccount(["FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"])).toBe(true);
  });

  it("rejects unavailable privacy, interactions, duration, or cover timestamps", () => {
    expect(() => validateCreatorSettings({ ...draft, tiktok: { ...draft.tiktok, consentConfirmed: false } }, creator)).toThrow("consent");
    expect(() => validateCreatorSettings(draft, { ...creator, privacyLevelOptions: [] })).toThrow("privacy options");
    expect(() => validateCreatorSettings(draft, { ...creator, isPrivateAccount: false })).toThrow("production approval");
    expect(() => validateCreatorSettings(draft, { ...creator, commentDisabled: true })).toThrow("comments");
    expect(() => validateCreatorSettings({ ...draft, videoDurationSeconds: 181 }, creator)).toThrow("limit");
    expect(() =>
      validateCreatorSettings(
        { ...draft, tiktok: { ...draft.tiktok, coverTimestampMs: 30_000 } },
        creator,
      ),
    ).toThrow("cover timestamp");
  });

  it("surfaces the provider stage, error.code, and log_id for unaudited private-account failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "unaudited_client_can_only_post_to_private_accounts",
        message: "Please review our integration guidelines",
        log_id: "2026092503402087C8D3FBCE4C2A11608B",
      },
    }), { status: 403, headers: { "content-type": "application/json" } })));

    await expect(initializeTikTokDirectPost(draft, "not-a-real-token", creator)).rejects.toThrow(
      /video\/init.*unaudited_client_can_only_post_to_private_accounts.*production approval.*2026092503402087C8D3FBCE4C2A11608B/u,
    );
  });
});
