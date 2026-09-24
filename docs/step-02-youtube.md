# Step 02 - YouTube OAuth and native scheduling

## Architecture

Social Uploader remains a small Cloudflare control plane. There is no local server, scheduler, queue, database server, Docker container, or media processor.

### Submit path

1. Cloudflare Access protects the entire Worker before the dashboard or API is reached.
2. The Worker validates one MP4 and one JPG/PNG thumbnail, then atomically reserves their exact sizes against the 8 GB application-level R2 ceiling.
3. The browser uploads both files directly to private R2 through 15-minute signed URLs. Large video bytes do not pass through the Worker.
4. The Worker creates a YouTube resumable upload session using the connected account and saves only small job metadata in Workers KV.
5. The browser sends the MP4 directly to YouTube. Google requires an OAuth authorization header for this transfer, so a short-lived access token is returned only to the authenticated page runtime; it is never written to browser storage. The refresh token and persistent token set remain AES-256-GCM encrypted in KV.
6. After YouTube returns a video ID, the Worker marks the job as processing and calls `videos.list` to verify the exact video ID, accepted upload state, private-until-publish visibility, and native `publishAt` time. This is the acceptance boundary. Returned metadata differences are warnings rather than false upload failures.
7. Only after that acceptance check succeeds, the Worker sends the small thumbnail from R2 to YouTube and deletes both temporary R2 media objects. Thumbnail or cleanup problems are recorded as warnings; they cannot turn an accepted YouTube schedule into a failed job. Failed acceptance leaves the source files intact for diagnosis/retry and the seven-day fallback.
8. The UI shows uploading, processing, scheduled, failed, or cancelled explicitly. A scheduled result includes the YouTube video ID, publish time, cleanup outcome, and any warnings. If the final response is lost, the browser re-reads the persisted job before deciding that the operation failed.

If upload or verification fails, the UI says that the temporary copy remains subject to cleanup. R2 never becomes durable scheduled-media storage: the bucket-wide seven-day lifecycle is the backstop, and every reservation is counted against the hard 8,000,000,000-byte cap.

### Storage

- **Workers KV (small, persistent):** one encrypted YouTube token record and small JSON job records. The Workers Free plan has a 1 GB storage limit and daily operation limits; when a free limit is exceeded, operations fail instead of creating paid overage.
- **R2 (temporary media only):** upload objects and the capacity ledger. Successful YouTube jobs delete their media immediately. Every object is covered by the seven-day lifecycle rule.
- **YouTube:** receives the video immediately, stores it privately, and publishes it using its native schedule.

### System Status page

The in-dashboard status view reads only the existing bindings when opened or refreshed:

- R2 lists current objects to calculate actual bytes used, percentage of the 8 GB cap, temporary object count, and oldest temporary object.
- KV supplies up to 50 recent job summaries plus a 30-day, append-only trail of the latest 50 application events. No video bytes, OAuth tokens, or secrets are exposed.
- Connection indicators report YouTube, Instagram, and TikTok token presence/status. Instagram and TikTok remain disconnected placeholders.
- A reserved mini-PC card says **Not configured**; no local worker is built yet.

Worker CPU/request analytics are intentionally omitted. The page adds no database, Analytics Engine, external monitoring service, or paid Cloudflare product.

The future mini-PC worker is not built in this milestone. It will be needed only for platforms that cannot accept a native schedule at submit time.

## Setup

Prerequisites: Node.js 20+, Wrangler authenticated to the intended Cloudflare account, the existing `social-uploader` R2 bucket, and a Google Cloud project.

### Cloudflare

Create and bind the free KV namespace if deploying to a different account:

```sh
npx wrangler kv namespace create METADATA
```

Copy its ID into `wrangler.jsonc`. Keep the existing R2 CORS policy and verify the cleanup rule:

```sh
npx wrangler r2 bucket cors set social-uploader --file r2-cors.example.json --force
npx wrangler r2 bucket lifecycle list social-uploader
```

Generate independent random secrets and store them with the existing R2 and Google values as encrypted Worker secrets:

```sh
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put YOUTUBE_CLIENT_ID
npx wrangler secret put YOUTUBE_CLIENT_SECRET
npx wrangler secret put OAUTH_ENCRYPTION_KEY
npx wrangler secret put SESSION_SECRET
```

`OAUTH_ENCRYPTION_KEY` must be base64 for exactly 32 random bytes. `SESSION_SECRET` must be at least 32 random characters. Never rotate `OAUTH_ENCRYPTION_KEY` without reconnecting YouTube, because existing encrypted tokens will become unreadable.

In Cloudflare Zero Trust, create an Access self-hosted application for the Worker, cover **all traffic**, and use a free Allow policy limited to the owner's identity. Verify in a private browser window that the dashboard redirects to Cloudflare Access before showing content.

### Google / YouTube

1. Enable **YouTube Data API v3** in the Google Cloud project.
2. Configure an External OAuth consent screen. During development, keep the app in Testing and add the target YouTube account as a test user.
3. Create an OAuth 2.0 **Web application** client.
4. Add the deployed Worker origin as an authorized JavaScript origin.
5. Add this exact redirect URI: `https://social-uploader.nodatlaspour.workers.dev/api/oauth/youtube/callback`.
6. Put the client ID and secret into Worker secrets, deploy, open the protected dashboard, and click **Connect YouTube**.

The requested scope is only `https://www.googleapis.com/auth/youtube.upload`.

Deploy and check:

```sh
npm run check
npm run deploy
```

No paid Cloudflare service, plan change, quota purchase, or limit increase is required or authorized.

## Acceptance criteria

- The entire dashboard and API are gated by Cloudflare Access on a free plan.
- **Connect YouTube** performs a real server-side Google OAuth authorization-code flow with signed, expiring state.
- Persistent Google tokens are AES-256-GCM encrypted in Workers KV; secrets stay in encrypted Worker secrets.
- The dashboard captures a YouTube title, description, future publish time, public-at-schedule visibility, made-for-kids setting, MP4, and JPG/PNG thumbnail.
- Direct R2 uploads preserve the 8 GB hard application cap and exact-size signed requests.
- The Worker creates a YouTube resumable upload, while the browser sends the MP4 directly to YouTube.
- The custom thumbnail is uploaded and the returned YouTube resource is checked for the requested metadata and native schedule.
- R2 video and thumbnail objects are deleted only after YouTube acceptance is verified.
- A cleanup or thumbnail warning cannot overwrite an accepted schedule with a failed/stopped UI state.
- The result displays the YouTube video ID and accepted scheduled time, and upload states distinguish uploading, processing, scheduled, failed, and cancelled.
- The System Status view shows current capped R2 usage, object age/count, recent job outcomes, connection state, recent errors, app events, and a reserved mini-PC section using only R2 and KV.
- Instagram and TikTok are visibly disabled placeholders and make no provider calls.
- The R2 seven-day lifecycle remains active as failure cleanup.
- `npm run check` passes.

## Known limitations

- Google OAuth apps in **Testing** normally issue refresh tokens that expire after seven days. Reconnect YouTube when that happens, or move the consent screen to Production after completing Google's requirements.
- YouTube states that uploads from API projects created after July 28, 2020 are restricted to private viewing until the project passes a YouTube API Services compliance audit. Native public scheduling can therefore be rejected or remain private until Google approves that audit. The app treats a missing or changed `publishAt` as failure and keeps the temporary R2 copy for the seven-day fallback rather than claiming success.
- A custom thumbnail can be rejected if the YouTube channel is not eligible for custom thumbnails.
- The direct YouTube transfer currently sends the MP4 as one resumable-protocol request. If the network breaks, the temporary R2 copy remains, but the dashboard does not yet expose a resume button.
- YouTube processing may still be in progress after the API has accepted the file and schedule. The app rejects immediate failed/rejected states, but it does not poll until transcoding completes.
- The status job list is read-only. There is no retry screen, edit flow, manual media deletion UI, or long-term analytics. Small job/event metadata remains in KV; event entries expire after 30 days.
- Instagram, TikTok, the mini-PC worker, analytics, captions, transcoding, and local media processing are intentionally absent.

## Next milestone

Build the smallest authenticated mini-PC worker protocol needed to accept custody of pending media for a platform that cannot schedule natively. The protocol should include explicit ownership transfer, checksums, heartbeat/health visibility, idempotent job pickup, and deletion only after every required platform upload succeeds. Do not add Instagram or TikTok publishing until their current API eligibility and review requirements are confirmed.
