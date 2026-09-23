# Step 01 — Foundation

## Architecture

Social Uploader Milestone 1 is one Cloudflare Worker deployment with three deliberately small parts:

1. A framework-free TypeScript dashboard is built by Vite and served through Cloudflare Workers Static Assets.
2. The Worker exposes a narrow JSON API to create 15-minute, content-type-bound R2 upload URLs and to validate/save draft metadata.
3. The browser uploads video and thumbnail bytes straight to R2 with the signed URLs. The Worker never receives or proxies the file bodies. After both uploads finish, the browser sends only metadata to the Worker, which verifies both R2 objects and stores `drafts/<id>.json` in the same private bucket.

R2 object layout:

```text
uploads/<draft-id>/video.mp4
uploads/<draft-id>/thumbnail.<jpg|png|webp>
drafts/<draft-id>.json
```

There is no runtime dependency on a developer computer. Static assets, API code, files, and draft records all live on Cloudflare.

## Setup

Prerequisites: Node.js 20 or newer, a Cloudflare account with Workers and R2 enabled, and Wrangler authenticated with `npx wrangler login`.

```sh
npm install
npx wrangler r2 bucket create social-uploader
```

In Cloudflare R2, create an **Object Read & Write** API token scoped only to the `social-uploader` bucket. Store its values as Worker secrets:

```sh
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

The account ID is not secret. Add it as a Worker secret to keep environment-specific configuration out of Git:

```sh
npx wrangler secret put R2_ACCOUNT_ID
```

`R2_ACCOUNT_ID` is the same value as `CLOUDFLARE_ACCOUNT_ID`; the separate name makes it explicit that the Worker uses it only to construct the private R2 S3 endpoint.

Copy `r2-cors.example.json` to `r2-cors.json`, replace `YOUR-SUBDOMAIN` with the deployed workers.dev subdomain, then apply it:

```sh
npx wrangler r2 bucket cors set social-uploader --file r2-cors.json
npm run deploy
```

For local development, copy `.env.example` to `.dev.vars`, fill only the three current R2 values, run `npm run dev`, and keep `.dev.vars` uncommitted. The direct-upload CORS policy already includes `http://localhost:8787` in the example.

## Acceptance criteria

- A responsive single-page dashboard is served from Cloudflare.
- An MP4 up to 2 GB can be selected by drag/drop or file picker.
- A JPG, PNG, or WebP thumbnail up to 10 MB can be selected and previewed.
- Title, description/caption, optional local scheduled time, and platform toggles are captured.
- YouTube, Instagram, and TikTok each have an expandable future-settings panel and an honest OAuth placeholder button.
- Video and thumbnail data use short-lived signed PUT URLs and travel from the browser directly to R2.
- The Worker checks that both uploaded objects exist and match the submitted sizes before saving a versioned JSON draft record.
- R2 credentials remain server-side in Cloudflare Worker secrets.
- `npm run check` passes.

## Known limitations

- OAuth buttons are placeholders. No social account is connected and nothing is published.
- Scheduled timestamps are stored only; no scheduler or background Worker runs them.
- Drafts cannot yet be listed, reopened, edited, or deleted in the dashboard.
- A failed two-file upload can leave an orphaned object in R2; cleanup is deferred.
- The 2 GB client-side limit is an application guard, not a signed content-length constraint.
- No transcoding, aspect-ratio inspection, duration validation, thumbnail generation, or other media processing is performed.
- The dashboard has no built-in login. Protect the Worker with Cloudflare Access before sharing its URL.

## Next milestone

Add private dashboard access plus real OAuth connection flows for YouTube, Instagram, and TikTok. Encrypt stored refresh/access tokens, add callback/error handling and connection status, and keep publishing itself disabled until each provider's upload requirements and review status are verified.
