import type { YouTubeConnectionStatus } from "../shared/contracts";
import { createSignedState, decryptJson, encryptJson, verifySignedState } from "./crypto";
import type { Env } from "./env";

const TOKEN_KEY = "oauth:youtube";
const STATE_COOKIE = "youtube_oauth_state";
const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const YOUTUBE_READ_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const YOUTUBE_ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";
const YOUTUBE_SCOPES = [YOUTUBE_UPLOAD_SCOPE, YOUTUBE_READ_SCOPE, YOUTUBE_ANALYTICS_SCOPE].join(" ");

interface StoredTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  tokenType: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export async function beginYouTubeOAuth(env: Env): Promise<Response> {
  requireOAuthConfiguration(env);
  const { state, nonce } = await createSignedState(env.SESSION_SECRET);
  const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizeUrl.search = new URLSearchParams({
    client_id: env.YOUTUBE_CLIENT_ID,
    redirect_uri: redirectUri(env),
    response_type: "code",
    scope: YOUTUBE_SCOPES,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  }).toString();

  return new Response(null, {
    status: 302,
    headers: {
      location: authorizeUrl.toString(),
      "cache-control": "no-store",
      "set-cookie": `${STATE_COOKIE}=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/youtube; Max-Age=600`,
    },
  });
}

export async function finishYouTubeOAuth(request: Request, env: Env): Promise<Response> {
  requireOAuthConfiguration(env);
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const nonce = readCookie(request, STATE_COOKIE);
  const validState = await verifySignedState(state, nonce, env.SESSION_SECRET);
  if (!validState) return oauthRedirect(env, "error", "OAuth state validation failed.");

  const providerError = url.searchParams.get("error");
  if (providerError) return oauthRedirect(env, "error", `Google authorization failed: ${providerError}`);
  const code = url.searchParams.get("code");
  if (!code) return oauthRedirect(env, "error", "Google did not return an authorization code.");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.YOUTUBE_CLIENT_ID,
      client_secret: env.YOUTUBE_CLIENT_SECRET,
      redirect_uri: redirectUri(env),
      grant_type: "authorization_code",
    }),
  });
  const payload = (await response.json()) as GoogleTokenResponse;
  if (!response.ok || !payload.access_token || !payload.refresh_token || !payload.expires_in) {
    return oauthRedirect(
      env,
      "error",
      payload.error_description ?? payload.error ?? "Google token exchange failed.",
    );
  }

  const tokens: StoredTokenSet = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
    scope: payload.scope ?? YOUTUBE_SCOPES,
    tokenType: payload.token_type ?? "Bearer",
  };
  await env.METADATA.put(TOKEN_KEY, await encryptJson(tokens, env.OAUTH_ENCRYPTION_KEY));
  return oauthRedirect(env, "connected");
}

export async function youtubeConnectionStatus(env: Env): Promise<YouTubeConnectionStatus> {
  try {
    await getYouTubeAccessToken(env);
    const tokens = await loadYouTubeTokens(env);
    const analyticsAvailable = hasScopes(tokens.scope, YOUTUBE_READ_SCOPE, YOUTUBE_ANALYTICS_SCOPE);
    return { connected: true, analyticsAvailable, requiresAnalyticsReconnect: !analyticsAvailable };
  } catch {
    return { connected: false };
  }
}

export async function getYouTubeAnalyticsAccessToken(env: Env): Promise<string> {
  const accessToken = await getYouTubeAccessToken(env);
  const tokens = await loadYouTubeTokens(env);
  if (!hasScopes(tokens.scope, YOUTUBE_READ_SCOPE, YOUTUBE_ANALYTICS_SCOPE)) {
    throw new Error("Reconnect YouTube once to grant read-only channel and analytics access.");
  }
  return accessToken;
}

export async function disconnectYouTube(env: Env): Promise<void> {
  const encrypted = await env.METADATA.get(TOKEN_KEY);
  if (encrypted) {
    try {
      const tokens = await decryptJson<StoredTokenSet>(encrypted, env.OAUTH_ENCRYPTION_KEY);
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.refreshToken)}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
    } catch {
      // Local deletion still disconnects the app if Google is temporarily unavailable.
    }
  }
  await env.METADATA.delete(TOKEN_KEY);
}

export async function getYouTubeAccessToken(env: Env): Promise<string> {
  requireOAuthConfiguration(env);
  const tokens = await loadYouTubeTokens(env);
  if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.YOUTUBE_CLIENT_ID,
      client_secret: env.YOUTUBE_CLIENT_SECRET,
      refresh_token: tokens.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const payload = (await response.json()) as GoogleTokenResponse;
  if (!response.ok || !payload.access_token || !payload.expires_in) {
    throw new Error(payload.error_description ?? payload.error ?? "YouTube authorization expired. Reconnect YouTube.");
  }
  const refreshed: StoredTokenSet = {
    ...tokens,
    accessToken: payload.access_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
    scope: payload.scope ?? tokens.scope,
    tokenType: payload.token_type ?? tokens.tokenType,
  };
  await env.METADATA.put(TOKEN_KEY, await encryptJson(refreshed, env.OAUTH_ENCRYPTION_KEY));
  return refreshed.accessToken;
}

async function loadYouTubeTokens(env: Env): Promise<StoredTokenSet> {
  const encrypted = await env.METADATA.get(TOKEN_KEY);
  if (!encrypted) throw new Error("Connect YouTube before submitting a job.");
  return decryptJson<StoredTokenSet>(encrypted, env.OAUTH_ENCRYPTION_KEY);
}

function hasScopes(value: string, ...required: string[]): boolean {
  const scopes = new Set(value.split(/\s+/u).filter(Boolean));
  return required.every((scope) => scopes.has(scope));
}

function requireOAuthConfiguration(env: Env): void {
  if (
    !env.YOUTUBE_CLIENT_ID ||
    !env.YOUTUBE_CLIENT_SECRET ||
    !env.OAUTH_ENCRYPTION_KEY ||
    !env.SESSION_SECRET ||
    !env.APP_BASE_URL
  ) {
    throw new Error("YouTube OAuth is not fully configured.");
  }
}

function redirectUri(env: Env): string {
  return `${env.APP_BASE_URL.replace(/\/$/u, "")}/api/oauth/youtube/callback`;
}

function oauthRedirect(env: Env, result: "connected" | "error", message?: string): Response {
  const destination = new URL(env.APP_BASE_URL);
  destination.searchParams.set("youtube", result);
  if (message) destination.searchParams.set("message", message.slice(0, 300));
  return new Response(null, {
    status: 302,
    headers: {
      location: destination.toString(),
      "cache-control": "no-store",
      "set-cookie": `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/youtube; Max-Age=0`,
    },
  });
}

function readCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie")?.split(";") ?? [];
  for (const cookie of cookies) {
    const [cookieName, ...value] = cookie.trim().split("=");
    if (cookieName === name) return value.join("=");
  }
  return null;
}
