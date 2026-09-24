import { describe, expect, it } from "vitest";
import {
  allPlatformSelection,
  selectedPlatformsFor,
  selectionControlState,
  withPlatformSelection,
} from "./platform-selection";

describe("platform selection", () => {
  it("toggles each platform independently and preserves every combination", () => {
    const platforms = ["youtube", "instagram", "tiktok"] as const;
    for (let mask = 0; mask < 8; mask += 1) {
      let selection = allPlatformSelection(false);
      for (const [index, platform] of platforms.entries()) {
        selection = withPlatformSelection(selection, platform, Boolean(mask & (1 << index)));
      }
      expect(selectedPlatformsFor(selection)).toEqual(
        platforms.filter((_, index) => Boolean(mask & (1 << index))),
      );
    }

    expect(selectionControlState(allPlatformSelection(true))).toEqual({ allSelected: true, noneSelected: false });
    expect(selectionControlState(allPlatformSelection(false))).toEqual({ allSelected: false, noneSelected: true });
  });
});
