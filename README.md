# Social Uploader

A deliberately small, private Cloudflare dashboard for uploading one short-form video and scheduling it natively on YouTube.

Milestone 2 adds real Google OAuth, encrypted token storage in Workers KV, direct browser-to-YouTube video upload, YouTube-native scheduling, custom thumbnails, acceptance verification, and immediate R2 media deletion after success. The dashboard also includes a lightweight System Status view for temporary R2 usage, connection state, recent jobs, and app events. Instagram and TikTok remain honest placeholders.

See [docs/step-02-youtube.md](docs/step-02-youtube.md) for architecture, setup, acceptance criteria, limitations, and the next milestone. The original foundation is documented in [docs/step-01-foundation.md](docs/step-01-foundation.md).

```sh
npm install
npm run check
npm run dev
```
