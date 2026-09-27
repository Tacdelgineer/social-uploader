import "./styles.css";
import {
  BATCH_MAX_POSTS,
  INSTAGRAM_VIDEO_MAX_BYTES,
  R2_STORAGE_CAP_BYTES,
  VIDEO_MAX_BYTES,
  type ApiError,
  type BatchPresignRequest,
  type BatchPresignResponse,
  type CompleteYouTubeResponse,
  type CreateJobResponse,
  type DraftRequest,
  type EditScheduledPostRequest,
  type InstagramPublishResponse,
  type Platform,
  type PlatformConnectionStatus,
  type PresignRequest,
  type ScheduledPostSummary,
  type ScheduledPostsResponse,
  type SystemStatusResponse,
  type TikTokCreatorInfo,
  type TikTokPrivacy,
  type TikTokPublishStatusResponse,
  type TikTokReviewStatus,
  type TikTokStartResponse,
  type YouTubeConnectionStatus,
} from "../shared/contracts";

const PLATFORMS = ["youtube", "instagram", "tiktok"] as const;
const LABELS: Record<Platform, string> = { youtube: "YT", instagram: "IG", tiktok: "TT" };
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

type Selection = Record<Platform, boolean>;
type DraftStatus = "ready" | "preparing" | "uploading" | "processing" | "scheduled" | "completed" | "failed" | "cancelled";
interface Settings {
  youtubeMadeForKids: boolean;
  instagramShareToFeed: boolean;
  tiktokPrivacy: TikTokPrivacy;
  tiktokComments: boolean;
  tiktokDuet: boolean;
  tiktokStitch: boolean;
  tiktokConsent: boolean;
  tiktokPromoteOwnBrand: boolean;
  tiktokPaidPartnership: boolean;
}
interface BatchDraft {
  id: string;
  file: File;
  thumbnail: File;
  thumbnailUrl: string;
  duration: number;
  title: string;
  caption: string;
  platforms: Selection;
  scheduledAt: string;
  settings: Settings;
  selected: boolean;
  status: DraftStatus;
  progress: number;
  error?: string;
  createdJob: boolean;
}

const drafts: BatchDraft[] = [];
let posts: ScheduledPostSummary[] = [];
let connected: Selection = { youtube: false, instagram: false, tiktok: false };
let tiktokCreator: TikTokCreatorInfo | null = null;
let tiktokReview: TikTokReviewStatus | null = null;
let batchCancelled = false;
let toastTimer: number | undefined;
let platformDialogAction: ((selection: Selection, tiktokConsent: boolean) => void) | null = null;
const activeXhrs = new Set<XMLHttpRequest>();

const videoInput = el<HTMLInputElement>("video-input");
const dropzone = el<HTMLElement>("video-dropzone");
const draftSection = el<HTMLElement>("draft-section");
const draftList = el<HTMLElement>("draft-list");
const defaultSchedule = el<HTMLInputElement>("default-schedule");

setMinimumDates();
setupNavigation();
setupConnections();
setupDefaults();
setupDropzone();
setupBatchActions();
setupPostActions();
showOAuthResult();
void refreshConnections();

function setupNavigation(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-view-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.viewTarget;
      document.querySelectorAll<HTMLElement>("[data-view]").forEach((view) => { view.hidden = view.id !== target; });
      document.querySelectorAll<HTMLButtonElement>("[data-view-target]").forEach((item) => item.classList.toggle("is-active", item === button));
      if (target === "scheduled-view" || target === "history-view") void refreshPosts();
      if (target === "status-view") void refreshSystemStatus();
    });
  });
}

function setupConnections(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-connect]").forEach((button) => {
    button.addEventListener("click", () => window.location.assign(`/api/oauth/${button.dataset.connect}/start`));
  });
}

function setupDefaults(): void {
  el<HTMLButtonElement>("platform-select-all").addEventListener("click", () => setDefaultPlatforms(true));
  el<HTMLButtonElement>("platform-select-none").addEventListener("click", () => setDefaultPlatforms(false));
  el<HTMLButtonElement>("apply-platforms-all").addEventListener("click", () => {
    const selection = defaultPlatforms();
    drafts.forEach((draft) => { draft.platforms = { ...selection }; });
    renderDrafts();
  });
  for (const platform of PLATFORMS) {
    el<HTMLInputElement>(`default-${platform}`).addEventListener("change", updateDefaultSettingVisibility);
  }
  el<HTMLButtonElement>("apply-defaults").addEventListener("click", () => {
    applyDefaults(drafts);
    renderDrafts();
    showToast("Defaults applied to every draft.");
  });
  defaultSchedule.addEventListener("change", () => {
    applySchedule(drafts, defaultSchedule.value, Number(el<HTMLSelectElement>("default-spacing").value));
    renderDrafts();
  });
  el<HTMLSelectElement>("default-spacing").addEventListener("change", () => {
    applySchedule(drafts, defaultSchedule.value, Number(el<HTMLSelectElement>("default-spacing").value));
    renderDrafts();
  });
  updateDefaultSettingVisibility();
}

function setupDropzone(): void {
  dropzone.addEventListener("click", () => videoInput.click());
  dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); videoInput.click(); }
  });
  videoInput.addEventListener("change", () => void addFiles([...videoInput.files ?? []]));
  for (const name of ["dragenter", "dragover"]) dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.add("is-dragging"); });
  for (const name of ["dragleave", "drop"]) dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.remove("is-dragging"); });
  dropzone.addEventListener("drop", (event) => void addFiles([...event.dataTransfer?.files ?? []]));
}

function setupBatchActions(): void {
  el<HTMLInputElement>("select-all-drafts").addEventListener("change", (event) => {
    drafts.forEach((draft) => { draft.selected = (event.target as HTMLInputElement).checked; });
    renderDrafts();
  });
  el<HTMLButtonElement>("delete-selected-drafts").addEventListener("click", () => {
    for (let index = drafts.length - 1; index >= 0; index -= 1) {
      if (drafts[index]?.selected && !drafts[index]?.createdJob) {
        URL.revokeObjectURL(drafts[index]!.thumbnailUrl);
        drafts.splice(index, 1);
      }
    }
    renderDrafts();
  });
  el<HTMLButtonElement>("apply-platforms-selected").addEventListener("click", () => {
    openPlatformDialog(defaultPlatforms(), (selection, consent) => {
      drafts.filter((draft) => draft.selected).forEach((draft) => {
        draft.platforms = { ...selection };
        draft.settings.tiktokConsent ||= consent;
      });
      renderDrafts();
    });
  });
  el<HTMLButtonElement>("apply-schedule-selected").addEventListener("click", () => {
    applySchedule(drafts.filter((draft) => draft.selected), defaultSchedule.value, Number(el<HTMLSelectElement>("default-spacing").value));
    renderDrafts();
  });
  el<HTMLButtonElement>("submit-batch").addEventListener("click", () => void submitBatch());
  el<HTMLButtonElement>("cancel-batch").addEventListener("click", () => {
    batchCancelled = true;
    for (const xhr of activeXhrs) xhr.abort();
    drafts.filter((draft) => draft.createdJob && !["completed", "scheduled"].includes(draft.status)).forEach((draft) => {
      draft.status = "cancelled";
      void reportJobState(draft.id, "cancelled", "Batch cancelled by user.");
    });
    renderDrafts();
  });
  const dialog = el<HTMLDialogElement>("platform-dialog");
  el<HTMLButtonElement>("platform-dialog-apply").addEventListener("click", (event) => {
    event.preventDefault();
    const selection = dialogSelection();
    if (!PLATFORMS.some((platform) => selection[platform])) { showToast("Choose at least one platform.", true); return; }
    platformDialogAction?.(selection, el<HTMLInputElement>("dialog-tiktok-consent").checked);
    dialog.close();
  });
}

function setupPostActions(): void {
  document.querySelectorAll<HTMLButtonElement>(".refresh-posts").forEach((button) => button.addEventListener("click", () => void refreshPosts()));
  el<HTMLInputElement>("select-all-scheduled").addEventListener("change", (event) => setPostChecks("scheduled-list", (event.target as HTMLInputElement).checked));
  el<HTMLInputElement>("select-all-history").addEventListener("change", (event) => setPostChecks("history-list", (event.target as HTMLInputElement).checked));
  el<HTMLButtonElement>("bulk-set-schedule").addEventListener("click", () => void bulkSetSchedule());
  el<HTMLButtonElement>("bulk-shift-back").addEventListener("click", () => void bulkShift(-1));
  el<HTMLButtonElement>("bulk-shift-forward").addEventListener("click", () => void bulkShift(1));
  el<HTMLButtonElement>("bulk-change-platforms").addEventListener("click", () => {
    openPlatformDialog(defaultPlatforms(), (selection, consent) => void bulkPatch(selectedPostIds("scheduled-list"), (post) => ({
      platforms: selection,
      tiktok: { ...post.tiktok, consentConfirmed: post.tiktok.consentConfirmed || consent },
    })));
  });
  el<HTMLButtonElement>("bulk-cancel").addEventListener("click", () => void bulkCancel());
  el<HTMLButtonElement>("bulk-retry").addEventListener("click", () => void bulkRetry());
  el<HTMLButtonElement>("status-refresh").addEventListener("click", () => void refreshSystemStatus());
}

async function addFiles(files: File[]): Promise<void> {
  const room = BATCH_MAX_POSTS - drafts.length;
  const accepted = files.filter(isMp4).slice(0, room);
  if (accepted.length !== files.length) showToast(`Only MP4 files are accepted; a batch is limited to ${BATCH_MAX_POSTS} posts.`, true);
  const oversized = accepted.find((file) => file.size <= 0 || file.size > VIDEO_MAX_BYTES);
  if (oversized) { showToast(`${oversized.name} must be between 1 byte and 2 GB.`, true); return; }
  const total = drafts.reduce((sum, draft) => sum + draft.file.size + draft.thumbnail.size, 0) + accepted.reduce((sum, file) => sum + file.size, 0);
  if (total > R2_STORAGE_CAP_BYTES) { showToast("This selection alone exceeds the 8 GB storage cap.", true); return; }

  dropzone.classList.add("is-loading");
  for (const file of accepted) {
    try {
      const media = await inspectVideo(file);
      const name = baseName(file.name);
      const index = drafts.length;
      drafts.push({
        id: crypto.randomUUID(), file, thumbnail: media.thumbnail,
        thumbnailUrl: URL.createObjectURL(media.thumbnail), duration: media.duration,
        title: applyTemplate(el<HTMLInputElement>("default-title").value, name).slice(0, 100) || name.slice(0, 100),
        caption: applyTemplate(el<HTMLTextAreaElement>("default-caption").value, name).slice(0, 2200),
        platforms: defaultPlatforms(), scheduledAt: calculatedSchedule(index), settings: defaultSettings(),
        selected: true, status: "ready", progress: 0, createdJob: false,
      });
    } catch (error) { showToast(`${file.name}: ${message(error)}`, true); }
  }
  dropzone.classList.remove("is-loading");
  videoInput.value = "";
  renderDrafts();
}

function renderDrafts(): void {
  draftSection.hidden = drafts.length === 0;
  draftList.replaceChildren();
  drafts.forEach((draft) => draftList.append(renderDraft(draft)));
  el<HTMLElement>("draft-count").textContent = `${drafts.length} ${drafts.length === 1 ? "draft" : "drafts"}`;
  const incoming = drafts.reduce((sum, draft) => sum + draft.file.size + draft.thumbnail.size, 0);
  el<HTMLElement>("incoming-total").textContent = `${formatBytes(incoming)} incoming`;
  el<HTMLInputElement>("select-all-drafts").checked = drafts.length > 0 && drafts.every((draft) => draft.selected);
  const preview = drafts.filter((draft) => draft.scheduledAt).map((draft) => `${draft.title}: ${formatDate(new Date(draft.scheduledAt).toISOString())}`);
  el<HTMLElement>("schedule-preview").textContent = preview.length ? `Calculated schedule · ${preview.join(" · ")}` : "No calculated schedule. Instagram and TikTok publish immediately; YouTube requires a future time.";
}

function renderDraft(draft: BatchDraft): HTMLElement {
  const row = document.createElement("article"); row.className = "queue-row"; row.dataset.status = draft.status;
  const check = input("checkbox"); check.checked = draft.selected; check.disabled = draft.status !== "ready";
  check.addEventListener("change", () => { draft.selected = check.checked; renderDrafts(); });
  const select = wrap("div", "row-select", check);
  const image = document.createElement("img"); image.src = draft.thumbnailUrl; image.alt = "";
  const media = wrap("div", "media-cell", image, text("strong", draft.file.name), text("small", `${formatBytes(draft.file.size)} · ${formatDuration(draft.duration)}`));
  const title = input("text"); title.value = draft.title; title.maxLength = 100; title.disabled = draft.status !== "ready";
  title.addEventListener("input", () => { draft.title = title.value; });
  const caption = document.createElement("textarea"); caption.value = draft.caption; caption.maxLength = 2200; caption.rows = 2; caption.disabled = draft.status !== "ready";
  caption.addEventListener("input", () => { draft.caption = caption.value; });
  const details = wrap("div", "details-cell", title, caption);
  const platforms = wrap("div", "row-platforms");
  for (const platform of PLATFORMS) {
    const toggle = input("checkbox"); toggle.checked = draft.platforms[platform]; toggle.disabled = draft.status !== "ready";
    toggle.addEventListener("change", () => { draft.platforms[platform] = toggle.checked; renderDrafts(); });
    platforms.append(wrap("label", `mini-platform ${platform}`, toggle, text("span", LABELS[platform])));
  }
  const schedule = input("datetime-local"); schedule.value = draft.scheduledAt; schedule.min = defaultSchedule.min; schedule.disabled = draft.status !== "ready";
  schedule.addEventListener("change", () => { draft.scheduledAt = schedule.value; renderDrafts(); });
  const status = wrap("div", "status-cell", text("span", humanize(draft.status)));
  if (draft.progress > 0 && draft.progress < 100) { const progress = document.createElement("progress"); progress.max = 100; progress.value = draft.progress; status.append(progress); }
  if (draft.error) status.append(text("small", draft.error));
  const actions = wrap("div", "row-actions");
  const edit = document.createElement("details"); edit.className = "row-advanced"; edit.append(text("summary", "Edit"), renderDraftAdvanced(draft));
  const remove = text("button", "Delete"); remove.className = "link-button danger-text"; (remove as HTMLButtonElement).type = "button"; (remove as HTMLButtonElement).disabled = draft.status !== "ready";
  remove.addEventListener("click", () => { URL.revokeObjectURL(draft.thumbnailUrl); drafts.splice(drafts.indexOf(draft), 1); renderDrafts(); });
  actions.append(edit, remove);
  row.append(select, media, details, platforms, schedule, status, actions);
  return row;
}

function renderDraftAdvanced(draft: BatchDraft): HTMLElement {
  const panel = wrap("div", "row-advanced-panel");
  if (draft.platforms.youtube) panel.append(settingCheckbox("YouTube · made for kids", draft.settings.youtubeMadeForKids, (v) => { draft.settings.youtubeMadeForKids = v; }));
  if (draft.platforms.instagram) panel.append(settingCheckbox("Instagram · share to feed", draft.settings.instagramShareToFeed, (v) => { draft.settings.instagramShareToFeed = v; }));
  if (draft.platforms.tiktok) {
    const privacy = document.createElement("select");
    const options = tiktokCreator?.privacyLevelOptions ?? [draft.settings.tiktokPrivacy];
    for (const value of options) { const option = document.createElement("option"); option.value = value; option.textContent = privacyLabel(value); option.selected = value === draft.settings.tiktokPrivacy; privacy.append(option); }
    privacy.addEventListener("change", () => { draft.settings.tiktokPrivacy = privacy.value as TikTokPrivacy; });
    panel.append(wrap("label", "inline-setting", text("span", "TikTok privacy"), privacy));
    panel.append(settingCheckbox("Comments", draft.settings.tiktokComments, (v) => { draft.settings.tiktokComments = v; }));
    panel.append(settingCheckbox("Duet", draft.settings.tiktokDuet, (v) => { draft.settings.tiktokDuet = v; }));
    panel.append(settingCheckbox("Stitch", draft.settings.tiktokStitch, (v) => { draft.settings.tiktokStitch = v; }));
    panel.append(settingCheckbox("Direct Post consent", draft.settings.tiktokConsent, (v) => { draft.settings.tiktokConsent = v; }));
  }
  if (!panel.childElementCount) panel.append(text("span", "Select a platform to show its settings."));
  return panel;
}

async function submitBatch(): Promise<void> {
  const ready = drafts.filter((draft) => draft.status === "ready");
  if (!ready.length || !validateDrafts(ready)) return;
  batchCancelled = false;
  setBatchBusy(true);
  try {
    ready.forEach((draft) => { draft.status = "preparing"; }); renderDrafts();
    const request: BatchPresignRequest = { items: ready.map(presignInput) };
    const reservation = await api<BatchPresignResponse>("/api/uploads/batch-presign", { method: "POST", body: JSON.stringify(request) });
    const reservations = new Map(reservation.items.map((item) => [item.jobId, item.uploads]));
    showToast(`Batch reserved. ${formatBytes(reservation.capacity.availableBytes)} remains under the 8 GB cap.`);
    await mapLimit(ready, 2, async (draft) => processDraft(draft, reservations.get(draft.id)!));
    const failed = ready.filter((draft) => draft.status === "failed").length;
    showToast(failed ? `${ready.length - failed} posts accepted; ${failed} need attention.` : `${ready.length} posts accepted.`, failed > 0);
    await refreshPosts();
  } catch (error) {
    ready.filter((draft) => draft.status === "preparing").forEach((draft) => { draft.status = batchCancelled ? "cancelled" : "failed"; draft.error = message(error); });
    showToast(message(error), true);
  } finally { setBatchBusy(false); renderDrafts(); }
}

async function processDraft(draft: BatchDraft, uploads: BatchPresignResponse["items"][number]["uploads"]): Promise<void> {
  if (batchCancelled) return;
  try {
    draft.status = "uploading"; renderDrafts();
    await upload(uploads.video.uploadUrl, draft.file, (value) => { draft.progress = Math.round(value * 80); updateDraftStatus(draft); });
    await upload(uploads.thumbnail.uploadUrl, draft.thumbnail, (value) => { draft.progress = 80 + Math.round(value * 5); updateDraftStatus(draft); });
    if (batchCancelled) throw new Error("Batch cancelled.");
    const job = buildJob(draft, uploads.video.objectKey, uploads.thumbnail.objectKey);
    const created = await api<CreateJobResponse>("/api/jobs", { method: "POST", body: JSON.stringify(job) });
    draft.createdJob = true; draft.status = "processing"; draft.progress = 88; updateDraftStatus(draft);
    if (draft.platforms.youtube) await publishYouTube(draft, created);
    const immediate = !draft.scheduledAt || new Date(draft.scheduledAt).getTime() <= Date.now();
    if (draft.platforms.instagram && immediate) await api<InstagramPublishResponse>(`/api/jobs/${draft.id}/instagram/start`, { method: "POST", body: "{}" });
    if (draft.platforms.tiktok && immediate) await publishTikTok(draft);
    draft.progress = 100;
    draft.status = draft.scheduledAt && new Date(draft.scheduledAt).getTime() > Date.now()
      ? "scheduled"
      : draft.platforms.instagram || draft.platforms.tiktok ? "processing" : "completed";
  } catch (error) {
    draft.status = batchCancelled ? "cancelled" : "failed"; draft.error = message(error);
    if (draft.createdJob) await reportJobState(draft.id, batchCancelled ? "cancelled" : "failed", draft.error);
  }
  renderDrafts();
}

async function publishYouTube(draft: BatchDraft, created: CreateJobResponse): Promise<void> {
  if (!created.youtube) throw new Error("YouTube did not return an upload session.");
  const videoId = await uploadYouTube(created.youtube.uploadUrl, created.youtube.accessToken, draft.file, (value) => { draft.progress = 88 + Math.round(value * 8); updateDraftStatus(draft); });
  await api<CompleteYouTubeResponse>(`/api/jobs/${draft.id}/youtube/complete`, { method: "POST", body: JSON.stringify({ videoId }) });
}

async function publishTikTok(draft: BatchDraft): Promise<void> {
  const initialized = await api<TikTokStartResponse>(`/api/jobs/${draft.id}/tiktok/start`, { method: "POST", body: "{}" });
  for (let index = 0; index < initialized.totalChunkCount; index += 1) {
    const start = index * initialized.chunkSize;
    const end = index === initialized.totalChunkCount - 1 ? draft.file.size : Math.min(draft.file.size, start + initialized.chunkSize);
    await uploadTikTokChunk(initialized.uploadUrl, draft.file.slice(start, end, draft.file.type), start, end, draft.file.size, index === initialized.totalChunkCount - 1);
  }
  await api<TikTokPublishStatusResponse>(`/api/jobs/${draft.id}/tiktok/uploaded`, { method: "POST", body: "{}" });
}

function validateDrafts(items: BatchDraft[]): boolean {
  const seenConnections = new Set<Platform>();
  for (const draft of items) {
    const selected = PLATFORMS.filter((platform) => draft.platforms[platform]);
    if (!draft.title.trim()) return invalid(`${draft.file.name} needs a title.`);
    if (!selected.length) return invalid(`${draft.file.name} needs at least one platform.`);
    for (const platform of selected) if (!connected[platform]) seenConnections.add(platform);
    if (draft.platforms.instagram && (draft.file.size > INSTAGRAM_VIDEO_MAX_BYTES || draft.duration < 3 || draft.duration > 900)) return invalid(`${draft.file.name} does not meet Instagram's 300 MB and 3 sec–15 min limits.`);
    if (draft.platforms.youtube && (!draft.scheduledAt || new Date(draft.scheduledAt).getTime() <= Date.now() + 60_000)) return invalid(`${draft.file.name} needs a YouTube schedule at least one minute in the future.`);
    if (draft.scheduledAt && Number.isNaN(new Date(draft.scheduledAt).getTime())) return invalid(`${draft.file.name} has an invalid schedule.`);
    if (draft.platforms.tiktok) {
      if (!tiktokCreator) return invalid("TikTok creator settings are not available.");
      if (!draft.settings.tiktokConsent) return invalid(`${draft.file.name} needs TikTok Direct Post consent.`);
      if (draft.duration > tiktokCreator.maxVideoDurationSeconds) return invalid(`${draft.file.name} exceeds this TikTok creator's duration limit.`);
      if (tiktokReview?.appRestriction === "unaudited" && draft.settings.tiktokPrivacy !== "SELF_ONLY") return invalid("TikTok review mode only allows Only me privacy.");
    }
  }
  if (seenConnections.size) return invalid(`Connect ${[...seenConnections].map(capitalize).join(", ")} before uploading.`);
  return true;
}

function invalid(value: string): false { showToast(value, true); return false; }

function presignInput(draft: BatchDraft): PresignRequest {
  const future = draft.scheduledAt && new Date(draft.scheduledAt).getTime() > Date.now();
  return { jobId: draft.id, retention: future && (draft.platforms.instagram || draft.platforms.tiktok) ? "scheduled" : "staging", files: [
    { kind: "video", fileName: draft.file.name, contentType: "video/mp4", size: draft.file.size },
    { kind: "thumbnail", fileName: draft.thumbnail.name, contentType: draft.thumbnail.type, size: draft.thumbnail.size },
  ] };
}

function buildJob(draft: BatchDraft, videoKey: string, thumbnailKey: string): DraftRequest {
  return {
    id: draft.id, title: draft.title.trim(), description: draft.caption,
    scheduledAt: draft.scheduledAt ? new Date(draft.scheduledAt).toISOString() : null,
    timezone, videoDurationSeconds: draft.duration, platforms: draft.platforms,
    youtube: { visibility: "public", madeForKids: draft.settings.youtubeMadeForKids },
    instagram: { shareToFeed: draft.settings.instagramShareToFeed },
    tiktok: {
      privacy: draft.settings.tiktokPrivacy, allowComments: draft.settings.tiktokComments,
      allowDuet: draft.settings.tiktokDuet, allowStitch: draft.settings.tiktokStitch,
      coverTimestampMs: 0, consentConfirmed: draft.settings.tiktokConsent,
      promoteOwnBrand: draft.settings.tiktokPromoteOwnBrand, paidPartnership: draft.settings.tiktokPaidPartnership,
    },
    assets: {
      video: { key: videoKey, originalName: draft.file.name, contentType: "video/mp4", size: draft.file.size },
      thumbnail: { key: thumbnailKey, originalName: draft.thumbnail.name, contentType: draft.thumbnail.type, size: draft.thumbnail.size },
    },
  };
}

async function refreshConnections(): Promise<void> {
  const [youtube, instagram, tiktok] = await Promise.allSettled([
    api<YouTubeConnectionStatus>("/api/oauth/youtube/status"), api<PlatformConnectionStatus>("/api/oauth/instagram/status"), api<PlatformConnectionStatus>("/api/oauth/tiktok/status"),
  ]);
  connected = { youtube: youtube.status === "fulfilled" && youtube.value.connected, instagram: instagram.status === "fulfilled" && instagram.value.connected, tiktok: tiktok.status === "fulfilled" && tiktok.value.connected };
  setConnection("youtube", connected.youtube, youtube.status === "fulfilled" ? undefined : "Unavailable");
  setConnection("instagram", connected.instagram, instagram.status === "fulfilled" ? instagram.value.displayName : "Unavailable");
  setConnection("tiktok", connected.tiktok, tiktok.status === "fulfilled" ? tiktok.value.displayName : "Unavailable");
  if (connected.tiktok) await refreshTikTokInfo();
}

async function refreshTikTokInfo(): Promise<void> {
  try {
    [tiktokCreator, tiktokReview] = await Promise.all([api<TikTokCreatorInfo>("/api/tiktok/creator-info"), api<TikTokReviewStatus>("/api/tiktok/review-status")]);
    const privacy = el<HTMLSelectElement>("tiktok-privacy"); privacy.replaceChildren();
    for (const value of tiktokCreator.privacyLevelOptions) { const option = document.createElement("option"); option.value = value; option.textContent = privacyLabel(value); privacy.append(option); }
    if (tiktokReview.appRestriction === "unaudited" && tiktokCreator.privacyLevelOptions.includes("SELF_ONLY")) privacy.value = "SELF_ONLY";
    privacy.disabled = false;
    el<HTMLElement>("tiktok-creator-info").textContent = `${tiktokCreator.nickname} · up to ${formatDuration(tiktokCreator.maxVideoDurationSeconds)}${tiktokReview.appRestriction === "unaudited" ? " · review mode" : ""}`;
  } catch (error) { el<HTMLElement>("tiktok-creator-info").textContent = message(error); }
}

function setConnection(platform: Platform, isConnected: boolean, detail?: string): void {
  const label = el<HTMLElement>(`${platform}-connection-label`);
  label.textContent = isConnected ? detail || "Connected" : detail || "Connect";
  label.parentElement?.classList.toggle("is-connected", isConnected);
}

async function refreshPosts(): Promise<void> {
  try { posts = (await api<ScheduledPostsResponse>("/api/scheduled-posts")).posts; renderPosts(); }
  catch (error) { showToast(message(error), true); }
}

function renderPosts(): void {
  const scheduled = posts.filter((post) => post.canEdit && post.scheduledAt && new Date(post.scheduledAt).getTime() > Date.now());
  const history = posts.filter((post) => !scheduled.includes(post));
  renderPostList("scheduled-list", scheduled, true);
  renderPostList("history-list", history, false);
}

function renderPostList(id: string, values: ScheduledPostSummary[], editable: boolean): void {
  const list = el<HTMLElement>(id); list.replaceChildren();
  if (!values.length) { const empty = text("div", editable ? "No scheduled posts." : "No post history yet."); empty.className = "empty-row"; list.append(empty); return; }
  for (const post of values) {
    const row = document.createElement("article"); row.className = "post-row"; row.id = `post-${post.id}`;
    const check = input("checkbox"); check.className = "post-check"; check.dataset.id = post.id;
    const thumb = document.createElement("img"); thumb.src = post.thumbnailUrl; thumb.alt = ""; thumb.addEventListener("error", () => { thumb.hidden = true; });
    const identity = wrap("div", "post-identity", thumb, wrap("div", "", text("strong", post.title), text("small", post.scheduledAt ? formatDate(post.scheduledAt) : formatDate(post.createdAt))));
    const chips = wrap("div", "status-chips");
    for (const platform of PLATFORMS) if (post.platforms[platform]) { const chip = text("span", `${LABELS[platform]} ${humanize(post.platformStatus[platform] ?? "pending")}`); chip.className = `chip ${post.platformStatus[platform] ?? "pending"}`; chips.append(chip); }
    const state = text("span", humanize(post.status)); state.className = `post-state ${post.status}`;
    const actions = wrap("div", "post-actions");
    if (editable) {
      const edit = text("button", "Edit") as HTMLButtonElement; edit.type = "button"; edit.addEventListener("click", () => togglePostEditor(row, post));
      const cancel = text("button", "Cancel") as HTMLButtonElement; cancel.type = "button"; cancel.className = "danger-text"; cancel.addEventListener("click", () => void cancelPost(post.id));
      actions.append(edit, cancel);
    } else {
      for (const platform of ["instagram", "tiktok"] as const) if (post.platformStatus[platform] === "failed") {
        const retry = text("button", `Retry ${LABELS[platform]}`) as HTMLButtonElement; retry.type = "button"; retry.disabled = !post.sourceMediaAvailable; retry.addEventListener("click", () => void retryPost(post.id, platform)); actions.append(retry);
      }
    }
    row.append(check, identity, chips, state, actions); list.append(row);
  }
}

function togglePostEditor(row: HTMLElement, post: ScheduledPostSummary): void {
  const existing = row.nextElementSibling;
  if (existing?.classList.contains("post-editor")) { existing.remove(); return; }
  const editor = wrap("form", "post-editor") as HTMLFormElement;
  const title = input("text"); title.value = post.title; title.maxLength = 100;
  const caption = document.createElement("textarea"); caption.value = post.description; caption.maxLength = 2200; caption.rows = 3;
  const schedule = input("datetime-local"); schedule.value = toLocal(post.scheduledAt!); schedule.min = defaultSchedule.min;
  const picks = wrap("div", "editor-platforms"); const inputs = {} as Record<Platform, HTMLInputElement>;
  for (const platform of PLATFORMS) { const toggle = input("checkbox"); toggle.checked = post.platforms[platform]; inputs[platform] = toggle; picks.append(wrap("label", "", toggle, text("span", capitalize(platform)))); }
  const save = text("button", "Save") as HTMLButtonElement; save.type = "submit"; save.className = "primary-button";
  editor.append(field("Title", title), field("Caption", caption), field("Schedule", schedule), picks, save);
  editor.addEventListener("submit", async (event) => {
    event.preventDefault(); save.disabled = true;
    try { await patchPost(post, { title: title.value.trim(), description: caption.value, scheduledAt: new Date(schedule.value).toISOString(), platforms: selectionFromInputs(inputs) }); showToast("Scheduled post updated."); await refreshPosts(); }
    catch (error) { showToast(message(error), true); save.disabled = false; }
  });
  row.after(editor);
}

async function bulkSetSchedule(): Promise<void> {
  const ids = selectedPostIds("scheduled-list"); const start = el<HTMLInputElement>("bulk-schedule-time").value;
  if (!ids.length || !start) { showToast("Select posts and choose a start time.", true); return; }
  const spacing = Number(el<HTMLSelectElement>("bulk-schedule-spacing").value);
  await bulkPatch(ids, (_post, index) => ({ scheduledAt: new Date(new Date(start).getTime() + spacing * 3_600_000 * index).toISOString() }));
}

async function bulkShift(direction: -1 | 1): Promise<void> {
  const ids = selectedPostIds("scheduled-list");
  const amount = Number(el<HTMLInputElement>("bulk-shift-amount").value); const unit = Number(el<HTMLSelectElement>("bulk-shift-unit").value);
  if (!ids.length || !Number.isFinite(amount) || amount < 0) { showToast("Select posts and enter a valid shift.", true); return; }
  await bulkPatch(ids, (post) => ({ scheduledAt: new Date(new Date(post.scheduledAt!).getTime() + direction * amount * unit * 3_600_000).toISOString() }));
}

async function bulkPatch(ids: string[], change: (post: ScheduledPostSummary, index: number) => Partial<EditScheduledPostRequest>): Promise<void> {
  if (!ids.length) { showToast("Select at least one scheduled post.", true); return; }
  const selected = ids.map((id) => posts.find((post) => post.id === id)).filter((post): post is ScheduledPostSummary => Boolean(post));
  try {
    await mapLimit(selected, 2, async (post, index) => { const update = change(post, index); await patchPost(post, update); });
    showToast(`${selected.length} scheduled post${selected.length === 1 ? "" : "s"} updated.`); await refreshPosts();
  } catch (error) { showToast(message(error), true); }
}

async function patchPost(post: ScheduledPostSummary, change: Partial<EditScheduledPostRequest>): Promise<void> {
  const body: EditScheduledPostRequest = {
    title: change.title ?? post.title, description: change.description ?? post.description,
    scheduledAt: change.scheduledAt ?? post.scheduledAt!, platforms: change.platforms ?? post.platforms,
    youtube: change.youtube ?? post.youtube, instagram: change.instagram ?? post.instagram,
    tiktok: change.tiktok ?? post.tiktok,
  };
  await api(`/api/jobs/${post.id}`, { method: "PATCH", body: JSON.stringify(body) });
}

async function bulkCancel(): Promise<void> {
  const ids = selectedPostIds("scheduled-list"); if (!ids.length) return void showToast("Select posts to cancel.", true);
  try { await mapLimit(ids, 2, (id) => api(`/api/jobs/${id}`, { method: "DELETE" })); showToast(`${ids.length} scheduled post${ids.length === 1 ? "" : "s"} cancelled.`); await refreshPosts(); }
  catch (error) { showToast(message(error), true); }
}

async function cancelPost(id: string): Promise<void> { try { await api(`/api/jobs/${id}`, { method: "DELETE" }); showToast("Scheduled post cancelled."); await refreshPosts(); } catch (error) { showToast(message(error), true); } }
async function retryPost(id: string, platform: "instagram" | "tiktok"): Promise<void> { try { await api(`/api/jobs/${id}/retry/${platform}`, { method: "POST", body: "{}" }); showToast(`${capitalize(platform)} retry queued.`); await refreshPosts(); } catch (error) { showToast(message(error), true); } }
async function bulkRetry(): Promise<void> {
  const ids = selectedPostIds("history-list"); const tasks: Array<{ id: string; platform: "instagram" | "tiktok" }> = [];
  for (const id of ids) { const post = posts.find((value) => value.id === id); if (!post) continue; for (const platform of ["instagram", "tiktok"] as const) if (post.platformStatus[platform] === "failed") tasks.push({ id, platform }); }
  if (!tasks.length) return void showToast("Select history rows with a retryable failed Instagram or TikTok step.", true);
  try { await mapLimit(tasks, 2, (task) => api(`/api/jobs/${task.id}/retry/${task.platform}`, { method: "POST", body: "{}" })); showToast(`${tasks.length} failed platform step${tasks.length === 1 ? "" : "s"} queued.`); await refreshPosts(); } catch (error) { showToast(message(error), true); }
}

async function refreshSystemStatus(): Promise<void> {
  try {
    const status = await api<SystemStatusResponse>("/api/system/status");
    el<HTMLElement>("storage-used").textContent = `${formatBytes(status.storage.usedBytes)} / 8 GB`;
    el<HTMLElement>("storage-detail").textContent = `${status.storage.usedPercent.toFixed(2)}% · ${status.storage.temporaryObjectCount} objects`;
    el<HTMLElement>("status-scheduled-count").textContent = String(status.scheduling.pendingCount);
    el<HTMLElement>("status-next").textContent = status.scheduling.nextPublishAt ? `Next ${formatDate(status.scheduling.nextPublishAt)}` : "No upcoming post";
    el<HTMLElement>("status-failed-count").textContent = String(status.scheduling.failedCount);
    el<HTMLElement>("status-run").textContent = status.scheduling.recentRuns[0] ? `Last run ${formatDate(status.scheduling.recentRuns[0].finishedAt)}` : "No scheduler run";
    const list = el<HTMLOListElement>("events-list"); list.replaceChildren();
    for (const event of status.events.slice(0, 30)) list.append(wrap("li", `event ${event.level}`, wrap("div", "", text("strong", capitalize(event.platform ?? event.category)), text("time", formatDate(event.timestamp))), text("p", event.message)));
    if (!list.childElementCount) list.append(text("li", "No recent events."));
  } catch (error) { showToast(message(error), true); }
}

function applyDefaults(items: BatchDraft[]): void {
  items.forEach((draft, index) => {
    const name = baseName(draft.file.name); draft.title = applyTemplate(el<HTMLInputElement>("default-title").value, name).slice(0, 100) || name.slice(0, 100);
    draft.caption = applyTemplate(el<HTMLTextAreaElement>("default-caption").value, name).slice(0, 2200);
    draft.platforms = defaultPlatforms(); draft.settings = defaultSettings(); draft.scheduledAt = calculatedSchedule(index);
  });
}

function applySchedule(items: BatchDraft[], start: string, spacingHours: number): void {
  items.forEach((draft, index) => { draft.scheduledAt = start ? toLocal(new Date(new Date(start).getTime() + spacingHours * 3_600_000 * index).toISOString()) : ""; });
}

function calculatedSchedule(index: number): string {
  if (!defaultSchedule.value) return "";
  return toLocal(new Date(new Date(defaultSchedule.value).getTime() + Number(el<HTMLSelectElement>("default-spacing").value) * 3_600_000 * index).toISOString());
}

function defaultPlatforms(): Selection { return Object.fromEntries(PLATFORMS.map((platform) => [platform, el<HTMLInputElement>(`default-${platform}`).checked])) as Selection; }
function defaultSettings(): Settings { return {
  youtubeMadeForKids: el<HTMLInputElement>("youtube-made-for-kids").checked,
  instagramShareToFeed: el<HTMLInputElement>("instagram-share-to-feed").checked,
  tiktokPrivacy: el<HTMLSelectElement>("tiktok-privacy").value as TikTokPrivacy || "SELF_ONLY",
  tiktokComments: el<HTMLInputElement>("tiktok-comments").checked, tiktokDuet: el<HTMLInputElement>("tiktok-duet").checked,
  tiktokStitch: el<HTMLInputElement>("tiktok-stitch").checked, tiktokConsent: el<HTMLInputElement>("tiktok-direct-post-consent").checked,
  tiktokPromoteOwnBrand: el<HTMLInputElement>("tiktok-promote-own-brand").checked, tiktokPaidPartnership: el<HTMLInputElement>("tiktok-paid-partnership").checked,
}; }

function setDefaultPlatforms(value: boolean): void { PLATFORMS.forEach((platform) => { el<HTMLInputElement>(`default-${platform}`).checked = value; }); updateDefaultSettingVisibility(); }
function updateDefaultSettingVisibility(): void { PLATFORMS.forEach((platform) => { const section = document.getElementById(`${platform}-default-settings`); if (section) section.hidden = !el<HTMLInputElement>(`default-${platform}`).checked; }); }
function openPlatformDialog(selection: Selection, action: (value: Selection, tiktokConsent: boolean) => void): void { PLATFORMS.forEach((platform) => { el<HTMLInputElement>(`dialog-${platform}`).checked = selection[platform]; }); el<HTMLInputElement>("dialog-tiktok-consent").checked = false; platformDialogAction = action; el<HTMLDialogElement>("platform-dialog").showModal(); }
function dialogSelection(): Selection { return Object.fromEntries(PLATFORMS.map((platform) => [platform, el<HTMLInputElement>(`dialog-${platform}`).checked])) as Selection; }

async function inspectVideo(file: File): Promise<{ duration: number; thumbnail: File }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video"); const url = URL.createObjectURL(file); video.muted = true; video.preload = "metadata";
    const fail = () => { URL.revokeObjectURL(url); reject(new Error("The browser could not read this MP4.")); };
    video.addEventListener("error", fail, { once: true });
    video.addEventListener("loadedmetadata", () => { if (!Number.isFinite(video.duration) || video.duration <= 0) return fail(); video.currentTime = Math.min(1, Math.max(0, video.duration / 10)); }, { once: true });
    video.addEventListener("seeked", () => {
      const canvas = document.createElement("canvas"); const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => { URL.revokeObjectURL(url); if (!blob) return reject(new Error("Could not create a thumbnail.")); resolve({ duration: video.duration, thumbnail: new File([blob], `${baseName(file.name)}-cover.jpg`, { type: "image/jpeg" }) }); }, "image/jpeg", 0.84);
    }, { once: true });
    video.src = url;
  });
}

function upload(url: string, file: File, progress: (value: number) => void): Promise<void> { return xhrUpload(url, file, { "Content-Type": file.type }, progress, (xhr) => { if (xhr.status < 200 || xhr.status >= 300) throw new Error(`R2 rejected ${file.name} (HTTP ${xhr.status}).`); }); }
async function uploadYouTube(url: string, token: string, file: File, progress: (value: number) => void): Promise<string> { let id = ""; await xhrUpload(url, file, { Authorization: `Bearer ${token}`, "Content-Type": file.type }, progress, (xhr) => { const result = parseJson(xhr.responseText) as { id?: string; error?: { message?: string } } | null; if (!result?.id || xhr.status < 200 || xhr.status >= 300) throw new Error(result?.error?.message ?? `YouTube upload failed (HTTP ${xhr.status}).`); id = result.id; }); return id; }
function uploadTikTokChunk(url: string, chunk: Blob, start: number, end: number, total: number, last: boolean): Promise<void> { return xhrUpload(url, chunk, { "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end - 1}/${total}` }, () => undefined, (xhr) => { if (xhr.status !== (last ? 201 : 206)) throw new Error(`TikTok rejected a video chunk (HTTP ${xhr.status}).`); }); }
function xhrUpload(url: string, body: Blob, headers: Record<string, string>, progress: (value: number) => void, validate: (xhr: XMLHttpRequest) => void): Promise<void> {
  return new Promise((resolve, reject) => { const xhr = new XMLHttpRequest(); activeXhrs.add(xhr); xhr.open("PUT", url); Object.entries(headers).forEach(([name, value]) => xhr.setRequestHeader(name, value)); xhr.upload.addEventListener("progress", (event) => { if (event.lengthComputable) progress(event.loaded / event.total); }); xhr.addEventListener("load", () => { activeXhrs.delete(xhr); try { validate(xhr); resolve(); } catch (error) { reject(error); } }); xhr.addEventListener("error", () => { activeXhrs.delete(xhr); reject(new Error("Upload interrupted.")); }); xhr.addEventListener("abort", () => { activeXhrs.delete(xhr); reject(new Error("Upload cancelled.")); }); xhr.send(body); });
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> { const headers = new Headers(init.headers); if (init.body) headers.set("content-type", "application/json"); const response = await fetch(path, { ...init, headers }); const payload = await response.json().catch(() => null) as T | ApiError | null; if (!response.ok) throw new Error(payload && typeof payload === "object" && "error" in payload ? String(payload.error) : `Request failed (HTTP ${response.status}).`); return payload as T; }
async function reportJobState(id: string, status: "failed" | "cancelled", error: string): Promise<void> { try { await api(`/api/jobs/${id}`, { method: "POST", body: JSON.stringify({ status, error }) }); } catch { /* best effort */ } }

async function mapLimit<T>(items: T[], limit: number, task: (item: T, index: number) => Promise<unknown>): Promise<void> { let cursor = 0; await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (cursor < items.length) { const index = cursor++; await task(items[index]!, index); } })); }
function updateDraftStatus(draft: BatchDraft): void { const row = [...draftList.children][drafts.indexOf(draft)] as HTMLElement | undefined; const progress = row?.querySelector("progress"); if (progress) progress.setAttribute("value", String(draft.progress)); }
function setBatchBusy(busy: boolean): void { el<HTMLButtonElement>("submit-batch").disabled = busy; el<HTMLButtonElement>("submit-batch").textContent = busy ? "Uploading…" : "Upload batch"; el<HTMLButtonElement>("cancel-batch").hidden = !busy; }
function selectedPostIds(listId: string): string[] { return [...el<HTMLElement>(listId).querySelectorAll<HTMLInputElement>(".post-check:checked")].map((item) => item.dataset.id!); }
function setPostChecks(listId: string, checked: boolean): void { el<HTMLElement>(listId).querySelectorAll<HTMLInputElement>(".post-check").forEach((item) => { item.checked = checked; }); }
function selectionFromInputs(inputs: Record<Platform, HTMLInputElement>): Selection { return Object.fromEntries(PLATFORMS.map((platform) => [platform, inputs[platform].checked])) as Selection; }
function settingCheckbox(label: string, checked: boolean, onChange: (value: boolean) => void): HTMLElement { const control = input("checkbox"); control.checked = checked; control.addEventListener("change", () => onChange(control.checked)); return wrap("label", "inline-setting", control, text("span", label)); }
function field(label: string, control: HTMLElement): HTMLElement { return wrap("label", "editor-field", text("span", label), control); }
function input(type: string): HTMLInputElement { const value = document.createElement("input"); value.type = type; return value; }
function text<K extends keyof HTMLElementTagNameMap>(tag: K, value: string): HTMLElementTagNameMap[K] { const node = document.createElement(tag); node.textContent = value; return node; }
function wrap<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, ...children: Node[]): HTMLElementTagNameMap[K] { const node = document.createElement(tag); node.className = className; node.append(...children); return node; }
function el<T extends HTMLElement>(id: string): T { const value = document.getElementById(id); if (!value) throw new Error(`Missing #${id}`); return value as T; }
function isMp4(file: File): boolean { return file.type === "video/mp4" && file.name.toLowerCase().endsWith(".mp4"); }
function baseName(value: string): string { return value.replace(/\.mp4$/iu, ""); }
function applyTemplate(template: string, filename: string): string { return template.replaceAll("{filename}", filename); }
function humanize(value: string): string { return value.replaceAll("_", " "); }
function capitalize(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
function message(error: unknown): string { return error instanceof Error ? error.message : "Something went wrong."; }
function parseJson(value: string): unknown { try { return JSON.parse(value); } catch { return null; } }
function formatBytes(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`; if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`; return `${(bytes / 1_073_741_824).toFixed(2)} GB`; }
function formatDuration(seconds: number): string { const value = Math.round(seconds); return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`; }
function formatDate(value: string): string { return new Date(value).toLocaleString(); }
function toLocal(value: string): string { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }
function privacyLabel(value: string): string { return ({ PUBLIC_TO_EVERYONE: "Everyone", MUTUAL_FOLLOW_FRIENDS: "Friends", FOLLOWER_OF_CREATOR: "Followers", SELF_ONLY: "Only me" } as Record<string, string>)[value] ?? humanize(value); }
function setMinimumDates(): void { const min = toLocal(new Date(Date.now() + 120_000).toISOString()); defaultSchedule.min = min; el<HTMLInputElement>("bulk-schedule-time").min = min; }
function showToast(value: string, error = false): void { const toast = el<HTMLElement>("toast"); window.clearTimeout(toastTimer); toast.textContent = value; toast.classList.toggle("is-error", error); toast.hidden = false; toastTimer = window.setTimeout(() => { toast.hidden = true; }, 7000); }
function showOAuthResult(): void { const url = new URL(location.href); const platform = PLATFORMS.find((value) => url.searchParams.has(value)); if (!platform) return; showToast(url.searchParams.get(platform) === "connected" ? `${capitalize(platform)} connected.` : url.searchParams.get("message") ?? `${capitalize(platform)} connection failed.`, url.searchParams.get(platform) !== "connected"); url.searchParams.delete(platform); url.searchParams.delete("message"); history.replaceState({}, "", `${url.pathname}${url.search}`); }
