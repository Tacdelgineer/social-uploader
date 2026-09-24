import { describe, expect, it } from "vitest";
import { createSignedState, decryptJson, encryptJson, verifySignedState } from "./crypto";

const encryptionKey = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const sessionSecret = "a-test-session-secret-that-is-longer-than-thirty-two-characters";

describe("OAuth security helpers", () => {
  it("round-trips encrypted JSON without leaving plaintext", async () => {
    const encrypted = await encryptJson({ refreshToken: "secret-refresh-token" }, encryptionKey);
    expect(encrypted).not.toContain("secret-refresh-token");
    await expect(decryptJson(encrypted, encryptionKey)).resolves.toEqual({
      refreshToken: "secret-refresh-token",
    });
  });

  it("validates signed state, nonce, and expiry", async () => {
    const created = await createSignedState(sessionSecret, 1_000);
    await expect(verifySignedState(created.state, created.nonce, sessionSecret, 2_000)).resolves.toBe(true);
    await expect(verifySignedState(created.state, "wrong", sessionSecret, 2_000)).resolves.toBe(false);
    await expect(verifySignedState(created.state, created.nonce, sessionSecret, 700_000)).resolves.toBe(false);
  });
});
