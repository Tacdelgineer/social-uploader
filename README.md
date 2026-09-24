# Social Uploader

A deliberately small, private Cloudflare dashboard for uploading one short-form video to YouTube Shorts, Instagram Reels, and TikTok.

Milestone 3 adds Instagram Login/Reels publishing and TikTok Login Kit/Direct Post alongside the existing YouTube-native scheduling flow. Provider tokens remain encrypted in Workers KV. One capped R2 transfer copy is shared by the selected destinations and is deleted once every selected provider has custody; the seven-day lifecycle remains the fallback. Instagram and TikTok publish immediately because neither Direct Post flow exposes native scheduling.

See [docs/step-03-instagram-tiktok.md](docs/step-03-instagram-tiktok.md) for architecture, setup, acceptance criteria, and limitations. Earlier milestones are documented in [docs/step-02-youtube.md](docs/step-02-youtube.md) and [docs/step-01-foundation.md](docs/step-01-foundation.md).

```sh
npm install
npm run check
npm run dev
```
