# Social Uploader

A deliberately small, private Cloudflare dashboard for uploading one short-form video to YouTube Shorts, Instagram Reels, and TikTok.

Milestone 5 adds delivery history, per-platform retry, a fixed 24-hour failed-media retry window, and a scan-friendly operational status view. The current review-readiness update adds a public website, privacy policy, terms, creator-returned TikTok publishing options, and token-safe TikTok diagnostics. YouTube still uses its native `publishAt`; the existing five-minute Worker cron sends Instagram/TikTok media at publish time. Provider tokens remain encrypted in Workers KV and the global R2 cap remains 8 GB.

The Analytics tab queries provider APIs on demand and caches normalized snapshots in the existing KV for 10 minutes. YouTube requires one reconnect for `youtube.readonly` and `yt-analytics.readonly`. TikTok analytics requires the Display API `video.list` scope to be added/approved in TikTok Developer Portal before reconnecting. Instagram continues to use Instagram Login; basic owned-media data works with `instagram_business_basic`, while Reel insights require optional Advanced Access for `instagram_business_manage_insights` followed by an Instagram reconnect.

See [docs/tiktok-review.md](docs/tiktok-review.md) for the production-review fields, demo sequence, Access split, and rejection checklist. Delivery and retry behavior remains documented in [docs/step-05-delivery-history.md](docs/step-05-delivery-history.md).

```sh
npm install
npm run check
npm run dev
```
