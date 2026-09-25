# TikTok production review

This checklist is based on TikTok's current [App Review Guidelines](https://developers.tiktok.com/docs/en/app-review-guidelines), [Direct Post guide](https://developers.tiktok.com/docs/en/content-posting-api-get-started), and [Content Sharing Guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines).

## Public URLs and Cloudflare Access

Use these exact public URLs:

- Website: `https://social-uploader.nodatlaspour.workers.dev/`
- Privacy Policy: `https://social-uploader.nodatlaspour.workers.dev/privacy.html`
- Terms of Service: `https://social-uploader.nodatlaspour.workers.dev/terms.html`
- Web redirect URI: `https://social-uploader.nodatlaspour.workers.dev/api/oauth/tiktok/callback`

The dashboard moved to `https://social-uploader.nodatlaspour.workers.dev/dashboard.html`. Before review, split the existing Cloudflare Access application so the website and legal pages are public while the dashboard and private APIs remain protected:

1. In Cloudflare Zero Trust, open **Access > Applications**.
2. Keep the existing owner-only Allow policy, but remove the hostname-wide application only after the two protected path applications below exist.
3. Protect `social-uploader.nodatlaspour.workers.dev/dashboard.html` with a self-hosted Access application using the existing owner/reviewer Allow policy.
4. Protect `social-uploader.nodatlaspour.workers.dev/api/*` with a second self-hosted Access application using the same Allow policy.
5. Do not create an Access application for `/`, `/privacy.html`, or `/terms.html`.
6. Add the reviewer identity to the Allow policy if TikTok requests live dashboard access. Do not publish an Access bypass for the dashboard or general API paths.
7. In a private browser window, verify the three public URLs return `200` without login, while `/dashboard.html` and `/api/system/status` redirect to Access.

The OAuth callback remains under the protected API application. A reviewer exercising Login Kit must first be authorized through Cloudflare Access. If TikTok requires an externally reachable callback without an Access session, create a narrowly scoped Access bypass for the exact callback path only; do not bypass `/api/*` broadly.

## TikTok Developer Portal fields

Open **Manage apps > Social Uploader > Production** and complete the Draft revision.

### App details

- App name: `Social Uploader`
- Platform: `Web`
- Website URL: `https://social-uploader.nodatlaspour.workers.dev/`
- Privacy Policy URL: `https://social-uploader.nodatlaspour.workers.dev/privacy.html`
- Terms of Service URL: `https://social-uploader.nodatlaspour.workers.dev/terms.html`
- Description: `Social Uploader lets authorized creators upload or schedule an original short-form video to their own connected social accounts. TikTok Direct Post happens only after the creator reviews TikTok's current privacy and interaction settings and explicitly consents to the upload.`
- App icon: upload a clear original Social Uploader icon that does not use TikTok branding.
- Category: choose the closest available creator-tools or photo/video category; do not choose an unrelated category merely to submit.

Use TikTok's **URL properties** control to verify the website, privacy, and terms URLs if the portal requests ownership verification. FILE_UPLOAD does not require a media pull-domain configuration.

### Products and platform configuration

1. Add **Login Kit**.
2. Enable **Configure for Web**.
3. Add the exact redirect URI: `https://social-uploader.nodatlaspour.workers.dev/api/oauth/tiktok/callback`.
4. Add **Content Posting API**.
5. Enable **Direct Post**.
6. Do not request Upload-to-drafts, Display API, Research API, or other unused products.

### Scopes

Request only:

- `user.info.basic` — reads the authorized creator's display name so the dashboard clearly identifies the destination account.
- `video.publish` — queries creator publishing capabilities and sends a user-approved video through Direct Post.

Remove any scope that is not demonstrated in the review video.

### Product and scope explanation

Paste a concise explanation equivalent to:

> Login Kit connects a creator's own TikTok account through OAuth. Social Uploader requests user.info.basic to show which authorized account will receive the post. Content Posting API Direct Post uses video.publish to query the latest creator_info, render the returned privacy and interaction options, validate video duration, initialize a user-consented post, transfer the locally selected MP4 with FILE_UPLOAD, and poll publishing status. The app does not post in the background, copy arbitrary third-party content, or repost a platform step that already succeeded.

### Review submission

1. Save every section and resolve all portal validation warnings.
2. Upload the demo video under **App review**. TikTok currently allows up to five videos, each up to 50 MB.
3. Describe the reviewer Access sign-in and provide a reviewer identity or demo access if requested; do not place credentials in the public website.
4. Submit only after the public URLs and complete sandbox demo work.
5. Do not set `TIKTOK_APP_AUDITED` to `true` until TikTok marks the Content Posting API review **Live**. After approval, change the Wrangler variable to `true` and deploy; the uploader will then enable creator-returned public privacy options.

## Demo video sequence

Record one continuous video on the deployed website domain:

1. Open `https://social-uploader.nodatlaspour.workers.dev/` and show the service description plus the visible Privacy Policy and Terms of Service links.
2. Open both legal links and show that neither requires Cloudflare Access.
3. Open **Authorized dashboard**, complete Cloudflare Access, and show the deployed domain in the address bar.
4. Click **Connect TikTok** and show TikTok Login Kit authorization for exactly `user.info.basic` and `video.publish`.
5. Return to the dashboard and show the connected creator nickname.
6. Expand TikTok settings and show the review diagnostic: Login Kit configured, video.publish granted, creator_info working, current app restriction unaudited, and the current Direct Post initialization state.
7. Show the exact privacy options returned by creator_info, the maximum duration, and whether comments, Duet, and Stitch are available. Manually select privacy; do not use a preset choice.
8. Select an original MP4, enter/edit the caption, choose permitted interaction settings, set the cover timestamp, and accurately set the commercial-content disclosures.
9. Check the explicit consent containing TikTok's Music Usage Confirmation immediately before submitting.
10. Select TikTok as a destination and click **Upload & publish**. Show that no transfer begins before the click and consent.
11. Show Direct Post initialization, FILE_UPLOAD progress, status polling, and the final TikTok result. Mention that provider processing may take several minutes.
12. Refresh TikTok review mode and show **Direct Post initialized**.

For a first review, TikTok requires the sandbox environment in the demo. An unaudited end-to-end Direct Post currently requires a private sandbox test account and `SELF_ONLY`. This does not require changing the real/main account: use a separate TikTok sandbox test user. A video that stops only at `unaudited_client_can_only_post_to_private_accounts` does not demonstrate the complete end-to-end integration.

## Pre-submission and rejection checklist

- Public website, Privacy Policy, and Terms return `200` without Access and their links are visible without opening a menu.
- Dashboard and all general `/api/*` routes remain protected by Access.
- Website domain in the demo matches the configured Website URL.
- App name, description, and custom icon are complete and accurate.
- Login Kit, Content Posting API, and Direct Post are the only requested products needed here.
- Only `user.info.basic` and `video.publish` are requested, granted, and demonstrated.
- Redirect URI is exact, HTTPS, static, and has no query string or fragment.
- The latest creator_info is queried when rendering TikTok controls and again before initialization.
- Creator nickname, returned privacy choices, interaction availability, and maximum duration are visible.
- Privacy has no default; the user manually chooses one of TikTok's returned options.
- Comments, Duet, and Stitch begin unchecked and unavailable options are disabled.
- Caption/preset text remains editable.
- Commercial-content disclosures and TikTok's Music Usage Confirmation are shown and honored.
- FILE_UPLOAD is used for the locally selected file; no unverified URL pull is claimed.
- Provider secrets and tokens never appear in the UI, public pages, logs, or demo.
- No background post, hidden post, automatic cross-platform copy, or repost of a successful platform occurs.
- The video is original and contains no app-added watermark, logo, promotional link, or branding.
- A complete sandbox post and status result are visible in the demo.
- The operator can provide reviewer access free of charge if requested.

## Material approval risks

TikTok's current guidelines say production apps must be intended for a wide audience and explicitly list a private utility for accounts owned by the developer or their team as unacceptable. They also say the Website URL must represent a fully developed external service rather than a landing or login page. Social Uploader is currently an Access-protected, single-operator application, so this is a material policy blocker even when the technical integration is compliant. Do not describe it as public or multi-user unless that is genuinely true.

Before submission, replace the GitHub contact on the legal pages with the real operator/business name and a monitored support/privacy contact if TikTok expects formal legal contact details. Also prepare a separate private TikTok sandbox test account for the successful demo flow and an Access reviewer identity. These are manual requirements; the application must not fabricate them.
