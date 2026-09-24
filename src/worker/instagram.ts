import type { DraftRequest } from "../shared/contracts";
import { providerError } from "./oauth-common";

const GRAPH_ROOT = "https://graph.instagram.com/v26.0";

interface GraphResponse {
  id?: string;
  error?: { message?: string; code?: number; error_subcode?: number };
}

interface ContainerResponse extends GraphResponse {
  status_code?: string;
  status?: string;
}

export async function createInstagramReelContainer(
  input: DraftRequest,
  userId: string,
  accessToken: string,
  videoUrl: string,
  coverUrl: string,
): Promise<string> {
  const response = await fetch(`${GRAPH_ROOT}/${encodeURIComponent(userId)}/media`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      media_type: "REELS",
      video_url: videoUrl,
      cover_url: coverUrl,
      caption: input.description,
      share_to_feed: String(input.instagram.shareToFeed),
    }),
  });
  const payload = (await response.json()) as GraphResponse;
  if (!response.ok || !payload.id) {
    throw new Error(providerError(payload, `Instagram rejected the Reel container (HTTP ${response.status}).`));
  }
  return payload.id;
}

export async function getInstagramContainerStatus(
  containerId: string,
  accessToken: string,
): Promise<{ statusCode: string; detail?: string }> {
  const url = new URL(`${GRAPH_ROOT}/${encodeURIComponent(containerId)}`);
  url.searchParams.set("fields", "status_code,status");
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  const payload = (await response.json()) as ContainerResponse;
  if (!response.ok || !payload.status_code) {
    throw new Error(providerError(payload, `Could not read Instagram Reel status (HTTP ${response.status}).`));
  }
  return { statusCode: payload.status_code, detail: payload.status };
}

export async function publishInstagramReel(
  userId: string,
  containerId: string,
  accessToken: string,
): Promise<string> {
  const response = await fetch(`${GRAPH_ROOT}/${encodeURIComponent(userId)}/media_publish`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ creation_id: containerId }),
  });
  const payload = (await response.json()) as GraphResponse;
  if (!response.ok || !payload.id) {
    throw new Error(providerError(payload, `Instagram could not publish the Reel (HTTP ${response.status}).`));
  }
  return payload.id;
}

export async function verifyInstagramReel(
  mediaId: string,
  accessToken: string,
): Promise<string[]> {
  const url = new URL(`${GRAPH_ROOT}/${encodeURIComponent(mediaId)}`);
  url.searchParams.set("fields", "id,media_type,media_product_type,permalink");
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  const payload = (await response.json()) as GraphResponse & {
    media_type?: string;
    media_product_type?: string;
    permalink?: string;
  };
  if (!response.ok || payload.id !== mediaId) {
    return [providerError(payload, "Instagram published the Reel, but verification was unavailable.")];
  }
  return payload.media_product_type === "REELS" || payload.media_type === "VIDEO"
    ? []
    : ["Instagram published the media, but did not identify it as a Reel in verification."];
}
