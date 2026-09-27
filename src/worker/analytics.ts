import type {
  AnalyticsMetrics,
  AnalyticsPost,
  AnalyticsSnapshot,
  AnalyticsTrendPoint,
  Platform,
  PlatformAnalytics,
} from "../shared/contracts";
import type { Env } from "./env";
import { getInstagramCredentials } from "./instagram-oauth";
import { getYouTubeAnalyticsAccessToken } from "./oauth";
import { getTikTokCredentials } from "./tiktok-oauth";

const CACHE_SECONDS = 10 * 60;
const YOUTUBE_METRICS = [
  "views", "engagedViews", "likes", "comments", "shares", "estimatedMinutesWatched",
  "averageViewDuration", "averageViewPercentage", "subscribersGained", "subscribersLost",
] as const;
const YOUTUBE_METRICS_WITHOUT_ENGAGED = YOUTUBE_METRICS.filter((metric) => metric !== "engagedViews");

interface RangeInput { start: string; end: string; label: string }
interface YouTubeReport { columnHeaders?: Array<{ name: string }>; rows?: Array<Array<string | number>> }
interface InstagramMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
}
interface TikTokVideo {
  id: string;
  title?: string;
  video_description?: string;
  create_time?: number;
  share_url?: string;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  share_count?: number;
}

export async function getAnalyticsSnapshot(
  env: Env,
  range: RangeInput,
  refresh = false,
): Promise<AnalyticsSnapshot> {
  validateRange(range);
  const cacheKey = `analytics:v1:${range.start}:${range.end}`;
  if (!refresh) {
    const cached = await env.METADATA.get<AnalyticsSnapshot>(cacheKey, "json");
    if (cached) return cached;
  }

  const results = await Promise.allSettled([
    getYouTubeAnalytics(env, range),
    getInstagramAnalytics(env, range),
    getTikTokAnalytics(env, range),
  ]);
  const platforms = {} as Record<Platform, PlatformAnalytics>;
  const limitations: string[] = [];
  for (const [index, platform] of (["youtube", "instagram", "tiktok"] as Platform[]).entries()) {
    const result = results[index]!;
    platforms[platform] = result.status === "fulfilled"
      ? result.value
      : unavailableFromError(result.reason);
    if (platforms[platform].message) limitations.push(`${capitalize(platform)}: ${platforms[platform].message}`);
  }
  const snapshot: AnalyticsSnapshot = {
    generatedAt: new Date().toISOString(),
    range,
    platforms,
    limitations,
  };
  await env.METADATA.put(cacheKey, JSON.stringify(snapshot), { expirationTtl: CACHE_SECONDS });
  return snapshot;
}

export function parseAnalyticsRange(url: URL, now = new Date()): RangeInput | null {
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  const label = (url.searchParams.get("label") ?? "custom").slice(0, 30);
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/u.test(start) || !/^\d{4}-\d{2}-\d{2}$/u.test(end)) return null;
  const endDate = new Date(`${end}T23:59:59.999Z`);
  if (endDate.getTime() > now.getTime() + 24 * 60 * 60 * 1000) return null;
  try { validateRange({ start, end, label }); } catch { return null; }
  return { start, end, label };
}

async function getYouTubeAnalytics(env: Env, range: RangeInput): Promise<PlatformAnalytics> {
  let accessToken: string;
  try { accessToken = await getYouTubeAnalyticsAccessToken(env); }
  catch (error) {
    const detail = errorMessage(error);
    return platformUnavailable(
      detail.includes("Reconnect YouTube") ? "additional_permission_required" : "not_connected",
      detail,
      allMetricNames(),
    );
  }

  const channelUrl = new URL("https://www.googleapis.com/youtube/v3/channels");
  channelUrl.search = new URLSearchParams({ part: "snippet", mine: "true" }).toString();
  const channelPayload = await providerJson<{ items?: Array<{ snippet?: { title?: string } }> }>(channelUrl, accessToken);
  const missing: string[] = [];
  const totalsReport = await youtubeReportWithFallback(accessToken, range, {}, missing);
  const dailyReport = await youtubeReportWithFallback(accessToken, range, { dimensions: "day", sort: "day" }, missing);
  const videosReport = await youtubeReportWithFallback(accessToken, range, { dimensions: "video", sort: "-views", maxResults: "200" }, missing);
  const videoRows = reportRows(videosReport);
  const ids = videoRows.map((row) => String(row.video ?? "")).filter(Boolean);
  const details = await getYouTubeVideoDetails(accessToken, ids);
  const posts: AnalyticsPost[] = videoRows.map((row) => {
    const id = String(row.video ?? "");
    const snippet = details.get(id);
    return {
      platform: "youtube", providerPostId: id, title: snippet?.title ?? id,
      description: snippet?.description ?? "", publishedAt: snippet?.publishedAt ?? "",
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
      metrics: metricsFromYouTubeRow(row),
    };
  });
  const totalsRow = reportRows(totalsReport)[0] ?? {};
  const trend: AnalyticsTrendPoint[] = reportRows(dailyReport).map((row) => ({
    date: String(row.day), views: numeric(row.views), engagedViews: numeric(row.engagedViews),
    likes: numeric(row.likes), comments: numeric(row.comments), shares: numeric(row.shares),
    watchMinutes: numeric(row.estimatedMinutesWatched),
  }));
  return {
    available: true, status: "available", account: channelPayload.items?.[0]?.snippet?.title ?? "YouTube channel",
    totals: metricsFromYouTubeRow(totalsRow), posts, trend, missingMetrics: [...new Set(missing)],
  };
}

async function youtubeReportWithFallback(
  accessToken: string,
  range: RangeInput,
  parameters: Record<string, string>,
  missing: string[],
): Promise<YouTubeReport> {
  try { return await queryYouTubeAnalytics(accessToken, range, YOUTUBE_METRICS, parameters); }
  catch (error) {
    if (!errorMessage(error).includes("engagedViews")) throw error;
    missing.push("engagedViews");
    return queryYouTubeAnalytics(accessToken, range, YOUTUBE_METRICS_WITHOUT_ENGAGED, parameters);
  }
}

async function queryYouTubeAnalytics(
  accessToken: string,
  range: RangeInput,
  metrics: readonly string[],
  parameters: Record<string, string>,
): Promise<YouTubeReport> {
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.search = new URLSearchParams({
    ids: "channel==MINE", startDate: range.start, endDate: range.end,
    metrics: metrics.join(","), ...parameters,
  }).toString();
  return providerJson<YouTubeReport>(url, accessToken);
}

async function getYouTubeVideoDetails(
  accessToken: string,
  ids: string[],
): Promise<Map<string, { title: string; description: string; publishedAt: string }>> {
  const result = new Map<string, { title: string; description: string; publishedAt: string }>();
  for (let index = 0; index < ids.length; index += 50) {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.search = new URLSearchParams({ part: "snippet", id: ids.slice(index, index + 50).join(",") }).toString();
    const payload = await providerJson<{ items?: Array<{ id: string; snippet?: { title?: string; description?: string; publishedAt?: string } }> }>(url, accessToken);
    for (const item of payload.items ?? []) result.set(item.id, { title: item.snippet?.title ?? item.id, description: item.snippet?.description ?? "", publishedAt: item.snippet?.publishedAt ?? "" });
  }
  return result;
}

async function getInstagramAnalytics(env: Env, range: RangeInput): Promise<PlatformAnalytics> {
  let credentials;
  try { credentials = await getInstagramCredentials(env); }
  catch (error) { return platformUnavailable("not_connected", errorMessage(error), allMetricNames()); }
  const hasInsights = credentials.permissions.includes("instagram_business_manage_insights");
  const fields = "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count";
  const url = new URL(`https://graph.instagram.com/v26.0/${encodeURIComponent(credentials.userId)}/media`);
  url.search = new URLSearchParams({ fields, limit: "100" }).toString();
  const payload = await providerJson<{ data?: InstagramMedia[] }>(url, credentials.accessToken);
  const posts: AnalyticsPost[] = [];
  for (const media of payload.data ?? []) {
    if (!media.timestamp || media.timestamp.slice(0, 10) < range.start || media.timestamp.slice(0, 10) > range.end) continue;
    const insights = hasInsights ? await getInstagramMediaInsights(media.id, credentials.accessToken) : {};
    posts.push({
      platform: "instagram", providerPostId: media.id,
      title: firstLine(media.caption) || `${media.media_product_type ?? media.media_type ?? "Instagram"} post`,
      description: media.caption ?? "", publishedAt: media.timestamp, url: media.permalink,
      metrics: {
        ...emptyMetrics(), views: numeric(insights.views), likes: numeric(insights.likes) ?? media.like_count ?? null,
        comments: numeric(insights.comments) ?? media.comments_count ?? null, shares: numeric(insights.shares),
        watchMinutes: numeric(insights.ig_reels_video_view_total_time) === null ? null : Number(insights.ig_reels_video_view_total_time) / 60_000,
        averageViewDurationSeconds: numeric(insights.ig_reels_avg_watch_time) === null ? null : Number(insights.ig_reels_avg_watch_time) / 1000,
      },
    });
  }
  const missing = ["engagedViews", "averageViewPercentage", "subscribersGained", "subscribersLost"];
  if (!hasInsights) missing.push("views", "shares", "watchMinutes", "averageViewDurationSeconds");
  return {
    available: true, status: hasInsights ? "available" : "additional_permission_required",
    account: credentials.username ? `@${credentials.username}` : "Instagram account",
    message: hasInsights ? "Metrics are current per-post totals for posts published in the selected range."
      : "Basic owned-media data is available. Add Advanced Access for instagram_business_manage_insights in Meta App Dashboard, then reconnect Instagram for Reel views, shares, and watch metrics.",
    totals: sumPostMetrics(posts), posts, trend: [], missingMetrics: missing,
  };
}

async function getInstagramMediaInsights(mediaId: string, accessToken: string): Promise<Record<string, number>> {
  const url = new URL(`https://graph.instagram.com/v26.0/${encodeURIComponent(mediaId)}/insights`);
  url.search = new URLSearchParams({ metric: "views,likes,comments,shares,ig_reels_avg_watch_time,ig_reels_video_view_total_time" }).toString();
  try {
    const payload = await providerJson<{ data?: Array<{ name: string; values?: Array<{ value?: number }>; total_value?: { value?: number } }> }>(url, accessToken);
    return Object.fromEntries((payload.data ?? []).map((metric) => [metric.name, metric.total_value?.value ?? metric.values?.[0]?.value ?? 0]));
  } catch { return {}; }
}

async function getTikTokAnalytics(env: Env, range: RangeInput): Promise<PlatformAnalytics> {
  let credentials;
  try { credentials = await getTikTokCredentials(env); }
  catch (error) { return platformUnavailable("not_connected", errorMessage(error), allMetricNames()); }
  if (!new Set(credentials.scope.split(",").map((value) => value.trim())).has("video.list")) {
    return platformUnavailable(
      "additional_permission_required",
      "In TikTok Developer Portal, open this app, add the Display API video.list scope under Scopes, submit/complete approval if prompted, then reconnect TikTok.",
      ["views", "likes", "comments", "shares", "watchMinutes", "averageViewDurationSeconds", "averageViewPercentage", "subscribersGained", "subscribersLost", "engagedViews"],
      credentials.displayName,
    );
  }
  const posts: AnalyticsPost[] = [];
  let cursor: number | undefined;
  for (let page = 0; page < 5; page += 1) {
    const url = new URL("https://open.tiktokapis.com/v2/video/list/");
    url.searchParams.set("fields", "id,title,video_description,create_time,share_url,view_count,like_count,comment_count,share_count");
    const response = await fetch(url, {
      method: "POST", headers: { authorization: `Bearer ${credentials.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ max_count: 20, ...(cursor ? { cursor } : {}) }),
    });
    const payload = await response.json() as { data?: { videos?: TikTokVideo[]; cursor?: number; has_more?: boolean }; error?: { code?: string; message?: string } };
    if (!response.ok || (payload.error?.code && payload.error.code !== "ok")) throw new Error(payload.error?.message ?? `TikTok video.list failed (HTTP ${response.status}).`);
    const videos = payload.data?.videos ?? [];
    for (const video of videos) {
      const publishedAt = video.create_time ? new Date(video.create_time * 1000).toISOString() : "";
      if (publishedAt.slice(0, 10) < range.start || publishedAt.slice(0, 10) > range.end) continue;
      posts.push({
        platform: "tiktok", providerPostId: video.id, title: video.title || firstLine(video.video_description) || video.id,
        description: video.video_description ?? "", publishedAt, url: video.share_url,
        metrics: { ...emptyMetrics(), views: video.view_count ?? null, likes: video.like_count ?? null, comments: video.comment_count ?? null, shares: video.share_count ?? null },
      });
    }
    if (!payload.data?.has_more || !payload.data.cursor || videos.some((video) => video.create_time && new Date(video.create_time * 1000).toISOString().slice(0, 10) < range.start)) break;
    cursor = payload.data.cursor;
  }
  return {
    available: true, status: "available", account: credentials.displayName ?? "TikTok account",
    message: "Display API metrics are current lifetime totals for public videos created in the selected range; daily historical performance is unavailable.",
    totals: sumPostMetrics(posts), posts, trend: [],
    missingMetrics: ["engagedViews", "watchMinutes", "averageViewDurationSeconds", "averageViewPercentage", "subscribersGained", "subscribersLost"],
  };
}

function reportRows(report: YouTubeReport): Array<Record<string, string | number>> {
  const headers = report.columnHeaders?.map((header) => header.name) ?? [];
  return (report.rows ?? []).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? 0])));
}

function metricsFromYouTubeRow(row: Record<string, string | number>): AnalyticsMetrics {
  return {
    views: numeric(row.views), engagedViews: numeric(row.engagedViews), likes: numeric(row.likes),
    comments: numeric(row.comments), shares: numeric(row.shares), watchMinutes: numeric(row.estimatedMinutesWatched),
    averageViewDurationSeconds: numeric(row.averageViewDuration), averageViewPercentage: numeric(row.averageViewPercentage),
    subscribersGained: numeric(row.subscribersGained), subscribersLost: numeric(row.subscribersLost),
  };
}

function sumPostMetrics(posts: AnalyticsPost[]): AnalyticsMetrics {
  const total = emptyMetrics();
  for (const key of ["views", "engagedViews", "likes", "comments", "shares", "watchMinutes", "subscribersGained", "subscribersLost"] as const) {
    const values = posts.map((post) => post.metrics[key]).filter((value): value is number => value !== null);
    total[key] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  }
  const weightedViews = posts.reduce((sum, post) => sum + (post.metrics.views ?? 0), 0);
  for (const key of ["averageViewDurationSeconds", "averageViewPercentage"] as const) {
    const usable = posts.filter((post) => post.metrics[key] !== null);
    total[key] = usable.length ? usable.reduce((sum, post) => sum + post.metrics[key]! * Math.max(1, post.metrics.views ?? 1), 0) / Math.max(1, weightedViews) : null;
  }
  return total;
}

function platformUnavailable(status: PlatformAnalytics["status"], message: string, missingMetrics: string[], account?: string): PlatformAnalytics {
  return { available: false, status, account, message, totals: emptyMetrics(), posts: [], trend: [], missingMetrics };
}
function unavailableFromError(error: unknown): PlatformAnalytics { return platformUnavailable("error", errorMessage(error), allMetricNames()); }
function emptyMetrics(): AnalyticsMetrics { return { views: null, engagedViews: null, likes: null, comments: null, shares: null, watchMinutes: null, averageViewDurationSeconds: null, averageViewPercentage: null, subscribersGained: null, subscribersLost: null }; }
function allMetricNames(): string[] { return Object.keys(emptyMetrics()); }
function numeric(value: unknown): number | null { const number = typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : NaN; return Number.isFinite(number) ? number : null; }
function firstLine(value?: string): string { return (value ?? "").split(/\r?\n/u)[0]?.slice(0, 100) ?? ""; }
function capitalize(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Provider analytics request failed."; }
function validateRange(range: RangeInput): void {
  const start = new Date(`${range.start}T00:00:00.000Z`).getTime();
  const end = new Date(`${range.end}T23:59:59.999Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end - start > 366 * 24 * 60 * 60 * 1000) throw new Error("Analytics range must be valid and no longer than 366 days.");
}
async function providerJson<T>(url: URL, accessToken: string): Promise<T> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  const payload = await response.json() as T & { error?: { message?: string; errors?: Array<{ message?: string }> } };
  if (!response.ok) throw new Error(payload.error?.message ?? payload.error?.errors?.[0]?.message ?? `Provider request failed (HTTP ${response.status}).`);
  return payload;
}
