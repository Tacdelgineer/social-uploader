import type { PlatformConnectionStatus } from "../shared/contracts";
import { createSignedState, decryptJson, encryptJson, verifySignedState } from "./crypto";
import type { Env } from "./env";
import { oauthRedirect, oauthStateCookie, providerError, readCookie } from "./oauth-common";

const TOKEN_KEY = "oauth:instagram";
const STATE_COOKIE = "instagram_oauth_state";
const COOKIE_PATH = "/api/oauth/instagram";
const SCOPES = "instagram_business_basic,instagram_business_content_publish";
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_REFRESH_AGE_MS = 24 * 60 * 60 * 1000;

interface StoredInstagramTokens {
  accessToken: string;
  userId: string;
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

export async function beginInstagramOAuth(env: Env): Promise<Response> {
  requireConfiguration(env);
  const { state, nonce } = await createSignedState(env.SESSION_SECRET);
  const authorizeUrl = new URL("https://www.instagram.com/oauth/authorize");
  authorizeUrl.search = new URLSearchParams({
    client_id: env.META_APP_ID,
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
  tokenForm.set("client_id", env.META_APP_ID);
  tokenForm.set("client_secret", env.META_APP_SECRET);
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
  if (shortToken.permissions && !hasRequiredScopes(shortToken.permissions)) {
    return redirect(env, "error", "Instagram did not grant both basic and content publishing permissions.");
  }

  const longUrl = new URL("https://graph.instagram.com/access_token");
  longUrl.search = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: env.META_APP_SECRET,
    access_token: shortToken.access_token,
  }).toString();
  const longResponse = await fetch(longUrl);
  const long = (await longResponse.json()) as LongTokenResponse;
  if (!longResponse.ok || !long.access_token || !long.expires_in) {
    return redirect(env, "error", providerError(long, "Could not create a long-lived Instagram token."));
  }

  const username = await fetchUsername(long.access_token);
  const now = Date.now();
  const tokens: StoredInstagramTokens = {
    accessToken: long.access_token,
    userId: String(shortToken.user_id),
    username,
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
  } catch {
    return { connected: false };
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

async function fetchUsername(accessToken: string): Promise<string | undefined> {
  const url = new URL("https://graph.instagram.com/v26.0/me");
  url.searchParams.set("fields", "user_id,username");
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) return undefined;
  const payload = (await response.json()) as { username?: string };
  return payload.username;
}

function hasRequiredScopes(permissions: string | string[]): boolean {
  const granted = new Set(Array.isArray(permissions) ? permissions : permissions.split(","));
  return granted.has("instagram_business_basic") && granted.has("instagram_business_content_publish");
}

function requireConfiguration(env: Env): void {
  if (!env.META_APP_ID || !env.META_APP_SECRET || !env.OAUTH_ENCRYPTION_KEY || !env.SESSION_SECRET || !env.APP_BASE_URL) {
    throw new Error("Instagram OAuth is not fully configured.");
  }
}

function redirectUri(env: Env): string {
  return `${env.APP_BASE_URL.replace(/\/$/u, "")}/api/oauth/instagram/callback`;
}

function redirect(env: Env, result: "connected" | "error", message?: string): Response {
  return oauthRedirect(env, "instagram", result, STATE_COOKIE, COOKIE_PATH, message);
}
