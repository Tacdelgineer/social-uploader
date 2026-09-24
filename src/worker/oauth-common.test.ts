import { describe, expect, it } from "vitest";
import { metaProviderError } from "./oauth-common";

describe("provider error diagnostics", () => {
  it("keeps the Instagram API stage, code, and subcode", () => {
    expect(metaProviderError({
      error: {
        message: "Unsupported post request.",
        code: 100,
        error_subcode: 33,
      },
    }, "Instagram rejected the request.", "container_create")).toBe(
      "Instagram container_create failed [Meta code 100, subcode 33]: Unsupported post request.",
    );
  });
});
