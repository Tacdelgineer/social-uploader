# Step 03 - Instagram Reels and TikTok Direct Post

> Historical milestone note: Milestone 4 replaces the immediate-only Instagram/TikTok behavior and bucket-wide lifecycle described below. See `step-04-scheduled-posts.md` for the current design.

## Architecture

Milestone 3 keeps the existing Cloudflare Worker, Workers KV, and private R2 bucket. It adds no server, database, queue, container, paid Cloudflare feature, or mini-PC process.

1. The browser stages one MP4 and one cover in private R2 through exact-size signed uploads. The existing 8,000,000,000-byte application cap and bucket-wide seven-day lifecycle still apply.
2. The selected provider flows run sequentially so one browser session can report clear per-platform results. A provider failure does not prevent the remaining selected providers from being attempted.
3. YouTube still receives a direct browser upload, stores it privately, applies its native schedule and custom thumbnail, and is verified before releasing its need for R2.
4. Instagram receives 30-minute signed R2 GET URLs for the MP4 and JPEG cover. The Worker creates a `REELS` container on `graph.instagram.com/v26.0`, polls no more than once per minute, marks the source released when the container is `FINISHED`, publishes it, and verifies the returned media ID.
5. TikTok creator info is queried in the UI and again immediately before posting. The Worker forces `SELF_ONLY`, initializes Direct Post with `source=FILE_UPLOAD`, and returns TikTok's one-hour upload URL. The browser uploads sequential 5-64 MiB-compatible chunks with `Content-Range`, then the Worker polls the official status endpoint.
6. R2 video and cover objects are deleted as soon as every selected provider has released the source: YouTube after schedule verification, Instagram after its container finishes fetching, and TikTok after FILE_UPLOAD completes. Publishing/processing status can continue after a provider no longer needs R2.
7. OAuth access and refresh tokens are AES-256-GCM encrypted in Workers KV. App secrets remain Cloudflare Worker secrets. OAuth state is signed, expires after ten minutes, and is paired with an HttpOnly/Secure/SameSite cookie.

## Provider setup

The deployed Worker requires these existing encrypted secrets:

```sh
npx wrangler secret put INSTAGRAM_APP_ID
npx wrangler secret put INSTAGRAM_APP_SECRET
npx wrangler secret put TIKTOK_CLIENT_KEY
npx wrangler secret put TIKTOK_CLIENT_SECRET
```

Instagram must use **Instagram API with Instagram Login** with only:

- `instagram_business_basic`
- `instagram_business_content_publish`

The exact callback is:

```text
https://social-uploader.nodatlaspour.workers.dev/api/oauth/instagram/callback
```

TikTok must use the Web platform with Login Kit, Content Posting API, and Direct Post enabled, with only:

- `user.info.basic`
- `video.publish`

The exact callback is:

```text
https://social-uploader.nodatlaspour.workers.dev/api/oauth/tiktok/callback
```

No messaging or comment-management permission is requested from Meta. TikTok's `video.upload` scope is not requested because this integration uses Direct Post under `video.publish`.

## Media and UI behavior

- The shared caption is the Instagram Reel caption and TikTok Direct Post `title`; it remains the YouTube description.
- Instagram uses the uploaded JPEG as `cover_url`, optionally shares the Reel to feed, and publishes immediately.
- Selecting Instagram enforces the current API limits used here: MP4 up to 300 MiB, duration from 3 seconds through 15 minutes, and a JPEG cover up to 8 MiB.
- TikTok offers comments, Duet, and Stitch only when the latest creator-info response allows them. Privacy is visibly locked to `SELF_ONLY` while the app is unaudited. Cover frame is an official millisecond timestamp into the video; TikTok does not accept the uploaded image as a Direct Post cover.
- The entered date/time applies only to YouTube. Instagram and TikTok publish immediately on submission because their Direct Post APIs do not accept a scheduled publish time.
- Per-platform IDs, processing states, failures, cleanup outcome, and provider log/error details appear in the upload result and System Status event log.

## Verification

```sh
npm run check
npm run deploy
```

After deployment, manually test Connect/Reconnect/Disconnect for both providers, then test each destination alone and all three together. Confirm the Instagram Reel cover/caption, the TikTok privacy choice and selected interaction flags/cover timestamp, the YouTube native schedule, and that System Status reports zero temporary media objects after every selected transfer has released the source.

## Current limitations

- Instagram and TikTok do not use the entered schedule; both publish immediately. A future local worker or another explicitly approved scheduler would be required to defer those Direct Post calls.
- Instagram's URL-based Reel ingestion requires an MP4 no larger than 300 MiB and a JPEG cover no larger than 8 MiB in this implementation.
- TikTok unaudited-client posts remain private (`SELF_ONLY`). The dashboard deliberately does not expose or send broader privacy values until TikTok approves the app.
- TikTok receives the local browser file through official FILE_UPLOAD; the R2 copy is not exposed to TikTok and is only the shared transfer/failure fallback.
- Instagram processing is checked once per minute for five minutes. TikTok is checked every five seconds for five minutes. If a provider is still processing, its persisted job remains visible, but there is not yet a resume/retry control or background queue.
- Failed transfers retain R2 media for diagnosis until the seven-day lifecycle removes it. There is no retry UI in this milestone.
