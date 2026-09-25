# Social Uploader

A deliberately small, private Cloudflare dashboard for uploading one short-form video to YouTube Shorts, Instagram Reels, and TikTok.

Milestone 5 adds delivery history, per-platform retry, a fixed 24-hour failed-media retry window, and a scan-friendly operational status view. The current review-readiness update adds a public website, privacy policy, terms, creator-returned TikTok publishing options, and token-safe TikTok diagnostics. YouTube still uses its native `publishAt`; the existing five-minute Worker cron sends Instagram/TikTok media at publish time. Provider tokens remain encrypted in Workers KV and the global R2 cap remains 8 GB.

See [docs/tiktok-review.md](docs/tiktok-review.md) for the production-review fields, demo sequence, Access split, and rejection checklist. Delivery and retry behavior remains documented in [docs/step-05-delivery-history.md](docs/step-05-delivery-history.md).

```sh
npm install
npm run check
npm run dev
```
