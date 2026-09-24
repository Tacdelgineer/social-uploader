import type { Env } from "./env";

export function readCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie")?.split(";") ?? [];
  for (const cookie of cookies) {
    const [cookieName, ...value] = cookie.trim().split("=");
    if (cookieName === name) return value.join("=");
  }
  return null;
}

export function oauthRedirect(
  env: Env,
  platform: "youtube" | "instagram" | "tiktok",
  result: "connected" | "error",
  cookieName: string,
  cookiePath: string,
  message?: string,
): Response {
  const destination = new URL(env.APP_BASE_URL);
  destination.searchParams.set(platform, result);
  if (message) destination.searchParams.set("message", message.slice(0, 300));
  return new Response(null, {
    status: 302,
    headers: {
      location: destination.toString(),
      "cache-control": "no-store",
      "set-cookie": `${cookieName}=; HttpOnly; Secure; SameSite=Lax; Path=${cookiePath}; Max-Age=0`,
    },
  });
}

export function oauthStateCookie(name: string, nonce: string, path: string): string {
  return `${name}=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=600`;
}

export function providerError(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) return fallback;
  const value = payload as {
    error?: string | { message?: string; code?: string };
    error_description?: string;
    message?: string;
  };
  if (typeof value.error === "object" && value.error?.message) return value.error.message;
  if (typeof value.error === "string") return value.error_description ?? value.error;
  return value.error_description ?? value.message ?? fallback;
}
