# Milestone 5: delivery history and retry

Milestone 5 keeps the existing Worker, KV namespace, R2 bucket, and five-minute cron. It adds no database, queue, image service, container, or paid Cloudflare feature.

## Posts and delivery state

The Posts page retains jobs after dispatch and groups them into Upcoming, Failed / Needs attention, Published, and Cancelled. Each card shows its cover when one is still available, title/caption, scheduled time, source size, selected platforms, and each platform's delivery state and concise failure reason. A partial job remains under Failed / Needs attention even when another platform succeeded.

Pending future jobs keep the existing edit and cancel behavior. Platform-specific edit settings appear only while that destination is selected. System Status is an operational overview: storage, upcoming and failed counts, last scheduler run, connection state, recent runs, platform errors, and cleanup events.

## Per-platform retry

Instagram and TikTok failures can be retried independently while their source is retained. A retry resets only the selected failed step; a platform already marked scheduled or published is not posted again. The original retry expiration is preserved, so repeated retries never extend retention.

Before a TikTok job is accepted or retried, the Worker queries `creator_info/query`. In unaudited testing mode, the returned privacy options must identify a Private account, and posts remain forced to `SELF_ONLY`. The dashboard performs the same preflight before staging a new upload. The scheduler queries creator info again immediately before Direct Post initialization.

If TikTok is still public, the job or retry is blocked with:

```text
TikTok requires this account to be Private while the app is unaudited.
```

## Temporary-media lifecycle

- All selected platforms succeeded: delete the source video and cover immediately.
- Cancelled: delete the source video and cover immediately.
- Partial or failed: retain both objects until the failure's fixed retry deadline, at most 24 hours after terminal failure.
- Retry: do not extend the original deadline.
- Deadline reached: the existing cron reconciliation deletes both objects and marks the job's source unavailable.
- Already missing or expired: show `Source expired — upload again` and do not offer Retry.
- Unclaimed staging objects still use the existing seven-day fallback lifecycle.

All retained objects continue to count against the existing 8,000,000,000-byte application cap. No storage limit or paid usage setting is increased.

## Verification

Run the lightweight local checks with:

```sh
npm run check
```

Manual provider verification should cover a partial Instagram-success/TikTok-failure job, TikTok public-account submission blocking, a TikTok retry after switching the account to Private, and confirmation that the already-successful Instagram step is not reposted.
