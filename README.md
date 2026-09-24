# Social Uploader

A deliberately small, private Cloudflare dashboard for uploading one short-form video to YouTube Shorts, Instagram Reels, and TikTok.

Milestone 4 adds dashboard-managed scheduling for Instagram and TikTok, a scheduled-post edit/cancel page, safe storage reconciliation, and the Instagram-specific OAuth credential fix. YouTube still uses its native `publishAt`; a free five-minute Worker cron sends Instagram/TikTok media at publish time. Provider tokens remain encrypted in Workers KV, TikTok remains `SELF_ONLY`, and the global R2 cap remains 8 GB.

See [docs/step-04-scheduled-posts.md](docs/step-04-scheduled-posts.md) for the current architecture, setup, acceptance criteria, and limitations. Earlier milestones are documented in [docs/step-03-instagram-tiktok.md](docs/step-03-instagram-tiktok.md), [docs/step-02-youtube.md](docs/step-02-youtube.md), and [docs/step-01-foundation.md](docs/step-01-foundation.md).

```sh
npm install
npm run check
npm run dev
```
