# Step 01 — Foundation

## Architecture

Social Uploader has a small Cloudflare control plane and, in a later milestone, a mini-PC media plane.

### Milestone 1 data path

1. A framework-free TypeScript dashboard is built by Vite and served with Cloudflare Workers Static Assets.
2. The Worker API validates one video/thumbnail pair and atomically reserves its exact sizes against an 8 GB R2 ceiling.
3. The Worker returns 15-minute presigned PUT URLs bound to both content type and content length. The browser uploads directly to private R2; video bytes never pass through the Worker.
4. After both uploads, the browser sends only post metadata. The Worker verifies the two R2 objects and saves a small JSON draft.
5. A bucket-wide lifecycle rule removes every R2 object after seven days. R2 is temporary staging for this milestone, not the durable source for scheduled media.

The capacity ledger uses conditional R2 writes, so concurrent draft submissions cannot jointly reserve more than the 8 GB ceiling. Existing object bytes and active exact-size reservations are both counted. Requests that would exceed the ceiling receive an error before an upload URL is issued.

Current R2 layout:

```text
_system/storage-cap-ledger.json
uploads/<draft-id>/video.mp4
uploads/<draft-id>/thumbnail.<jpg|png|webp>
drafts/<draft-id>.json
```

The seven-day lifecycle currently applies to all four categories, including Milestone 1 draft JSON. This is deliberately conservative until durable small-metadata storage is introduced with explicit cost approval.

### Target posting data path (not built in Milestone 1)

- Cloudflare remains the always-on control plane and stores only small job metadata, encrypted OAuth tokens, and configuration.
- The mini PC runs a lightweight worker and is the durable holder for media that must wait until publish time. The development PC is never a runtime dependency.
- For a platform with native scheduling, upload as soon as the user submits, request the platform-native schedule, verify that the platform accepted and persisted it, and then delete our temporary copy. YouTube follows this path.
- For a platform that requires publishing at the scheduled time, the mini-PC worker holds the pending video and thumbnail. Cloudflare stores only the job instruction. If the local worker cannot safely accept custody, the app must refuse/defer that job rather than silently retaining it in R2.
- Local media is deleted immediately after every required platform upload for that job has succeeded. Failed platforms retain only the copy required for retry.
- R2 may remain only as an explicitly temporary transfer bridge: 8 GB application ceiling, exact-size reservations, short-lived URLs, immediate deletion when custody transfers, and the seven-day lifecycle backstop.

No local worker, platform upload, scheduler, or deletion coordinator is implemented in this milestone.

## Setup

Prerequisites: Node.js 20 or newer, a Cloudflare account with Workers and R2 enabled, and Wrangler authenticated with `npx wrangler login`.

```sh
npm install
npx wrangler r2 bucket create social-uploader
```

Create an **Object Read & Write** R2 API token scoped only to the `social-uploader` bucket. Store its values as encrypted Worker secrets, never plain configuration:

```sh
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

The non-secret `R2_ACCOUNT_ID` in `wrangler.jsonc` is the account used to construct the private R2 S3 endpoint. Change it when deploying to another account.

Apply the exact-origin CORS policy and mandatory seven-day cleanup rule:

```sh
npx wrangler r2 bucket cors set social-uploader --file r2-cors.example.json --force
npx wrangler r2 bucket lifecycle add social-uploader delete-temporary-objects --expire-days 7 --force
npx wrangler r2 bucket lifecycle list social-uploader
npm run deploy
```

For local development, copy `.env.example` to `.dev.vars`, fill only the three current R2 values, run `npm run dev`, and keep `.dev.vars` uncommitted. The CORS policy includes `http://localhost:8787`.

No paid Cloudflare product, plan change, or limit increase should be enabled without the owner's explicit approval.

## Acceptance criteria

- A responsive single-page dashboard is served from Cloudflare while the development PC is off.
- An MP4 up to 2 GB can be selected by drag/drop or file picker.
- A JPG, PNG, or WebP thumbnail up to 10 MB can be selected and previewed.
- Title, description/caption, optional local scheduled time, and platform toggles are captured.
- YouTube, Instagram, and TikTok each have an expandable future-settings panel and an honest OAuth placeholder button.
- Video and thumbnail bytes travel from the browser directly to R2 through 15-minute URLs bound to their exact content types and sizes.
- A conditional capacity ledger refuses reservations that would take temporary R2 usage above 8 GB.
- The Worker checks both uploaded objects and stores a versioned JSON draft record.
- A verified bucket lifecycle expires every R2 object after seven days.
- R2 credentials remain server-side in encrypted Cloudflare Worker secrets.
- `npm run check` passes.

## Known limitations

- OAuth buttons are placeholders. No social account is connected and nothing is published or scheduled.
- The mini-PC worker and its local media custody are intentionally not built yet.
- Milestone 1 media and draft JSON expire after seven days; this is a safety boundary, not a durable scheduler.
- Drafts cannot yet be listed, reopened, edited, or manually deleted in the dashboard.
- A failed two-file upload can temporarily leave one object in R2, but it remains counted toward the cap and the lifecycle removes it within seven days.
- No transcoding, aspect-ratio inspection, duration validation, thumbnail generation, or other media processing is performed.
- The dashboard has no built-in login. Protect the Worker with Cloudflare Access before sharing its URL.

## Next milestone

Milestone 2 is implemented and documented in [step-02-youtube.md](step-02-youtube.md): private dashboard access, real YouTube OAuth, native scheduling, verification, and immediate temporary-media deletion after acceptance.
