# Milestone 4: scheduled posts and reconciliation

Milestone 4 keeps the single Worker, KV namespace, and R2 bucket. It adds one free Cloudflare Cron Trigger (`*/5 * * * *`) and no database, queue, container, or paid Cloudflare product.

## Provider timing

- YouTube uploads immediately and uses native `status.publishAt` scheduling.
- A future Instagram or TikTok post remains pending in KV. The cron sends it through the official publishing API at the first run at or after the selected time (normally within five minutes).
- Instagram creates a Reel container from short-lived signed R2 URLs, waits for provider processing, publishes, and verifies the media.
- TikTok queries creator settings at dispatch, initializes Direct Post with `FILE_UPLOAD`, and streams sequential 5–64 MiB chunks from R2. Uploads remain `SELF_ONLY` while the app is unaudited. TikTok also requires every posting account to be Private until the client passes audit.
- Leaving publish time blank is supported for Instagram/TikTok-only jobs and publishes immediately. YouTube still requires a future native schedule.

## Storage safety

The 8,000,000,000-byte application cap still includes stored objects and active reservations. New keys are split by intent:

- `staging/<job-id>/...` — abandoned staging fallback; R2 expires these after seven days.
- `scheduled/<job-id>/...` — retained until dispatch or cancellation; these are not covered by a fixed seven-day lifecycle.
- `uploads/<job-id>/...` — legacy staging keys; kept under the seven-day fallback.

The scheduler reconciles storage on every run. It preserves media for a valid scheduled Instagram/TikTok job, deletes released/terminal-job media immediately, gives an interrupted active upload a two-hour grace period, deletes stray replacement objects, and deletes jobless staging objects after seven days. System Status reports pending versus orphan/staging media and records cleanup events.

The intended lifecycle rules are:

```sh
npx wrangler r2 bucket lifecycle remove social-uploader --name delete-temporary-objects
npx wrangler r2 bucket lifecycle add social-uploader delete-staging-objects staging/ --expire-days 7 --force
npx wrangler r2 bucket lifecycle add social-uploader delete-legacy-uploads uploads/ --expire-days 7 --force
npx wrangler r2 bucket lifecycle list social-uploader
```

## Instagram OAuth

Instagram Login uses only the Instagram-specific credentials shown under **Instagram → API setup with Instagram login**:

```sh
npx wrangler secret put INSTAGRAM_APP_ID
npx wrangler secret put INSTAGRAM_APP_SECRET
```

The callback remains:

```text
https://social-uploader.nodatlaspour.workers.dev/api/oauth/instagram/callback
```

The requested scopes remain only `instagram_business_basic` and `instagram_business_content_publish`.

Every new connection verifies both permissions from the authorization and resolves the current Instagram account through that exact token's `/me?fields=id,user_id,username,account_type` response. The app-scoped `id` and professional `user_id` are stored separately; only `user_id` is used for media creation and publishing. The completed callback atomically replaces any prior encrypted connection without comparing old or new IDs. Tokens saved before this verification format require one reconnect. Publishing errors record the failing Graph stage plus Meta error code/subcode without logging the token.

## Cover compatibility

The dashboard accepts JPG, PNG, and WebP covers. When Instagram is selected, the browser converts a non-JPEG or oversized cover to JPEG and progressively compresses/resizes it below Instagram's 8 MiB limit before staging. A WebP is also converted when YouTube needs the same file. The original browser-selected file is retained in memory, and no image-processing service or server dependency is used.

## TikTok consent and diagnostics

TikTok Direct Post requires an explicit consent checkbox before a new immediate or scheduled job is accepted. The Worker verifies the stored token still includes `video.publish`, queries `creator_info` immediately before initialization, requires `SELF_ONLY` to appear in the returned privacy options, and uses the documented FILE_UPLOAD chunk calculation. Errors include the failing endpoint stage, `error.code`, message, and `log_id` in the visible response and System Status event.

## Scheduled-post management

The Scheduled posts page lists pending posts with cover, metadata, destinations, due time, per-platform state, and source size.

- Edit updates title, caption, time, destination selection, supported platform settings, and optional cover.
- Existing YouTube schedules are updated through `videos.update`; replacement thumbnails use `thumbnails.set`.
- Adding YouTube while the R2 source still exists uploads and schedules it immediately.
- Removing YouTube deletes its private scheduled video.
- Cancel/delete first removes the scheduled YouTube video when present, marks all destinations cancelled, and deletes R2 media.
- Already-dispatched or published Instagram/TikTok posts are intentionally not editable or deletable here.

When a YouTube-only job has already released its source media, metadata, publish time, settings, and thumbnail can still be updated, but another video platform cannot be added without the released source. This preserves the requirement to delete temporary media as soon as every selected platform no longer needs it.

## Status and operational limits

System Status shows pending count, next publish, total R2 use, pending media, orphan/staging media, recent scheduler runs, per-platform outcomes, jobs, and cleanup/error events.

- Cron timing is Cloudflare-managed and can be several minutes late; it is not a real-time queue.
- TikTok Direct Post upload URLs are encrypted while resumable chunk state is stored in KV.
- Provider failures retry on later scheduler runs and become terminal after three failed attempts.
- R2 remains transfer storage, not an archive. Cancelling a post is destructive and requires browser confirmation.
