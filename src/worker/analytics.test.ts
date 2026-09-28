import { describe, expect, it } from "vitest";
import { parseAnalyticsRange, parseIsoDurationSeconds } from "./analytics";

describe("analytics date ranges", () => {
  it("accepts a bounded ISO date range", () => {
    const url = new URL("https://example.test/api/analytics?start=2026-09-01&end=2026-09-27&label=28d");
    expect(parseAnalyticsRange(url, new Date("2026-09-27T20:00:00.000Z"))).toEqual({
      start: "2026-09-01",
      end: "2026-09-27",
      label: "28d",
    });
  });

  it("rejects inverted, future, and overlong ranges", () => {
    const now = new Date("2026-09-27T20:00:00.000Z");
    expect(parseAnalyticsRange(new URL("https://example.test/?start=2026-09-28&end=2026-09-01"), now)).toBeNull();
    expect(parseAnalyticsRange(new URL("https://example.test/?start=2026-09-01&end=2026-10-02"), now)).toBeNull();
    expect(parseAnalyticsRange(new URL("https://example.test/?start=2024-01-01&end=2026-09-01"), now)).toBeNull();
  });
});

describe("YouTube durations", () => {
  it("normalizes ISO 8601 durations to seconds", () => {
    expect(parseIsoDurationSeconds("PT1H2M3S")).toBe(3723);
    expect(parseIsoDurationSeconds("PT45S")).toBe(45);
    expect(parseIsoDurationSeconds(undefined)).toBeNull();
  });
});
