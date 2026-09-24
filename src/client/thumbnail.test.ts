import { describe, expect, it } from "vitest";
import { INSTAGRAM_COVER_MAX_BYTES } from "../shared/contracts";
import { thumbnailNeedsJpegConversion } from "./thumbnail";

describe("thumbnail platform compatibility", () => {
  it("converts PNG and WebP covers when Instagram is selected", () => {
    expect(thumbnailNeedsJpegConversion({ type: "image/png", size: 100 }, ["instagram"])).toBe(true);
    expect(thumbnailNeedsJpegConversion({ type: "image/webp", size: 100 }, ["instagram", "tiktok"])).toBe(true);
  });

  it("keeps compatible JPEG covers and converts only oversized Instagram JPEGs", () => {
    expect(thumbnailNeedsJpegConversion({ type: "image/jpeg", size: 100 }, ["instagram"])).toBe(false);
    expect(
      thumbnailNeedsJpegConversion(
        { type: "image/jpeg", size: INSTAGRAM_COVER_MAX_BYTES + 1 },
        ["instagram"],
      ),
    ).toBe(true);
  });

  it("converts WebP for YouTube but leaves it untouched for TikTok-only jobs", () => {
    expect(thumbnailNeedsJpegConversion({ type: "image/webp", size: 100 }, ["youtube"])).toBe(true);
    expect(thumbnailNeedsJpegConversion({ type: "image/webp", size: 100 }, ["tiktok"])).toBe(false);
  });
});
