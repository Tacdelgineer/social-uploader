# Social Uploader

A deliberately small, private Cloudflare dashboard for uploading one short-form video to YouTube Shorts, Instagram Reels, and TikTok.

Milestone 5 adds delivery history, per-platform retry, a fixed 24-hour failed-media retry window, TikTok private-account preflight checks, and a scan-friendly operational status view. YouTube still uses its native `publishAt`; the existing five-minute Worker cron sends Instagram/TikTok media at publish time. Provider tokens remain encrypted in Workers KV, TikTok remains `SELF_ONLY`, and the global R2 cap remains 8 GB.

See [docs/step-05-delivery-history.md](docs/step-05-delivery-history.md) for the current delivery, retry, and retention behavior. The scheduling architecture remains documented in [docs/step-04-scheduled-posts.md](docs/step-04-scheduled-posts.md); earlier milestones are in [docs/step-03-instagram-tiktok.md](docs/step-03-instagram-tiktok.md), [docs/step-02-youtube.md](docs/step-02-youtube.md), and [docs/step-01-foundation.md](docs/step-01-foundation.md).

```sh
npm install
npm run check
npm run dev
```
