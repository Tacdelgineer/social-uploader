import type { Platform } from "../shared/contracts";

export const PLATFORMS = ["youtube", "instagram", "tiktok"] as const satisfies readonly Platform[];

export type PlatformSelection = Record<Platform, boolean>;

export function allPlatformSelection(enabled: boolean): PlatformSelection {
  return { youtube: enabled, instagram: enabled, tiktok: enabled };
}

export function withPlatformSelection(
  current: PlatformSelection,
  platform: Platform,
  enabled: boolean,
): PlatformSelection {
  return { ...current, [platform]: enabled };
}

export function selectedPlatformsFor(selection: PlatformSelection): Platform[] {
  return PLATFORMS.filter((platform) => selection[platform]);
}

export function selectionControlState(selection: PlatformSelection): {
  allSelected: boolean;
  noneSelected: boolean;
} {
  const selectedCount = selectedPlatformsFor(selection).length;
  return { allSelected: selectedCount === PLATFORMS.length, noneSelected: selectedCount === 0 };
}
