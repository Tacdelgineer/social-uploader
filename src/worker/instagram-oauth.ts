import type { PlatformConnectionStatus } from "../shared/contracts";
import { createSignedState, decryptJson, encryptJson, verifySignedState } from "./crypto";
import type { Env } from "./env";
import { metaProviderError, oauthRedirect, oauthStateCookie, providerError, readCookie } from "./oauth-common";

const TOKEN_KEY = "oauth:instagram";
const STATE_COOKIE = "instagram_oauth_state";
const COOKIE_PATH = "/api/oauth/instagram";
const SCOPES = "instagram_business_basic,instagram_business_content_publish";
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_REFRESH_AGE_MS = 24 * 60 * 60 * 1000;

interface StoredInstagramTokens {
  schemaVersion: 2;
  accessToken: string;
  userId: string;
  permissions: string[];
  username?: string;
  expiresAt: number;
  refreshedAt: number;
}

interface ShortTokenResponse {
  access_token?: string;
  user_id?: string | number;
  permissions?: string | string[];
  data?: Array<{
    access_token?: string;
    user_id?: string | number;
    permissions?: string | string[];
  }>;
  error?: unknown;
  error_message?: string;
}

interface LongTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: unknown;
}

interface InstagramIdentityResponse {
  id?: string | number;
  user_id?: string | number;
  username?: string;
  error?: unknown;
}

interface InstagramPermissionsResponse {
  data?: Array<{ permission?: string; status?: string }>;
  error?: unknown;
}

export async function beginInstagramOAuth(env: Env): Promise<Response> {
  requireConfiguration(env);
  const { state, nonce } = await createSignedState(env.SESSION_SECRET);
  const authorizeUrl = new URL("https://www.instagram.com/oauth/authorize");
  authorizeUrl.search = new URLSearchParams({
    client_id: env.INSTAGRAM_APP_ID,
    redirect_uri: redirectUri(env),
    response_type: "code",
    scope: SCOPES,
    enable_fb_login: "0",
    force_authentication: "1",
    state,
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      location: authorizeUrl.toString(),
      "cache-control": "no-store",
      "set-cookie": oauthStateCookie(STATE_COOKIE, nonce, COOKIE_PATH),
    },
  });
}

export async function finishInstagramOAuth(request: Request, env: Env): Promise<Response> {
  requireConfiguration(env);
  const url = new URL(request.url);
  const validState = await verifySignedState(
    url.searchParams.get("state") ?? "",
    readCookie(request, STATE_COOKIE),
    env.SESSION_SECRET,
  );
  if (!validState) return redirect(env, "error", "OAuth state validation failed.");

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return redirect(
      env,
      "error",
      url.searchParams.get("error_description") ?? `Instagram authorization failed: ${oauthError}`,
    );
  }
  const code = url.searchParams.get("code");
  if (!code) return redirect(env, "error", "Instagram did not return an authorization code.");

  const tokenForm = new FormData();
  tokenForm.set("client_id", env.INSTAGRAM_APP_ID);
  tokenForm.set("client_secret", env.INSTAGRAM_APP_SECRET);
  tokenForm.set("grant_type", "authorization_code");
  tokenForm.set("redirect_uri", redirectUri(env));
  tokenForm.set("code", code.replace(/#_$/u, ""));
  const shortResponse = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    body: tokenForm,
  });
  const short = (await shortResponse.json()) as ShortTokenResponse;
  const shortToken = short.data?.[0] ?? short;
  if (!shortResponse.ok || !shortToken.access_token || !shortToken.user_id) {
    return redirect(env, "error", providerError(short, short.error_message ?? "Instagram token exchange failed."));
  }

  const longUrl = new URL("https://graph.instagram.com/access_token");
  longUrl.search = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: env.INSTAGRAM_APP_SECRET,
    access_token: shortToken.access_token,
  }).toString();
  const longResponse = await fetch(longUrl);
  const long = (await longResponse.json()) as LongTokenResponse;
  if (!longResponse.ok || !long.access_token || !long.expires_in) {
    return redirect(env, "error", providerError(long, "Could not create a long-lived Instagram token."));
  }

  let identity: { userId: string; username?: string };
  let permissions = normalizeScopes(shortToken.permissions);
  try {
    identity = await fetchIdentity(long.access_token);
    if (identity.userId !== String(shortToken.user_id)) {
      return redirect(
        env,
        "error",
        "Instagram returned an account ID that does not match this authorization. Reconnect the intended Instagram account.",
      );
    }
    if (permissions.length === 0) permissions = await fetchGrantedPermissions(long.access_token);
  } catch (error) {
    return redirect(env, "error", error instanceof Error ? error.message : "Instagram authorization verification failed.");
  }
  if (!hasRequiredScopes(permissions)) {
    return redirect(
      env,
      "error",
      "Instagram authorization is missing instagram_business_content_publish. Reconnect Instagram and approve publishing access.",
    );
  }
  const now = Date.now();
  const tokens: StoredInstagramTokens = {
    schemaVersion: 2,
    accessToken: long.access_token,
    userId: identity.userId,
    username: identity.username,
    permissions,
    expiresAt: now + long.expires_in * 1000,
    refreshedAt: now,
  };
  await env.METADATA.put(TOKEN_KEY, await encryptJson(tokens, env.OAUTH_ENCRYPTION_KEY));
  return redirect(env, "connected");
}

export async function instagramConnectionStatus(env: Env): Promise<PlatformConnectionStatus> {
  try {
    const credentials = await getInstagramCredentials(env);
    return { connected: true, displayName: credentials.username ? `@${credentials.username}` : undefined };
  } catch (error) {
    const requiresReconnect = Boolean(await env.METADATA.get(TOKEN_KEY));
    return {
      connected: false,
      requiresReconnect,
      message: requiresReconnect && error instanceof Error ? error.message : undefined,
    };
  }
}

export async function disconnectInstagram(env: Env): Promise<void> {
  const encrypted = await env.METADATA.get(TOKEN_KEY);
  if (encrypted) {
    try {
      const tokens = await decryptJson<StoredInstagramTokens>(encrypted, env.OAUTH_ENCRYPTION_KEY);
      await fetch("https://graph.instagram.com/v26.0/me/permissions", {
        method: "DELETE",
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });
    } catch {
      // Deleting the encrypted local token still disconnects this dashboard.
    }
  }
  await env.METADATA.delete(TOKEN_KEY);
}

export async function getInstagramCredentials(
  env: Env,
): Promise<{ accessToken: string; userId: string; username?: string }> {
  requireConfiguration(env);
  const encrypted = await env.METADATA.get(TOKEN_KEY);
  if (!encrypted) throw new Error("Connect Instagram before submitting an Instagram Reel.");
  let tokens = await decryptJson<StoredInstagramTokens>(encrypted, env.OAUTH_ENCRYPTION_KEY);
  if (tokens.schemaVersion !== 2 || !Array.isArray(tokens.permissions) || !hasRequiredScopes(tokens.permissions)) {
    throw new Error(
      "Reconnect Instagram once to verify instagram_business_content_publish and bind the current account ID to its token.",
    );
  }
  const now = Date.now();
  if (tokens.expiresAt <= now + 60_000) {
    throw new Error("Instagram authorization expired. Reconnect Instagram.");
  }
  if (tokens.expiresAt <= now + REFRESH_WINDOW_MS && now - tokens.refreshedAt >= MIN_REFRESH_AGE_MS) {
    tokens = await refreshTokens(tokens, env);
  }
  return { accessToken: tokens.accessToken, userId: tokens.userId, username: tokens.username };
}

async function refreshTokens(tokens: StoredInstagramTokens, env: Env): Promise<StoredInstagramTokens> {
  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.search = new URLSearchParams({
    grant_type: "ig_refresh_token",
    access_token: tokens.accessToken,
  }).toString();
  const response = await fetch(url);
  const payload = (await response.json()) as LongTokenResponse;
  if (!response.ok || !payload.access_token || !payload.expires_in) {
    throw new Error(providerError(payload, "Instagram authorization could not be refreshed. Reconnect Instagram."));
  }
  const refreshed: StoredInstagramTokens = {
    ...tokens,
    accessToken: payload.access_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
    refreshedAt: Date.now(),
  };
  await env.METADATA.put(TOKEN_KEY, await encryptJson(refreshed, env.OAUTH_ENCRYPTION_KEY));
  return refreshed;
}

async function fetchIdentity(accessToken: string): Promise<{ userId: string; username?: string }> {
  const url = new URL("https://graph.instagram.com/v26.0/me");
  url.searchParams.set("fields", "user_id,username");
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  const payload = (await response.json()) as InstagramIdentityResponse;
  const userId = payload.user_id ?? payload.id;
  if (!response.ok || userId === undefined) {
    throw new Error(metaProviderError(payload, "Could not verify the authorized Instagram account.", "oauth_identity"));
  }
  return { userId: String(userId), username: payload.username };
}

async function fetchGrantedPermissions(accessToken: string): Promise<string[]> {
  const response = await fetch("https://graph.instagram.com/v26.0/me/permissions", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const payload = (await response.json()) as InstagramPermissionsResponse;
  if (!response.ok || !Array.isArray(payload.data)) {
    throw new Error(
      metaProviderError(payload, "Could not verify Instagram publishing permissions.", "oauth_permissions"),
    );
  }
  return payload.data
    .filter((permission) => permission.status === "granted" && typeof permission.permission === "string")
    .map((permission) => permission.permission!);
}

function normalizeScopes(permissions?: string | string[]): string[] {
  if (!permissions) return [];
  return (Array.isArray(permissions) ? permissions : permissions.split(","))
    .map((permission) => permission.trim())
    .filter(Boolean);
}

function hasRequiredScopes(permissions: string | string[]): boolean {
  const granted = new Set(normalizeScopes(permissions));
  return granted.has("instagram_business_basic") && granted.has("instagram_business_content_publish");
}

function requireConfiguration(env: Env): void {
  if (!env.INSTAGRAM_APP_ID || !env.INSTAGRAM_APP_SECRET || !env.OAUTH_ENCRYPTION_KEY || !env.SESSION_SECRET || !env.APP_BASE_URL) {
    throw new Error("Instagram OAuth is not fully configured.");
  }
}

function redirectUri(env: Env): string {
  return `${env.APP_BASE_URL.replace(/\/$/u, "")}/api/oauth/instagram/callback`;
}

function redirect(env: Env, result: "connected" | "error", message?: string): Response {
  return oauthRedirect(env, "instagram", result, STATE_COOKIE, COOKIE_PATH, message);
}
