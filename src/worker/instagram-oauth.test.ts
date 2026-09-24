import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignedState, decryptJson } from "./crypto";
import type { Env } from "./env";
import { finishInstagramOAuth, getInstagramCredentials } from "./instagram-oauth";

const encryptionKey = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const sessionSecret = "a-test-session-secret-that-is-longer-than-thirty-two-characters";

describe("Instagram Login callback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the exact token's /me user_id for publishing even when id is different", async () => {
    const values = new Map<string, string>([["oauth:instagram", "old-connection"]]);
    const tokenWrites: string[] = [];
    const metadata = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
        if (key === "oauth:instagram") tokenWrites.push(value);
      }),
      delete: vi.fn(async (key: string) => values.delete(key)),
    };
    const env = {
      METADATA: metadata,
      INSTAGRAM_APP_ID: "instagram-app-id",
      INSTAGRAM_APP_SECRET: "instagram-app-secret",
      OAUTH_ENCRYPTION_KEY: encryptionKey,
      SESSION_SECRET: sessionSecret,
      APP_BASE_URL: "https://social-uploader.example",
    } as unknown as Env;

    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === "https://api.instagram.com/oauth/access_token") {
        return Response.json({
          access_token: "short-access-token",
          user_id: "exchange-identity-is-not-compared",
          permissions: ["instagram_business_basic", "instagram_business_content_publish"],
        });
      }
      if (url.startsWith("https://graph.instagram.com/v26.0/me?")) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer short-access-token");
        const fields = new URL(url).searchParams.get("fields");
        expect(fields).toBe("id,user_id,username,account_type");
        return Response.json({
          id: "app-scoped-auth-id",
          user_id: "instagram-professional-user-id",
          username: "creator",
          account_type: "BUSINESS",
        });
      }
      if (url.startsWith("https://graph.instagram.com/access_token?")) {
        return Response.json({ access_token: "long-access-token", expires_in: 5_184_000 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const { state, nonce } = await createSignedState(sessionSecret);
    const request = new Request(
      `https://social-uploader.example/api/oauth/instagram/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `instagram_oauth_state=${nonce}` } },
    );
    const response = await finishInstagramOAuth(request, env);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("instagram=connected");
    expect(requestedUrls[1]).toContain("/v26.0/me?");
    expect(requestedUrls[2]).toContain("/access_token?");
    expect(tokenWrites).toHaveLength(1);

    const stored = await decryptJson<{
      authId: string;
      publishingUserId: string;
      accountType?: string;
      accessToken: string;
    }>(tokenWrites[0]!, encryptionKey);
    expect(stored).toMatchObject({
      authId: "app-scoped-auth-id",
      publishingUserId: "instagram-professional-user-id",
      accountType: "BUSINESS",
      accessToken: "long-access-token",
    });
    await expect(getInstagramCredentials(env)).resolves.toMatchObject({
      userId: "instagram-professional-user-id",
      username: "creator",
    });

    const diagnostic = [...values.entries()].find(([key]) => key.startsWith("event:"))?.[1] ?? "";
    expect(diagnostic).toContain("id=app-scoped-auth-id");
    expect(diagnostic).toContain("user_id=instagram-professional-user-id");
    expect(diagnostic).toContain("account_type=BUSINESS");
    expect(diagnostic).toContain("publishing_id=user_id:instagram-professional-user-id");
    expect(diagnostic).not.toContain("short-access-token");
    expect(diagnostic).not.toContain("long-access-token");
  });
});
