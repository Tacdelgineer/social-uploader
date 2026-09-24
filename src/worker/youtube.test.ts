import { describe, expect, it } from "vitest";
import type { DraftRequest } from "../shared/contracts";
import { assertScheduledVideoAccepted } from "./youtube";

const input: DraftRequest = {
  id: "c7f654b1-ea1d-4bfb-9a06-4fb57280eb76",
  title: "Scheduled Short",
  description: "A caption",
  scheduledAt: "2026-10-01T19:30:00.000Z",
  timezone: "America/Los_Angeles",
  platforms: { youtube: true, instagram: false, tiktok: false },
  youtube: { visibility: "public", madeForKids: false },
  assets: {
    video: { key: "uploads/id/video.mp4", originalName: "short.mp4", contentType: "video/mp4", size: 123 },
    thumbnail: { key: "uploads/id/thumbnail.png", originalName: "cover.png", contentType: "image/png", size: 45 },
  },
};

describe("YouTube acceptance verification", () => {
  it("accepts the exact native schedule and metadata", () => {
    expect(
      assertScheduledVideoAccepted(
        {
          id: "video_123",
          snippet: { title: input.title, description: input.description },
          status: {
            uploadStatus: "uploaded",
            privacyStatus: "private",
            publishAt: "2026-10-01T19:30:00Z",
            selfDeclaredMadeForKids: false,
          },
        },
        input,
        "video_123",
      ),
    ).toEqual({
      videoId: "video_123",
      uploadStatus: "uploaded",
      publishAt: "2026-10-01T19:30:00Z",
      warnings: [],
    });
  });

  it("reports optional metadata differences as warnings after schedule acceptance", () => {
    expect(
      assertScheduledVideoAccepted(
        {
          id: "video_123",
          snippet: { title: "Changed by YouTube", description: input.description },
          status: {
            uploadStatus: "processed",
            privacyStatus: "private",
            publishAt: input.scheduledAt ?? undefined,
          },
        },
        input,
        "video_123",
      ).warnings,
    ).toHaveLength(2);
  });

  it("refuses a rejected upload or changed schedule", () => {
    expect(() =>
      assertScheduledVideoAccepted(
        {
          id: "video_123",
          snippet: { title: input.title, description: input.description },
          status: {
            uploadStatus: "rejected",
            rejectionReason: "duplicate",
            privacyStatus: "private",
            publishAt: input.scheduledAt ?? undefined,
            selfDeclaredMadeForKids: false,
          },
        },
        input,
        "video_123",
      ),
    ).toThrow("duplicate");
  });
});
