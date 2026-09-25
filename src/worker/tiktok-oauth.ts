import type { PlatformConnectionStatus } from "../shared/contracts";
import { createSignedState, decryptJson, encryptJson, verifySignedState } from "./crypto";
import type { Env } from "./env";
import { oauthRedirect, oauthStateCookie, providerError, readCookie } from "./oauth-common";

const TOKEN_KEY = "oauth:tiktok";
const STATE_COOKIE = "tiktok_oauth_state";
const COOKIE_PATH = "/api/oauth/tiktok";
const SCOPES = "user.info.basic,video.publish";
const REFRESH_WINDOW_MS = 60 * 60 * 1000;

interface StoredTikTokTokens {
  accessToken: string;
  refreshToken: string;
  openId: string;
  scope: string;
  tokenType: string;
  expiresAt: number;
  refreshExpiresAt: number;
  displayName?: string;
}

interface TikTokTokenResponse {
  access_token?: string;
  refresh_token?: string;
  open_id?: string;
  scope?: string;
  token_type?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  error?: string;
  error_description?: string;
  log_id?: string;
}

export async function beginTikTokOAuth(env: Env): Promise<Response> {
  requireConfiguration(env);
  const { state, nonce } = await createSignedState(env.SESSION_SECRET);
  const authorizeUrl = new URL("https://www.tiktok.com/v2/auth/authorize/");
  authorizeUrl.search = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    response_type: "code",
    scope: SCOPES,
    redirect_uri: redirectUri(env),
    state,
    disable_auto_auth: "1",
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

export async function finishTikTokOAuth(request: Request, env: Env): Promise<Response> {
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
      url.searchParams.get("error_description") ?? `TikTok authorization failed: ${oauthError}`,
    );
  }
  const code = url.searchParams.get("code");
  if (!code) return redirect(env, "error", "TikTok did not return an authorization code.");

  const response = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: env.TIKTOK_CLIENT_KEY,
      client_secret: env.TIKTOK_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri(env),
    }),
  });
  const payload = (await response.json()) as TikTokTokenResponse;
  if (!response.ok || !isCompleteTokenResponse(payload)) {
    return redirect(env, "error", providerError(payload, "TikTok token exchange failed."));
  }
  if (!hasRequiredScopes(payload.scope)) {
    return redirect(env, "error", "TikTok did not grant both basic profile and video publishing permissions.");
  }

  const now = Date.now();
  const tokens: StoredTikTokTokens = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    openId: payload.open_id,
    scope: payload.scope,
    tokenType: payload.token_type ?? "Bearer",
    expiresAt: now + payload.expires_in * 1000,
    refreshExpiresAt: now + payload.refresh_expires_in * 1000,
    displayName: await fetchDisplayName(payload.access_token),
  };
  await env.METADATA.put(TOKEN_KEY, await encryptJson(tokens, env.OAUTH_ENCRYPTION_KEY));
  return redirect(env, "connected");
}

export async function tiktokConnectionStatus(env: Env): Promise<PlatformConnectionStatus> {
  try {
    const tokens = await getTikTokCredentials(env);
    return { connected: true, displayName: tokens.displayName };
  } catch {
    return { connected: false };
  }
}

export async function disconnectTikTok(env: Env): Promise<void> {
  const encrypted = await env.METADATA.get(TOKEN_KEY);
  if (encrypted) {
    try {
      const tokens = await decryptJson<StoredTikTokTokens>(encrypted, env.OAUTH_ENCRYPTION_KEY);
      await fetch("https://open.tiktokapis.com/v2/oauth/revoke/", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_key: env.TIKTOK_CLIENT_KEY,
          client_secret: env.TIKTOK_CLIENT_SECRET,
          token: tokens.accessToken,
        }),
      });
    } catch {
      // Deleting the encrypted local token still disconnects this dashboard.
    }
  }
  await env.METADATA.delete(TOKEN_KEY);
}

export async function getTikTokCredentials(
  env: Env,
): Promise<{ accessToken: string; openId: string; displayName?: string; scope: string }> {
  requireConfiguration(env);
  const encrypted = await env.METADATA.get(TOKEN_KEY);
  if (!encrypted) throw new Error("Connect TikTok before submitting a TikTok post.");
  let tokens = await decryptJson<StoredTikTokTokens>(encrypted, env.OAUTH_ENCRYPTION_KEY);
  const now = Date.now();
  if (tokens.refreshExpiresAt <= now + 60_000) throw new Error("TikTok authorization expired. Reconnect TikTok.");
  if (tokens.expiresAt <= now + REFRESH_WINDOW_MS) tokens = await refreshTokens(tokens, env);
  if (!hasRequiredScopes(tokens.scope)) {
    throw new Error("TikTok authorization lacks video.publish. Reconnect TikTok and approve Direct Post access.");
  }
  return {
    accessToken: tokens.accessToken,
    openId: tokens.openId,
    displayName: tokens.displayName,
    scope: tokens.scope,
  };
}

export function tiktokLoginKitConfigured(env: Env): boolean {
  return Boolean(
    env.TIKTOK_CLIENT_KEY &&
    env.TIKTOK_CLIENT_SECRET &&
    env.OAUTH_ENCRYPTION_KEY &&
    env.SESSION_SECRET &&
    env.APP_BASE_URL
  );
}

async function refreshTokens(tokens: StoredTikTokTokens, env: Env): Promise<StoredTikTokTokens> {
  const response = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: env.TIKTOK_CLIENT_KEY,
      client_secret: env.TIKTOK_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
    }),
  });
  const payload = (await response.json()) as TikTokTokenResponse;
  if (!response.ok || !isCompleteTokenResponse(payload)) {
    throw new Error(providerError(payload, "TikTok authorization could not be refreshed. Reconnect TikTok."));
  }
  if (!hasRequiredScopes(payload.scope)) {
    throw new Error("TikTok authorization refresh no longer includes video.publish. Reconnect TikTok.");
  }
  const now = Date.now();
  const refreshed: StoredTikTokTokens = {
    ...tokens,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    openId: payload.open_id,
    scope: payload.scope,
    tokenType: payload.token_type ?? tokens.tokenType,
    expiresAt: now + payload.expires_in * 1000,
    refreshExpiresAt: now + payload.refresh_expires_in * 1000,
  };
  await env.METADATA.put(TOKEN_KEY, await encryptJson(refreshed, env.OAUTH_ENCRYPTION_KEY));
  return refreshed;
}

async function fetchDisplayName(accessToken: string): Promise<string | undefined> {
  const response = await fetch("https://open.tiktokapis.com/v2/user/info/?fields=display_name", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return undefined;
  const payload = (await response.json()) as { data?: { user?: { display_name?: string } } };
  return payload.data?.user?.display_name;
}

function isCompleteTokenResponse(payload: TikTokTokenResponse): payload is Required<
  Pick<
    TikTokTokenResponse,
    "access_token" | "refresh_token" | "open_id" | "scope" | "expires_in" | "refresh_expires_in"
  >> & TikTokTokenResponse {
  return Boolean(
    payload.access_token &&
      payload.refresh_token &&
      payload.open_id &&
      payload.scope &&
      payload.expires_in &&
      payload.refresh_expires_in,
  );
}

function hasRequiredScopes(scope: string): boolean {
  const granted = new Set(scope.split(",").map((value) => value.trim()));
  return granted.has("user.info.basic") && granted.has("video.publish");
}

function requireConfiguration(env: Env): void {
  if (!tiktokLoginKitConfigured(env)) {
    throw new Error("TikTok OAuth is not fully configured.");
  }
}

function redirectUri(env: Env): string {
  return `${env.APP_BASE_URL.replace(/\/$/u, "")}/api/oauth/tiktok/callback`;
}

function redirect(env: Env, result: "connected" | "error", message?: string): Response {
  return oauthRedirect(env, "tiktok", result, STATE_COOKIE, COOKIE_PATH, message);
}
