import "./styles.css";
import {
  PLATFORMS,
  allPlatformSelection,
  selectedPlatformsFor,
  selectionControlState,
  withPlatformSelection,
  type PlatformSelection,
} from "./platform-selection";
import {
  INSTAGRAM_VIDEO_MAX_BYTES,
  THUMBNAIL_CONTENT_TYPES,
  THUMBNAIL_MAX_BYTES,
  VIDEO_CONTENT_TYPES,
  VIDEO_MAX_BYTES,
  type ApiError,
  type CompleteYouTubeResponse,
  type CreateJobResponse,
  type DraftRequest,
  type EditScheduledPostRequest,
  type InstagramPublishResponse,
  type Platform,
  type PlatformConnectionStatus,
  type PresignRequest,
  type PresignResponse,
  type ScheduledPostSummary,
  type ScheduledPostsResponse,
  type StoredJob,
  type SystemStatusResponse,
  type TikTokCreatorInfo,
  type TikTokPrivacy,
  type TikTokPublishStatusResponse,
  type TikTokReviewStatus,
  type TikTokStartResponse,
  type YouTubeConnectionStatus,
} from "../shared/contracts";
import { prepareThumbnailForPlatforms } from "./thumbnail";

type UploadState = "uploading" | "processing" | "scheduled" | "failed" | "cancelled";
type PostFilter = "upcoming" | "failed" | "published" | "cancelled";

const form = requiredElement<HTMLFormElement>("draft-form");
const videoInput = requiredElement<HTMLInputElement>("video-input");
const thumbnailInput = requiredElement<HTMLInputElement>("thumbnail-input");
const videoDropzone = requiredElement<HTMLElement>("video-dropzone");
const thumbnailDropzone = requiredElement<HTMLElement>("thumbnail-dropzone");
const titleInput = requiredElement<HTMLInputElement>("title");
const descriptionInput = requiredElement<HTMLTextAreaElement>("description");
const scheduledAtInput = requiredElement<HTMLInputElement>("scheduled-at");
const saveButton = requiredElement<HTMLButtonElement>("save-button");
const cancelButton = requiredElement<HTMLButtonElement>("cancel-upload");
const uploadStatus = requiredElement<HTMLElement>("upload-status");
const statusState = requiredElement<HTMLElement>("status-state");
const statusLabel = requiredElement<HTMLElement>("status-label");
const statusPercent = requiredElement<HTMLElement>("status-percent");
const progressBar = requiredElement<HTMLElement>("progress-bar");
const uploadResult = requiredElement<HTMLElement>("upload-result");
const toast = requiredElement<HTMLElement>("toast");
const youtubeConnect = requiredElement<HTMLButtonElement>("youtube-connect");
const youtubeDisconnect = requiredElement<HTMLButtonElement>("youtube-disconnect");
const youtubeConnectionLabel = requiredElement<HTMLElement>("youtube-connection-label");
const instagramConnect = requiredElement<HTMLButtonElement>("instagram-connect");
const instagramDisconnect = requiredElement<HTMLButtonElement>("instagram-disconnect");
const instagramConnectionLabel = requiredElement<HTMLElement>("instagram-connection-label");
const tiktokConnect = requiredElement<HTMLButtonElement>("tiktok-connect");
const tiktokDisconnect = requiredElement<HTMLButtonElement>("tiktok-disconnect");
const tiktokConnectionLabel = requiredElement<HTMLElement>("tiktok-connection-label");
const tiktokDirectPostConsent = requiredElement<HTMLInputElement>("tiktok-direct-post-consent");
const tiktokPrivacy = requiredElement<HTMLSelectElement>("tiktok-privacy");
const tiktokPromoteOwnBrand = requiredElement<HTMLInputElement>("tiktok-promote-own-brand");
const tiktokPaidPartnership = requiredElement<HTMLInputElement>("tiktok-paid-partnership");
const selectAllPlatformsButton = requiredElement<HTMLButtonElement>("select-all-platforms");
const selectNoPlatformsButton = requiredElement<HTMLButtonElement>("select-no-platforms");
const platformToggleInputs = Object.fromEntries(
  PLATFORMS.map((platform) => [
    platform,
    requiredElement<HTMLInputElement>(`${platform}-enabled`),
  ]),
) as Record<Platform, HTMLInputElement>;

let videoFile: File | null = null;
let thumbnailFile: File | null = null;
let thumbnailObjectUrl: string | null = null;
let youtubeConnected = false;
let instagramConnected = false;
let tiktokConnected = false;
let videoDurationSeconds = 0;
let tiktokCreatorInfo: TikTokCreatorInfo | null = null;
let tiktokReviewStatus: TikTokReviewStatus | null = null;
let toastTimer: number | undefined;
let currentPercent = 0;
let activeJobId: string | null = null;
let cancelRequested = false;
let platformSelection: PlatformSelection = selectionFromToggleInputs();
let postsCache: ScheduledPostSummary[] = [];
let activePostFilter: PostFilter = "upcoming";
const activeXhrs = new Set<XMLHttpRequest>();
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

setupDropzone(videoDropzone, videoInput, setVideo);
setupDropzone(thumbnailDropzone, thumbnailInput, setThumbnail);
setupViewNavigation();
setupPlatformSelectionControls();
setScheduleMinimum();
updateScheduleRequirement();
void refreshConnectionStatuses();
showOAuthResult();

selectAllPlatformsButton.addEventListener("click", () => {
  setAllPlatforms(true);
});
selectNoPlatformsButton.addEventListener("click", () => {
  setAllPlatforms(false);
});

titleInput.addEventListener("input", () => updateCount("title-count", titleInput.value.length));
descriptionInput.addEventListener("input", () =>
  updateCount("description-count", descriptionInput.value.length),
);

youtubeConnect.addEventListener("click", () => {
  window.location.assign("/api/oauth/youtube/start");
});

youtubeDisconnect.addEventListener("click", async () => {
  youtubeDisconnect.disabled = true;
  try {
    await apiRequest("/api/oauth/youtube/disconnect", { method: "POST", body: "{}" });
    setYouTubeConnection(false);
    showToast("YouTube disconnected.");
  } catch (error) {
    showToast(errorMessage(error), true);
  } finally {
    youtubeDisconnect.disabled = false;
  }
});

instagramConnect.addEventListener("click", () => {
  window.location.assign("/api/oauth/instagram/start");
});

instagramDisconnect.addEventListener("click", async () => {
  await disconnectPlatform("instagram", instagramDisconnect);
});

tiktokConnect.addEventListener("click", () => {
  window.location.assign("/api/oauth/tiktok/start");
});

tiktokDisconnect.addEventListener("click", async () => {
  await disconnectPlatform("tiktok", tiktokDisconnect);
});
tiktokPrivacy.addEventListener("change", syncTikTokCommercialAvailability);

cancelButton.addEventListener("click", () => {
  cancelRequested = true;
  for (const xhr of activeXhrs) xhr.abort();
  setProgress("cancelled", "Upload cancelled", currentPercent);
  if (activeJobId) void reportJobState(activeJobId, "cancelled", "Upload cancelled by user.");
});

requiredElement<HTMLButtonElement>("status-refresh").addEventListener("click", () => {
  void refreshSystemStatus();
});
requiredElement<HTMLButtonElement>("scheduled-refresh").addEventListener("click", () => {
  void refreshScheduledPosts();
});
document.querySelectorAll<HTMLButtonElement>("[data-post-filter]").forEach((button) => {
  button.addEventListener("click", () => setPostFilter(button.dataset.postFilter as PostFilter));
});
requiredElement<HTMLButtonElement>("open-failed-posts").addEventListener("click", () => {
  document.querySelector<HTMLButtonElement>('[data-view-target="scheduled-view"]')?.click();
  setPostFilter("failed");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const selected = selectedPlatforms();
  if (selected.includes("tiktok") && tiktokConnected) {
    await refreshTikTokCreatorInfo();
    if (!tiktokCreatorInfo) {
      showToast("TikTok creator settings could not be verified. Try again before submitting.", true);
      return;
    }
  }
  if (!validateForm()) return;

  setBusy(true);
  cancelRequested = false;
  activeJobId = null;
  currentPercent = 0;
  uploadResult.hidden = true;
  const jobId = crypto.randomUUID();
  const platformErrors: string[] = [];

  try {
    setProgress("uploading", "Preparing a compatible cover...", 1);
    const uploadThumbnail = await prepareThumbnailForPlatforms(thumbnailFile!, selected);
    if (uploadThumbnail !== thumbnailFile) showPreparedThumbnail(uploadThumbnail);
    throwIfCancelled();
    setProgress("uploading", "Reserving capped temporary storage...", 3);
    const reservation = await requestPresign(jobId, videoFile!, uploadThumbnail, selected);
    throwIfCancelled();
    const { video: videoUpload, thumbnail: thumbnailUpload } = reservation.uploads;

    setProgress("uploading", "Staging files directly in R2...", 6);
    const progress = { video: 0, thumbnail: 0 };
    await Promise.all([
      uploadDirectToR2(videoUpload.uploadUrl, videoFile!, (value) => {
        progress.video = value;
        setR2Progress(progress, uploadThumbnail);
      }),
      uploadDirectToR2(thumbnailUpload.uploadUrl, uploadThumbnail, (value) => {
        progress.thumbnail = value;
        setR2Progress(progress, uploadThumbnail);
      }),
    ]);
    throwIfCancelled();

    setProgress("uploading", "Creating provider upload job...", 48);
    const job = buildJob(jobId, videoUpload.objectKey, thumbnailUpload.objectKey, uploadThumbnail);
    const created = await apiRequest<CreateJobResponse>("/api/jobs", {
      method: "POST",
      body: JSON.stringify(job),
    });
    activeJobId = created.id;
    throwIfCancelled();

    if (selected.includes("youtube")) {
      try {
        await runYouTubeUpload(jobId, created);
      } catch (error) {
        if (cancelRequested) throw error;
        platformErrors.push(`YouTube: ${errorMessage(error)}`);
        await reportPlatformFailure(jobId, "youtube", errorMessage(error));
      }
    }
    const publishImmediately = !job.scheduledAt || new Date(job.scheduledAt).getTime() <= Date.now();
    if (selected.includes("instagram") && publishImmediately) {
      try {
        await runInstagramPublish(jobId);
      } catch (error) {
        if (cancelRequested) throw error;
        platformErrors.push(`Instagram: ${errorMessage(error)}`);
        await reportPlatformFailure(jobId, "instagram", errorMessage(error));
      }
    }
    if (selected.includes("tiktok") && publishImmediately) {
      try {
        await runTikTokPublish(jobId);
      } catch (error) {
        if (cancelRequested) throw error;
        platformErrors.push(`TikTok: ${errorMessage(error)}`);
        await reportPlatformFailure(jobId, "tiktok", errorMessage(error));
      }
    }

    const finalJob = await apiRequest<StoredJob>(`/api/jobs/${encodeURIComponent(jobId)}`);
    showJobResult(finalJob, platformErrors);
  } catch (error) {
    const message = errorMessage(error);
    const finalState: UploadState = cancelRequested ? "cancelled" : "failed";
    setProgress(
      finalState,
      finalState === "cancelled" ? "Upload cancelled" : "Upload failed",
      currentPercent,
    );
    if (activeJobId) await reportJobState(activeJobId, finalState, message);
    showToast(
      finalState === "cancelled"
        ? "Upload cancelled. Temporary files remain covered by the 7-day cleanup fallback."
        : `${message} Temporary files remain protected by 7-day cleanup.`,
      finalState === "failed",
    );
  } finally {
    setBusy(false);
    activeJobId = null;
    activeXhrs.clear();
  }
});

function setupViewNavigation(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-view-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.viewTarget;
      document.querySelectorAll<HTMLElement>("[data-view]").forEach((view) => {
        view.hidden = view.id !== target;
      });
      document.querySelectorAll<HTMLButtonElement>("[data-view-target]").forEach((item) => {
        item.classList.toggle("is-active", item === button);
      });
      if (target === "status-view") void refreshSystemStatus();
      if (target === "scheduled-view") void refreshScheduledPosts();
    });
  });
}

function setupPlatformSelectionControls(): void {
  document.querySelectorAll<HTMLElement>(".toggle-wrap").forEach((control) => {
    control.addEventListener("click", (event) => event.stopPropagation());
    control.addEventListener("keydown", (event) => event.stopPropagation());
  });
  for (const platform of PLATFORMS) {
    platformToggleInputs[platform].addEventListener("change", () => {
      applyPlatformSelection(
        withPlatformSelection(platformSelection, platform, platformToggleInputs[platform].checked),
      );
    });
  }
  syncPlatformSelectionControls();
}

function setupDropzone(
  dropzone: HTMLElement,
  input: HTMLInputElement,
  onFile: (file: File) => void,
): void {
  dropzone.addEventListener("click", () => input.click());
  dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) onFile(file);
  });
  for (const eventName of ["dragenter", "dragover"]) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add("is-dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-dragging");
    });
  }
  dropzone.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files[0];
    if (file) onFile(file);
  });
}

function setVideo(file: File): void {
  if (!(VIDEO_CONTENT_TYPES as readonly string[]).includes(file.type) || !file.name.toLowerCase().endsWith(".mp4")) {
    showToast("Choose an MP4 video file.", true);
    return;
  }
  if (file.size <= 0 || file.size > VIDEO_MAX_BYTES) {
    showToast("The video must be between 1 byte and 2 GB.", true);
    return;
  }
  videoFile = file;
  videoDurationSeconds = 0;
  requiredElement<HTMLElement>("video-name").textContent = file.name;
  requiredElement<HTMLElement>("video-meta").textContent = `${formatBytes(file.size)} - reading duration...`;
  videoDropzone.classList.add("has-file");
  void readVideoDuration(file)
    .then((duration) => {
      if (videoFile !== file) return;
      videoDurationSeconds = duration;
      requiredElement<HTMLElement>("video-meta").textContent =
        `${formatBytes(file.size)} - ${formatDuration(duration)} - MP4 ready`;
    })
    .catch(() => {
      if (videoFile === file) {
        requiredElement<HTMLElement>("video-meta").textContent = `${formatBytes(file.size)} - could not read duration`;
      }
    });
}

function setThumbnail(file: File): void {
  if (!(THUMBNAIL_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    showToast("Choose a JPG, PNG, or WebP cover.", true);
    return;
  }
  if (file.size <= 0 || file.size > THUMBNAIL_MAX_BYTES) {
    showToast("The thumbnail must be between 1 byte and 10 MB.", true);
    return;
  }
  thumbnailFile = file;
  requiredElement<HTMLElement>("thumbnail-name").textContent = file.name;
  requiredElement<HTMLElement>("thumbnail-meta").textContent = `${formatBytes(file.size)} - ready`;
  thumbnailDropzone.classList.add("has-file");
  if (thumbnailObjectUrl) URL.revokeObjectURL(thumbnailObjectUrl);
  thumbnailObjectUrl = URL.createObjectURL(file);
  requiredElement<HTMLElement>("thumbnail-preview").style.backgroundImage = `url("${thumbnailObjectUrl}")`;
  requiredElement<HTMLElement>("thumbnail-preview").classList.add("has-image");
}

function showPreparedThumbnail(file: File): void {
  requiredElement<HTMLElement>("thumbnail-name").textContent = file.name;
  requiredElement<HTMLElement>("thumbnail-meta").textContent =
    `${formatBytes(file.size)} - converted JPEG for selected platforms`;
  if (thumbnailObjectUrl) URL.revokeObjectURL(thumbnailObjectUrl);
  thumbnailObjectUrl = URL.createObjectURL(file);
  requiredElement<HTMLElement>("thumbnail-preview").style.backgroundImage = `url("${thumbnailObjectUrl}")`;
}

function validateForm(): boolean {
  const platforms = selectedPlatforms();
  if (platforms.length === 0) {
    showToast("Choose at least one destination.", true);
    return false;
  }
  if (platforms.includes("youtube") && !youtubeConnected) {
    showToast("Connect YouTube or turn it off for this post.", true);
    youtubeConnect.focus();
    return false;
  }
  if (platforms.includes("instagram") && !instagramConnected) {
    showToast("Connect Instagram or turn it off for this post.", true);
    instagramConnect.focus();
    return false;
  }
  if (platforms.includes("tiktok") && !tiktokConnected) {
    showToast("Connect TikTok or turn it off for this post.", true);
    tiktokConnect.focus();
    return false;
  }
  if (!videoFile) {
    showToast("Choose an MP4 video first.", true);
    videoDropzone.focus();
    return false;
  }
  if (!thumbnailFile) {
    showToast("Choose a thumbnail first.", true);
    thumbnailDropzone.focus();
    return false;
  }
  if (!videoDurationSeconds) {
    showToast("Wait for the video duration to finish loading, or choose the MP4 again.", true);
    return false;
  }
  if (platforms.includes("instagram")) {
    if (videoFile.size > INSTAGRAM_VIDEO_MAX_BYTES) {
      showToast("Instagram Reels API currently limits video files to 300 MB.", true);
      return false;
    }
    if (videoDurationSeconds < 3 || videoDurationSeconds > 15 * 60) {
      showToast("Instagram Reels must be between 3 seconds and 15 minutes.", true);
      return false;
    }
  }
  if (platforms.includes("tiktok")) {
    if (!tiktokCreatorInfo) {
      showToast("Wait for TikTok creator settings to load.", true);
      void refreshTikTokCreatorInfo();
      return false;
    }
    if (tiktokReviewStatus?.appRestriction === "unaudited" && !tiktokCreatorInfo.isPrivateAccount) {
      showToast("TikTok public posting requires TikTok production approval.", true);
      return false;
    }
    const privacy = tiktokPrivacy.value as TikTokPrivacy;
    if (!privacy || !tiktokCreatorInfo.privacyLevelOptions.includes(privacy)) {
      showToast("Choose one of the privacy options returned by TikTok.", true);
      tiktokPrivacy.focus();
      return false;
    }
    if (tiktokReviewStatus?.appRestriction === "unaudited" && privacy !== "SELF_ONLY") {
      showToast("TikTok public posting requires TikTok production approval.", true);
      return false;
    }
    if (tiktokPaidPartnership.checked && privacy === "SELF_ONLY") {
      showToast("TikTok does not allow branded-content posts to use Only me privacy.", true);
      return false;
    }
    if (videoDurationSeconds > tiktokCreatorInfo.maxVideoDurationSeconds) {
      showToast(`This TikTok creator allows up to ${tiktokCreatorInfo.maxVideoDurationSeconds} seconds.`, true);
      return false;
    }
    const coverTimestamp = Number(requiredElement<HTMLInputElement>("tiktok-cover-timestamp").value);
    if (!Number.isSafeInteger(coverTimestamp) || coverTimestamp < 0 || coverTimestamp >= videoDurationSeconds * 1000) {
      showToast("TikTok cover timestamp must be a whole millisecond inside the video.", true);
      return false;
    }
    if (!tiktokDirectPostConsent.checked) {
      showToast("Confirm that you want Social Uploader to send this video directly to TikTok.", true);
      tiktokDirectPostConsent.focus();
      return false;
    }
  }
  if (!form.reportValidity()) return false;
  const publishAt = scheduledAtInput.value ? new Date(scheduledAtInput.value) : null;
  if (
    platforms.includes("youtube") &&
    (!publishAt || Number.isNaN(publishAt.getTime()) || publishAt.getTime() <= Date.now() + 60_000)
  ) {
    showToast("Choose a publish time at least one minute in the future.", true);
    scheduledAtInput.focus();
    return false;
  }
  return true;
}

function buildJob(jobId: string, videoKey: string, thumbnailKey: string, uploadThumbnail: File): DraftRequest {
  const platforms = selectedPlatforms();
  return {
    id: jobId,
    title: titleInput.value.trim(),
    description: descriptionInput.value,
    scheduledAt: scheduledAtInput.value ? new Date(scheduledAtInput.value).toISOString() : null,
    timezone,
    videoDurationSeconds,
    platforms: {
      youtube: platforms.includes("youtube"),
      instagram: platforms.includes("instagram"),
      tiktok: platforms.includes("tiktok"),
    },
    youtube: {
      visibility: "public",
      madeForKids: requiredElement<HTMLSelectElement>("youtube-made-for-kids").value === "true",
    },
    instagram: {
      shareToFeed: requiredElement<HTMLInputElement>("instagram-share-to-feed").checked,
    },
    tiktok: {
      privacy: (tiktokPrivacy.value || "SELF_ONLY") as TikTokPrivacy,
      allowComments: requiredElement<HTMLInputElement>("tiktok-comments").checked,
      allowDuet: requiredElement<HTMLInputElement>("tiktok-duet").checked,
      allowStitch: requiredElement<HTMLInputElement>("tiktok-stitch").checked,
      coverTimestampMs: Number(requiredElement<HTMLInputElement>("tiktok-cover-timestamp").value),
      consentConfirmed: tiktokDirectPostConsent.checked,
      promoteOwnBrand: tiktokPromoteOwnBrand.checked,
      paidPartnership: tiktokPaidPartnership.checked,
    },
    assets: {
      video: toAsset(videoKey, videoFile!),
      thumbnail: toAsset(thumbnailKey, uploadThumbnail),
    },
  };
}

async function requestPresign(
  jobId: string,
  video: File,
  thumbnail: File,
  platforms: Platform[],
): Promise<PresignResponse> {
  const publishAt = scheduledAtInput.value ? new Date(scheduledAtInput.value) : null;
  const retention =
    publishAt && publishAt.getTime() > Date.now() &&
    platforms.some((platform) => platform === "instagram" || platform === "tiktok")
      ? "scheduled"
      : "staging";
  const payload: PresignRequest = {
    jobId,
    retention,
    files: [
      { kind: "video", fileName: video.name, contentType: video.type, size: video.size },
      { kind: "thumbnail", fileName: thumbnail.name, contentType: thumbnail.type, size: thumbnail.size },
    ],
  };
  return apiRequest<PresignResponse>("/api/uploads/presign", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

function uploadDirectToR2(url: string, file: File, onProgress: (value: number) => void): Promise<void> {
  return uploadWithXhr(url, file, { "Content-Type": file.type }, onProgress, (xhr) => {
    if (xhr.status < 200 || xhr.status >= 300) {
      throw new Error(`R2 rejected ${file.name} (HTTP ${xhr.status}).`);
    }
  });
}

async function uploadDirectToYouTube(
  url: string,
  accessToken: string,
  file: File,
  onProgress: (value: number) => void,
): Promise<string> {
  let videoId = "";
  await uploadWithXhr(
    url,
    file,
    { Authorization: `Bearer ${accessToken}`, "Content-Type": file.type },
    onProgress,
    (xhr) => {
      const payload = parseJson(xhr.responseText) as { id?: string; error?: { message?: string } } | null;
      if (xhr.status < 200 || xhr.status >= 300 || !payload?.id) {
        throw new Error(payload?.error?.message ?? `YouTube upload failed (HTTP ${xhr.status}).`);
      }
      videoId = payload.id;
    },
  );
  return videoId;
}

async function runYouTubeUpload(jobId: string, created: CreateJobResponse): Promise<void> {
  if (!created.youtube) throw new Error("The Worker did not return a YouTube upload session.");
  setProgress("uploading", "Uploading video directly to YouTube...", 52);
  const videoId = await uploadDirectToYouTube(
    created.youtube.uploadUrl,
    created.youtube.accessToken,
    videoFile!,
    (value) => setProgress("uploading", "Uploading video directly to YouTube...", 52 + Math.round(value * 12)),
  );
  throwIfCancelled();
  setProgress("processing", "YouTube received the video; verifying its native schedule...", 65);
  await apiRequest<CompleteYouTubeResponse>(
    `/api/jobs/${encodeURIComponent(jobId)}/youtube/complete`,
    { method: "POST", body: JSON.stringify({ videoId }) },
  );
}

async function runInstagramPublish(jobId: string): Promise<void> {
  setProgress("processing", "Instagram is fetching the Reel and cover from temporary storage...", 68);
  let result = await apiRequest<InstagramPublishResponse>(
    `/api/jobs/${encodeURIComponent(jobId)}/instagram/start`,
    { method: "POST", body: "{}" },
  );
  for (let attempt = 0; result.status !== "published" && attempt < 5; attempt += 1) {
    await delay(60_000);
    throwIfCancelled();
    setProgress("processing", `Instagram is processing the Reel (${attempt + 1}/5)...`, 68 + (attempt + 1) * 2);
    result = await apiRequest<InstagramPublishResponse>(
      `/api/jobs/${encodeURIComponent(jobId)}/instagram/status`,
      { method: "POST", body: "{}" },
    );
  }
  if (result.status !== "published") {
    showToast("Instagram is still processing. Its job remains visible in System status.");
  }
}

async function runTikTokPublish(jobId: string): Promise<void> {
  setProgress("processing", `Querying TikTok creator settings and initializing ${privacyLabel(tiktokPrivacy.value)} Direct Post...`, 80);
  const initialized = await apiRequest<TikTokStartResponse>(
    `/api/jobs/${encodeURIComponent(jobId)}/tiktok/start`,
    { method: "POST", body: "{}" },
  );
  setReviewDiagnostic("review-direct-post", true, "Initialized", "Not initialized yet");
  setProgress("uploading", "Uploading the video to TikTok with FILE_UPLOAD...", 82);
  await uploadDirectToTikTok(initialized, videoFile!, (value) => {
    setProgress("uploading", "Uploading the video to TikTok with FILE_UPLOAD...", 82 + Math.round(value * 12));
  });
  throwIfCancelled();
  await delay(2_000);
  let status = await apiRequest<TikTokPublishStatusResponse>(
    `/api/jobs/${encodeURIComponent(jobId)}/tiktok/uploaded`,
    { method: "POST", body: "{}" },
  );
  for (let attempt = 0; !status.publishComplete && attempt < 60; attempt += 1) {
    await delay(5_000);
    throwIfCancelled();
    setProgress("processing", "TikTok has the file and is processing the private post...", 95 + Math.min(3, attempt / 20));
    status = await apiRequest<TikTokPublishStatusResponse>(
      `/api/jobs/${encodeURIComponent(jobId)}/tiktok/status`,
      { method: "POST", body: "{}" },
    );
  }
  if (!status.publishComplete) {
    showToast("TikTok is still processing. The uploaded file is already in TikTok custody.");
  }
}

async function uploadDirectToTikTok(
  initialized: TikTokStartResponse,
  file: File,
  onProgress: (value: number) => void,
): Promise<void> {
  for (let index = 0; index < initialized.totalChunkCount; index += 1) {
    throwIfCancelled();
    const start = index * initialized.chunkSize;
    const end = index === initialized.totalChunkCount - 1
      ? file.size
      : Math.min(file.size, start + initialized.chunkSize);
    const chunk = file.slice(start, end, file.type);
    await uploadTikTokChunk(initialized.uploadUrl, chunk, start, end, file.size, index, initialized.totalChunkCount);
    onProgress(end / file.size);
  }
}

function uploadTikTokChunk(
  url: string,
  chunk: Blob,
  start: number,
  end: number,
  total: number,
  index: number,
  totalChunks: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    activeXhrs.add(xhr);
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "video/mp4");
    xhr.setRequestHeader("Content-Range", `bytes ${start}-${end - 1}/${total}`);
    xhr.addEventListener("load", () => {
      activeXhrs.delete(xhr);
      const expected = index === totalChunks - 1 ? 201 : 206;
      if (xhr.status !== expected) {
        reject(new Error(`TikTok rejected FILE_UPLOAD chunk ${index + 1}/${totalChunks} (HTTP ${xhr.status}).`));
        return;
      }
      resolve();
    });
    xhr.addEventListener("error", () => {
      activeXhrs.delete(xhr);
      reject(new Error(`TikTok FILE_UPLOAD chunk ${index + 1}/${totalChunks} was interrupted.`));
    });
    xhr.addEventListener("abort", () => {
      activeXhrs.delete(xhr);
      reject(new Error("TikTok FILE_UPLOAD was cancelled."));
    });
    xhr.send(chunk);
  });
}

function uploadWithXhr(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress: (value: number) => void,
  validate: (xhr: XMLHttpRequest) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    activeXhrs.add(xhr);
    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    xhr.addEventListener("load", () => {
      activeXhrs.delete(xhr);
      try {
        validate(xhr);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    xhr.addEventListener("error", () => {
      activeXhrs.delete(xhr);
      reject(new Error(`The upload of ${file.name} was interrupted.`));
    });
    xhr.addEventListener("abort", () => {
      activeXhrs.delete(xhr);
      reject(new Error(`Upload cancelled for ${file.name}.`));
    });
    xhr.send(file);
  });
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers });
  const payload = (await response.json().catch(() => null)) as T | ApiError | null;
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String(payload.error)
        : `Request failed (HTTP ${response.status}).`;
    throw new Error(message);
  }
  return payload as T;
}

async function reportJobState(
  jobId: string,
  status: "failed" | "cancelled",
  error: string,
): Promise<void> {
  try {
    await apiRequest(`/api/jobs/${encodeURIComponent(jobId)}`, {
      method: "POST",
      body: JSON.stringify({ status, error }),
    });
  } catch {
    // The visible state is still useful; backend logging is best effort after a client failure.
  }
}

async function reportPlatformFailure(jobId: string, platform: Platform, error: string): Promise<void> {
  try {
    await apiRequest(`/api/jobs/${encodeURIComponent(jobId)}`, {
      method: "POST",
      body: JSON.stringify({ status: "failed", platform, error }),
    });
  } catch {
    // Provider endpoints also persist terminal failures; this is a best-effort fallback.
  }
}

function showJobResult(job: StoredJob, operationErrors: string[]): void {
  const succeeded = Object.values(job.platformStatus ?? {}).some(
    (status) => status === "scheduled" || status === "published",
  );
  const stillProcessing = Object.values(job.platformStatus ?? {}).some(
    (status) => status === "uploading" || status === "processing" || status === "pending",
  );
  const pendingSchedule = Boolean(job.scheduledAt) && new Date(job.scheduledAt!).getTime() > Date.now() &&
    Object.values(job.platformStatus ?? {}).some((status) => status === "pending" || status === "scheduled");
  const state: UploadState = pendingSchedule ? "scheduled" : stillProcessing ? "processing" : succeeded && job.status !== "partial" ? "scheduled" : "failed";
  const label = pendingSchedule
    ? `Post scheduled for ${formatDate(job.scheduledAt!)}`
    : stillProcessing
      ? "Providers accepted the transfer; processing continues"
    : job.status === "completed"
      ? "All selected platforms accepted the post"
      : succeeded
        ? "Finished with platform errors"
        : "All selected platforms failed";
  setProgress(state, label, 100);

  const results = requiredElement<HTMLElement>("result-platforms");
  results.replaceChildren();
  for (const platform of selectedPlatformsFromJob(job)) {
    const row = document.createElement("span");
    const status = job.platformStatus?.[platform] ?? "unknown";
    if (platform === "youtube" && job.youtubeResult) {
      row.textContent = `YouTube scheduled ${job.youtubeResult.videoId} for ${formatDate(job.youtubeResult.publishAt)}`;
    } else if (platform === "instagram" && job.instagramResult?.mediaId) {
      row.textContent = `Instagram published Reel ${job.instagramResult.mediaId}`;
    } else if (platform === "tiktok" && job.tiktokResult) {
      row.textContent = job.tiktokResult.status === "PUBLISH_COMPLETE"
        ? `TikTok published ${job.tiktokResult.publishId} with ${privacyLabel(job.tiktok.privacy)} privacy`
        : `TikTok ${job.tiktokResult.publishId}: ${humanizeStatus(job.tiktokResult.status)}`;
    } else if (pendingSchedule && status === "pending") {
      row.textContent = `${capitalize(platform)}: Social Uploader will send it at publish time`;
    } else {
      row.textContent = `${capitalize(platform)}: ${humanizeStatus(status)}`;
    }
    results.append(row);
  }

  requiredElement<HTMLElement>("result-cleanup").textContent = job.mediaDeleted
    ? "Temporary video and thumbnail deleted"
    : pendingSchedule
      ? "Scheduled media retained until every selected platform is done"
      : "Temporary media retained; 7-day staging cleanup remains active";
  const warnings = [
    ...(job.youtubeResult?.warnings ?? []),
    ...(job.instagramResult?.warnings ?? []),
    ...(job.tiktokResult?.warnings ?? []),
    ...operationErrors,
  ];
  const warningElement = requiredElement<HTMLElement>("result-warnings");
  warningElement.textContent = warnings.join(" ");
  warningElement.hidden = warnings.length === 0;
  uploadResult.hidden = false;
  showToast(label, !succeeded && !stillProcessing);
  resetForm();
}

async function refreshConnectionStatuses(): Promise<void> {
  const [youtube, instagram, tiktok] = await Promise.allSettled([
    apiRequest<YouTubeConnectionStatus>("/api/oauth/youtube/status"),
    apiRequest<PlatformConnectionStatus>("/api/oauth/instagram/status"),
    apiRequest<PlatformConnectionStatus>("/api/oauth/tiktok/status"),
  ]);
  if (youtube.status === "fulfilled") setYouTubeConnection(youtube.value.connected);
  else {
    setYouTubeConnection(false);
    youtubeConnectionLabel.textContent = "Connection check failed";
  }
  if (instagram.status === "fulfilled") {
    setInstagramConnection(
      instagram.value.connected,
      instagram.value.displayName,
      instagram.value.requiresReconnect,
      instagram.value.message,
    );
  } else {
    setInstagramConnection(false);
    instagramConnectionLabel.textContent = "Connection check failed";
  }
  if (tiktok.status === "fulfilled") {
    setTikTokConnection(tiktok.value.connected, tiktok.value.displayName);
  } else {
    setTikTokConnection(false);
    tiktokConnectionLabel.textContent = "Connection check failed";
  }
  await refreshTikTokCreatorInfo();
}

function setYouTubeConnection(connected: boolean): void {
  youtubeConnected = connected;
  youtubeConnectionLabel.textContent = connected ? "Connected" : "Not connected";
  youtubeConnectionLabel.classList.toggle("is-connected", connected);
  youtubeConnect.textContent = connected ? "Reconnect YouTube" : "Connect YouTube";
  youtubeDisconnect.hidden = !connected;
}

function setInstagramConnection(
  connected: boolean,
  displayName?: string,
  requiresReconnect = false,
  message?: string,
): void {
  instagramConnected = connected;
  instagramConnectionLabel.textContent = connected
    ? displayName ?? "Connected"
    : requiresReconnect
      ? "Reconnect required"
      : "Not connected";
  instagramConnectionLabel.title = message ?? "";
  instagramConnectionLabel.classList.toggle("is-connected", connected);
  instagramConnect.textContent = connected || requiresReconnect ? "Reconnect Instagram" : "Connect Instagram";
  instagramDisconnect.hidden = !connected && !requiresReconnect;
}

function setTikTokConnection(connected: boolean, displayName?: string): void {
  tiktokConnected = connected;
  tiktokConnectionLabel.textContent = connected ? displayName ?? "Connected" : "Not connected";
  tiktokConnectionLabel.classList.toggle("is-connected", connected);
  tiktokConnect.textContent = connected ? "Reconnect TikTok" : "Connect TikTok";
  tiktokDisconnect.hidden = !connected;
  if (!connected) {
    tiktokCreatorInfo = null;
    requiredElement<HTMLElement>("tiktok-creator-info").textContent = "Connect TikTok to load creator posting limits.";
    resetTikTokPrivacyOptions();
  }
}

async function disconnectPlatform(platform: "instagram" | "tiktok", button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    await apiRequest(`/api/oauth/${platform}/disconnect`, { method: "POST", body: "{}" });
    if (platform === "instagram") setInstagramConnection(false);
    else setTikTokConnection(false);
    showToast(`${capitalize(platform)} disconnected.`);
  } catch (error) {
    showToast(errorMessage(error), true);
  } finally {
    button.disabled = false;
  }
}

async function refreshTikTokCreatorInfo(): Promise<void> {
  try {
    const review = await apiRequest<TikTokReviewStatus>("/api/tiktok/review-status");
    tiktokReviewStatus = review;
    renderTikTokReviewStatus(review);
    const info = review.creatorInfo;
    if (!info) {
      tiktokCreatorInfo = null;
      resetTikTokPrivacyOptions();
      requiredElement<HTMLElement>("tiktok-creator-info").textContent = review.creatorInfoError ??
        "Connect TikTok to load creator posting limits.";
      return;
    }
    tiktokCreatorInfo = info;
    configureTikTokPrivacy(info, review.appRestriction);
    syncTikTokCommercialAvailability();
    requiredElement<HTMLElement>("tiktok-creator-info").textContent =
      `${info.nickname} (@${info.username}) · privacy: ${info.privacyLevelOptions.map(privacyLabel).join(", ")} · ` +
      `comments ${info.commentDisabled ? "unavailable" : "available"}, Duet ${info.duetDisabled ? "unavailable" : "available"}, ` +
      `Stitch ${info.stitchDisabled ? "unavailable" : "available"} · up to ${info.maxVideoDurationSeconds}s.`;
    configureTikTokInteraction("tiktok-comments", info.commentDisabled);
    configureTikTokInteraction("tiktok-duet", info.duetDisabled);
    configureTikTokInteraction("tiktok-stitch", info.stitchDisabled);
  } catch (error) {
    tiktokCreatorInfo = null;
    tiktokReviewStatus = null;
    resetTikTokPrivacyOptions();
    requiredElement<HTMLElement>("tiktok-creator-info").textContent = `Creator settings unavailable: ${errorMessage(error)}`;
    renderTikTokReviewStatus(null);
  }
}

function configureTikTokPrivacy(
  info: TikTokCreatorInfo,
  appRestriction: TikTokReviewStatus["appRestriction"],
): void {
  const previous = tiktokPrivacy.value;
  tiktokPrivacy.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose privacy";
  tiktokPrivacy.append(placeholder);
  for (const value of info.privacyLevelOptions) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = privacyLabel(value);
    option.disabled = appRestriction === "unaudited" && value !== "SELF_ONLY";
    if (option.disabled) option.textContent += " (requires production approval)";
    tiktokPrivacy.append(option);
  }
  tiktokPrivacy.disabled = false;
  tiktokPrivacy.value = info.privacyLevelOptions.includes(previous) &&
    !(appRestriction === "unaudited" && previous !== "SELF_ONLY")
    ? previous
    : "";
}

function resetTikTokPrivacyOptions(): void {
  tiktokPrivacy.replaceChildren();
  const option = document.createElement("option");
  option.value = "";
  option.textContent = "Connect TikTok to load options";
  tiktokPrivacy.append(option);
  tiktokPrivacy.disabled = true;
}

function syncTikTokCommercialAvailability(): void {
  const disabled = tiktokReviewStatus?.appRestriction === "unaudited" || tiktokPrivacy.value === "SELF_ONLY";
  tiktokPaidPartnership.disabled = disabled;
  tiktokPaidPartnership.title = disabled
    ? "Branded content requires a non-private privacy option and TikTok production approval."
    : "";
  if (disabled) tiktokPaidPartnership.checked = false;
}

function renderTikTokReviewStatus(status: TikTokReviewStatus | null): void {
  setReviewDiagnostic("review-login-kit", status?.loginKitConfigured, "Configured", "Not configured");
  setReviewDiagnostic("review-video-publish", status?.videoPublishScopeGranted, "Granted", "Not granted");
  setReviewDiagnostic("review-creator-info", status?.creatorInfoWorking, "Working", "Not verified");
  setReviewDiagnostic("review-direct-post", status?.directPostInitialized, "Initialized", "Not initialized yet");
  const restriction = requiredElement<HTMLElement>("review-app-restriction");
  restriction.textContent = status
    ? status.appRestriction === "approved" ? "Production approved" : "Unaudited"
    : "Unavailable";
  restriction.classList.toggle("is-ready", status?.appRestriction === "approved");
}

function setReviewDiagnostic(id: string, ready: boolean | undefined, readyText: string, pendingText: string): void {
  const element = requiredElement<HTMLElement>(id);
  element.textContent = ready === undefined ? "Unavailable" : ready ? readyText : pendingText;
  element.classList.toggle("is-ready", ready === true);
}

function privacyLabel(value: string): string {
  return ({
    PUBLIC_TO_EVERYONE: "Everyone",
    MUTUAL_FOLLOW_FRIENDS: "Friends",
    FOLLOWER_OF_CREATOR: "Followers",
    SELF_ONLY: "Only me",
  } as Record<string, string>)[value] ?? value;
}

function configureTikTokInteraction(id: string, providerDisabled: boolean): void {
  const input = requiredElement<HTMLInputElement>(id);
  input.disabled = providerDisabled;
  if (providerDisabled) input.checked = false;
}

async function refreshScheduledPosts(): Promise<void> {
  const refresh = requiredElement<HTMLButtonElement>("scheduled-refresh");
  refresh.disabled = true;
  refresh.textContent = "Refreshing...";
  try {
    const response = await apiRequest<ScheduledPostsResponse>("/api/scheduled-posts");
    postsCache = response.posts;
    if (tiktokConnected && postsCache.some((post) => post.platformStatus.tiktok === "failed")) {
      await refreshTikTokCreatorInfo();
    }
    renderScheduledPosts();
  } catch (error) {
    showToast(errorMessage(error), true);
  } finally {
    refresh.disabled = false;
    refresh.textContent = "Refresh";
  }
}

function setPostFilter(filter: PostFilter): void {
  activePostFilter = filter;
  document.querySelectorAll<HTMLButtonElement>("[data-post-filter]").forEach((button) => {
    const selected = button.dataset.postFilter === filter;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  renderScheduledPosts();
}

function renderScheduledPosts(): void {
  const list = requiredElement<HTMLElement>("scheduled-posts-list");
  list.replaceChildren();
  const posts = postsCache.filter((post) => postCategory(post) === activePostFilter);
  if (posts.length === 0) {
    const empty = document.createElement("article");
    empty.className = "panel empty-scheduled";
    empty.textContent = {
      upcoming: "No upcoming posts.",
      failed: "No posts need attention.",
      published: "No published posts yet.",
      cancelled: "No cancelled posts.",
    }[activePostFilter];
    list.append(empty);
    return;
  }
  for (const post of posts) list.append(createScheduledPostCard(post));
}

function createScheduledPostCard(post: ScheduledPostSummary): HTMLElement {
  const card = document.createElement("article");
  card.id = `post-${post.id}`;
  card.className = `panel scheduled-card post-card-${postCategory(post)}`;

  const imageWrap = document.createElement("div");
  imageWrap.className = "scheduled-thumbnail-wrap";
  if (post.thumbnailUrl) {
    const image = document.createElement("img");
    image.className = "scheduled-thumbnail";
    image.src = post.thumbnailUrl;
    image.alt = "";
    image.addEventListener("error", () => imageWrap.classList.add("thumbnail-unavailable"), { once: true });
    imageWrap.append(image);
  } else {
    imageWrap.classList.add("thumbnail-unavailable");
  }

  const content = document.createElement("div");
  content.className = "scheduled-card-content";
  const heading = document.createElement("div");
  heading.className = "scheduled-card-heading";
  const text = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = post.title;
  const caption = document.createElement("p");
  caption.textContent = post.description || "No caption";
  text.append(title, caption);
  const actions = document.createElement("div");
  actions.className = "connection-actions";
  let edit: HTMLButtonElement | undefined;
  if (post.canEdit) {
    edit = document.createElement("button");
    edit.type = "button";
    edit.className = "connect-button compact-action";
    edit.textContent = "Edit";
    actions.append(edit);
  }
  if (post.canCancel) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "text-button destructive-button compact-action";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", async () => {
      if (!window.confirm(`Cancel “${post.title}” and delete its pending media? This cannot be undone.`)) return;
      cancel.disabled = true;
      try {
        await apiRequest(`/api/jobs/${encodeURIComponent(post.id)}`, { method: "DELETE" });
        showToast("Post cancelled and temporary media removed.");
        await Promise.all([refreshScheduledPosts(), refreshSystemStatus()]);
      } catch (error) {
        showToast(errorMessage(error), true);
        cancel.disabled = false;
      }
    });
    actions.append(cancel);
  }
  heading.append(text, actions);

  const meta = document.createElement("div");
  meta.className = "scheduled-meta";
  const schedule = document.createElement("span");
  schedule.textContent = post.scheduledAt
    ? `Scheduled ${formatDate(post.scheduledAt)}`
    : `Created ${formatDate(post.createdAt)}`;
  const size = document.createElement("span");
  size.textContent = formatBytes(post.fileSizeBytes);
  meta.append(schedule, size);

  const platformList = document.createElement("div");
  platformList.className = "post-platform-statuses";
  for (const platform of selectedPlatformsFromSummary(post)) {
    platformList.append(createPlatformDeliveryRow(post, platform));
  }

  content.append(heading, meta, platformList);
  if (postCategory(post) === "failed") {
    const retention = document.createElement("p");
    retention.className = `retention-note ${post.sourceMediaAvailable ? "" : "source-expired"}`;
    retention.textContent = post.sourceMediaAvailable && post.mediaExpiresAt
      ? `Source retained for retry until ${formatDate(post.mediaExpiresAt)}`
      : "Source expired — upload again";
    content.append(retention);
  }
  if (edit) {
    const editForm = createScheduledEditForm(post);
    editForm.hidden = true;
    edit.addEventListener("click", () => {
      editForm.hidden = !editForm.hidden;
      edit!.textContent = editForm.hidden ? "Edit" : "Close edit";
    });
    content.append(editForm);
  }
  card.append(imageWrap, content);
  return card;
}

function createPlatformDeliveryRow(post: ScheduledPostSummary, platform: Platform): HTMLElement {
  const row = document.createElement("div");
  row.className = "platform-delivery-row";
  const icon = document.createElement("span");
  icon.className = `platform-icon ${platform}`;
  icon.textContent = platform === "youtube" ? "YT" : platform === "instagram" ? "IG" : "TT";
  const copy = document.createElement("div");
  const heading = document.createElement("div");
  heading.className = "platform-delivery-heading";
  const name = document.createElement("strong");
  name.textContent = capitalize(platform);
  const state = effectivePlatformState(post, platform);
  const badge = document.createElement("span");
  badge.className = `job-state delivery-${state}`;
  badge.textContent = capitalize(state);
  heading.append(name, badge);
  copy.append(heading);
  if (state === "failed") {
    const error = document.createElement("p");
    error.className = "platform-error-copy";
    error.textContent = humanReadablePlatformError(platform, post.platformErrors[platform]);
    error.title = post.platformErrors[platform] ?? "";
    copy.append(error);
  }
  row.append(icon, copy);
  const retry = retryActionFor(post, platform);
  if (retry) row.append(retry);
  return row;
}

function retryActionFor(post: ScheduledPostSummary, platform: Platform): HTMLElement | null {
  if (post.platformStatus[platform] !== "failed" || !["instagram", "tiktok"].includes(platform)) return null;
  if (!post.sourceMediaAvailable) return null;
  const prerequisite = document.createElement("span");
  prerequisite.className = "retry-prerequisite";
  if (platform === "instagram" && !instagramConnected) {
    prerequisite.textContent = "Reconnect Instagram to retry";
    return prerequisite;
  }
  if (platform === "tiktok") {
    if (!tiktokConnected) {
      prerequisite.textContent = "Reconnect TikTok to retry";
      return prerequisite;
    }
    if (tiktokReviewStatus?.appRestriction === "unaudited" && !tiktokCreatorInfo?.isPrivateAccount) {
      prerequisite.textContent = tiktokCreatorInfo
        ? "TikTok public posting requires TikTok production approval."
        : "Checking TikTok prerequisites…";
      return prerequisite;
    }
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "connect-button retry-button";
  button.textContent = `Retry ${capitalize(platform)}`;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await apiRequest(`/api/jobs/${encodeURIComponent(post.id)}/retry/${platform}`, {
        method: "POST",
        body: "{}",
      });
      showToast(`${capitalize(platform)} retry queued. Other platforms will not be reposted.`);
      await Promise.all([refreshScheduledPosts(), refreshSystemStatus()]);
    } catch (error) {
      showToast(errorMessage(error), true);
      button.disabled = false;
    }
  });
  return button;
}

function postCategory(post: ScheduledPostSummary): PostFilter {
  if (post.status === "cancelled") return "cancelled";
  if (post.status === "failed" || post.status === "partial") return "failed";
  if (selectedPlatformsFromSummary(post).some((platform) => post.platformStatus[platform] === "failed")) return "failed";
  if (selectedPlatformsFromSummary(post).some((platform) =>
    ["pending", "publishing"].includes(effectivePlatformState(post, platform)))) return "upcoming";
  return "published";
}

function effectivePlatformState(
  post: ScheduledPostSummary,
  platform: Platform,
): "pending" | "publishing" | "published" | "failed" | "cancelled" {
  const state = post.platformStatus[platform] ?? "pending";
  if (state === "failed" || state === "cancelled" || state === "published") return state;
  if (state === "uploading" || state === "processing") return "publishing";
  if (state === "scheduled") {
    return post.scheduledAt && new Date(post.scheduledAt).getTime() > Date.now() ? "pending" : "published";
  }
  return "pending";
}

function humanReadablePlatformError(platform: Platform, error?: string): string {
  if (!error) return `${capitalize(platform)} delivery failed.`;
  if (
    error.includes("unaudited_client_can_only_post_to_private_accounts") ||
    error.includes("must be switched to Private") ||
    error.includes("production approval")
  ) {
    return "TikTok public posting requires TikTok production approval";
  }
  if (error.includes("scope_not_authorized") || error.includes("video.publish")) {
    return "TikTok publishing permission is missing";
  }
  if (error.toLowerCase().includes("token") && error.toLowerCase().includes("expired")) {
    return `${capitalize(platform)} connection expired`;
  }
  const firstSentence = error.split(/(?<=[.!?])\s/u)[0] ?? error;
  return firstSentence.length > 150 ? `${firstSentence.slice(0, 147)}…` : firstSentence;
}

function createScheduledEditForm(post: ScheduledPostSummary): HTMLFormElement {
  const editForm = document.createElement("form");
  editForm.className = "scheduled-edit-form";

  const title = editTextInput("Title", post.title, 100);
  const description = document.createElement("textarea");
  description.value = post.description;
  description.maxLength = 2200;
  description.rows = 4;
  const descriptionField = fieldWithControl("Caption / description", description);
  const schedule = editTextInput("Publish date and time", toLocalDateTime(post.scheduledAt!));
  schedule.input.type = "datetime-local";
  schedule.input.required = true;
  schedule.input.min = scheduledAtInput.min;

  const platformGroup = document.createElement("fieldset");
  platformGroup.className = "scheduled-platforms";
  const legend = document.createElement("legend");
  legend.textContent = "Destinations";
  platformGroup.append(legend);
  const platformInputs = {} as Record<Platform, HTMLInputElement>;
  for (const platform of ["youtube", "instagram", "tiktok"] as Platform[]) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = post.platforms[platform];
    checkbox.disabled = !post.platforms[platform] && !post.sourceMediaAvailable;
    platformInputs[platform] = checkbox;
    const label = document.createElement("label");
    label.className = "check-field";
    const copy = document.createElement("span");
    copy.textContent = capitalize(platform);
    label.append(checkbox, copy);
    platformGroup.append(label);
  }

  const madeForKids = checkboxControl("YouTube: made for kids", post.youtube.madeForKids);
  const shareToFeed = checkboxControl("Instagram: also share to feed", post.instagram.shareToFeed);
  const comments = checkboxControl("TikTok: allow comments", post.tiktok.allowComments);
  const duet = checkboxControl("TikTok: allow Duet", post.tiktok.allowDuet);
  const stitch = checkboxControl("TikTok: allow Stitch", post.tiktok.allowStitch);
  const cover = editTextInput("TikTok cover frame (ms)", String(post.tiktok.coverTimestampMs));
  cover.input.type = "number";
  cover.input.min = "0";
  cover.input.step = "1";
  const consent = checkboxControl(
    "I consent to Social Uploader sending this scheduled video and caption directly to TikTok",
    post.tiktok.consentConfirmed === true,
  );
  const youtubeSettings = groupedSettings("YouTube settings", madeForKids.label);
  const instagramSettings = groupedSettings("Instagram settings", shareToFeed.label);
  const tiktokNote = document.createElement("p");
  tiktokNote.className = "settings-note restriction-note";
  tiktokNote.textContent = "TikTok public posting requires TikTok production approval.";
  const tiktokSettings = groupedSettings(
    "TikTok settings",
    comments.label,
    duet.label,
    stitch.label,
    cover.field,
    consent.label,
    tiktokNote,
  );
  const syncSettingGroups = () => {
    youtubeSettings.hidden = !platformInputs.youtube.checked;
    instagramSettings.hidden = !platformInputs.instagram.checked;
    tiktokSettings.hidden = !platformInputs.tiktok.checked;
  };
  for (const input of Object.values(platformInputs)) input.addEventListener("change", syncSettingGroups);
  syncSettingGroups();

  const thumbnail = document.createElement("input");
  thumbnail.type = "file";
  thumbnail.accept = "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";
  const thumbnailField = fieldWithControl("Replacement thumbnail / cover (optional)", thumbnail);
  const note = document.createElement("p");
  note.className = "settings-note";
  note.textContent = post.sourceMediaAvailable
    ? "YouTube changes are synchronized now. Instagram/TikTok changes remain pending until dispatch."
    : "The source video was already released; existing destinations can be edited, but another platform cannot be added.";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "primary-button compact-button";
  save.textContent = "Save changes";

  editForm.append(
    title.field,
    descriptionField,
    schedule.field,
    platformGroup,
    youtubeSettings,
    instagramSettings,
    tiktokSettings,
    thumbnailField,
    note,
    save,
  );

  editForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = (["youtube", "instagram", "tiktok"] as Platform[]).filter(
      (platform) => platformInputs[platform].checked,
    );
    if (selected.length === 0) {
      showToast("Keep at least one destination, or cancel the post.", true);
      return;
    }
    if (selected.includes("tiktok") && !consent.input.checked) {
      showToast("Confirm consent before scheduling a TikTok Direct Post.", true);
      consent.input.focus();
      return;
    }
    if (
      selected.includes("tiktok") &&
      tiktokReviewStatus?.appRestriction === "unaudited" &&
      !tiktokCreatorInfo?.isPrivateAccount
    ) {
      showToast("TikTok public posting requires TikTok production approval.", true);
      return;
    }
    save.disabled = true;
    try {
      const replacement = thumbnail.files?.[0];
      if (replacement) {
        const preparedReplacement = await prepareThumbnailForPlatforms(replacement, selected);
        await uploadScheduledThumbnail(post.id, preparedReplacement);
      }
      const input: EditScheduledPostRequest = {
        title: title.input.value.trim(),
        description: description.value,
        scheduledAt: new Date(schedule.input.value).toISOString(),
        platforms: {
          youtube: platformInputs.youtube.checked,
          instagram: platformInputs.instagram.checked,
          tiktok: platformInputs.tiktok.checked,
        },
        youtube: { visibility: "public", madeForKids: madeForKids.input.checked },
        instagram: { shareToFeed: shareToFeed.input.checked },
        tiktok: {
          privacy: post.tiktok.privacy,
          allowComments: comments.input.checked,
          allowDuet: duet.input.checked,
          allowStitch: stitch.input.checked,
          coverTimestampMs: Number(cover.input.value),
          consentConfirmed: consent.input.checked,
          promoteOwnBrand: post.tiktok.promoteOwnBrand === true,
          paidPartnership: post.tiktok.paidPartnership === true,
        },
      };
      await apiRequest(`/api/jobs/${encodeURIComponent(post.id)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      });
      showToast("Scheduled post updated.");
      await Promise.all([refreshScheduledPosts(), refreshSystemStatus()]);
    } catch (error) {
      showToast(errorMessage(error), true);
      save.disabled = false;
    }
  });
  return editForm;
}

async function uploadScheduledThumbnail(jobId: string, file: File): Promise<void> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/thumbnail`, {
    method: "PUT",
    headers: { "content-type": file.type, "x-file-name": file.name },
    body: file,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ApiError | null;
    throw new Error(payload?.error ?? `Thumbnail update failed (HTTP ${response.status}).`);
  }
}

function editTextInput(labelText: string, value: string, maxLength?: number): { field: HTMLLabelElement; input: HTMLInputElement } {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.required = true;
  if (maxLength) input.maxLength = maxLength;
  return { field: fieldWithControl(labelText, input), input };
}

function fieldWithControl(labelText: string, control: HTMLElement): HTMLLabelElement {
  const field = document.createElement("label");
  field.className = "mini-field";
  const label = document.createElement("span");
  label.textContent = labelText;
  field.append(label, control);
  return field;
}

function checkboxControl(labelText: string, checked: boolean): { label: HTMLLabelElement; input: HTMLInputElement } {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  const label = document.createElement("label");
  label.className = "check-field";
  const copy = document.createElement("span");
  copy.textContent = labelText;
  label.append(input, copy);
  return { label, input };
}

function groupedSettings(labelText: string, ...controls: HTMLElement[]): HTMLFieldSetElement {
  const group = document.createElement("fieldset");
  group.className = "platform-settings-group";
  const legend = document.createElement("legend");
  legend.textContent = labelText;
  group.append(legend, ...controls);
  return group;
}

function selectedPlatformsFromSummary(post: ScheduledPostSummary): Platform[] {
  return (Object.entries(post.platforms) as Array<[Platform, boolean]>)
    .filter(([, enabled]) => enabled)
    .map(([platform]) => platform);
}

async function refreshSystemStatus(): Promise<void> {
  const refresh = requiredElement<HTMLButtonElement>("status-refresh");
  refresh.disabled = true;
  refresh.textContent = "Refreshing...";
  try {
    const status = await apiRequest<SystemStatusResponse>("/api/system/status");
    renderSystemStatus(status);
  } catch (error) {
    showToast(errorMessage(error), true);
  } finally {
    refresh.disabled = false;
    refresh.textContent = "Refresh";
  }
}

function renderSystemStatus(status: SystemStatusResponse): void {
  requiredElement<HTMLElement>("status-generated-at").textContent = `Updated ${formatDate(status.generatedAt)}`;
  requiredElement<HTMLElement>("storage-used").textContent = `${formatBytes(status.storage.usedBytes)} / 8 GB`;
  requiredElement<HTMLElement>("storage-percent").textContent = `${status.storage.usedPercent.toFixed(2)}%`;
  requiredElement<HTMLElement>("storage-bar").style.width = `${status.storage.usedPercent}%`;
  requiredElement<HTMLElement>("storage-count").textContent = String(status.storage.temporaryObjectCount);
  requiredElement<HTMLElement>("storage-oldest").textContent = status.storage.oldestTemporaryObject
    ? `${formatDate(status.storage.oldestTemporaryObject.uploadedAt)} (${formatBytes(status.storage.oldestTemporaryObject.size)})`
    : "None";

  renderConnection("status-youtube", status.connections.youtube);
  renderConnection("status-instagram", status.connections.instagram);
  renderConnection("status-tiktok", status.connections.tiktok);
  requiredElement<HTMLElement>("scheduled-count").textContent = String(status.scheduling.pendingCount);
  requiredElement<HTMLElement>("next-scheduled-publish").textContent = status.scheduling.nextPublishAt
    ? formatDate(status.scheduling.nextPublishAt)
    : "None";
  requiredElement<HTMLElement>("failed-posts-count").textContent = String(status.scheduling.failedCount);
  const lastRun = status.scheduling.recentRuns[0];
  requiredElement<HTMLElement>("last-scheduler-run").textContent = lastRun
    ? formatDate(lastRun.finishedAt)
    : "No runs yet";
  requiredElement<HTMLElement>("last-scheduler-summary").textContent = lastRun
    ? `${lastRun.processedPlatforms} steps · ${lastRun.succeeded} completed · ${lastRun.failed} errors`
    : "No run loaded.";
  renderSchedulerRuns(status);
  renderPlatformErrors(status);
  renderEvents(
    "cleanup-list",
    status.events.filter((event) => event.category === "cleanup" || event.category === "storage"),
    "No recent storage cleanup events.",
  );
}

function renderSchedulerRuns(status: SystemStatusResponse): void {
  const list = requiredElement<HTMLOListElement>("scheduler-runs-list");
  list.replaceChildren();
  if (status.scheduling.recentRuns.length === 0) {
    const item = document.createElement("li");
    item.className = "empty-event";
    item.textContent = "No scheduler runs yet.";
    list.append(item);
    return;
  }
  for (const run of status.scheduling.recentRuns) {
    const item = document.createElement("li");
    item.className = `event-item ${run.failed ? "event-error" : "event-info"}`;
    const heading = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = `${run.processedPlatforms} platform step(s)`;
    const time = document.createElement("time");
    time.dateTime = run.finishedAt;
    time.textContent = formatDate(run.finishedAt);
    heading.append(label, time);
    const detail = document.createElement("p");
    detail.textContent = `${run.dueJobs} due · ${run.succeeded} completed · ${run.failed} errors · ${run.deletedObjects} objects cleaned`;
    item.append(heading, detail);
    list.append(item);
  }
}

function renderConnection(id: string, connected: boolean): void {
  const element = requiredElement<HTMLElement>(id);
  element.textContent = connected ? "Connected" : "Not connected";
  element.classList.toggle("is-connected", connected);
}

function renderPlatformErrors(status: SystemStatusResponse): void {
  const list = requiredElement<HTMLOListElement>("errors-list");
  list.replaceChildren();
  const errors = status.recentErrors.filter((event) => Boolean(event.platform));
  if (errors.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-event";
    empty.textContent = "No recent platform errors.";
    list.append(empty);
    return;
  }
  const titles = new Map(status.jobs.map((job) => [job.id, job.title]));
  for (const event of errors) {
    const platform = event.platform!;
    const item = document.createElement("li");
    item.className = "event-item event-error platform-error-event";
    const icon = document.createElement("span");
    icon.className = `platform-icon ${platform}`;
    icon.textContent = platform === "youtube" ? "YT" : platform === "instagram" ? "IG" : "TT";
    const body = document.createElement("div");
    body.className = "platform-error-body";
    const heading = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = humanReadablePlatformError(platform, event.message);
    const time = document.createElement("time");
    time.dateTime = event.timestamp;
    time.textContent = formatDate(event.timestamp);
    heading.append(label, time);
    body.append(heading);
    if (event.jobId) {
      const related = document.createElement("button");
      related.type = "button";
      related.className = "text-button related-post-button";
      related.textContent = `${titles.get(event.jobId) ?? "Related post"} · ${event.jobId}`;
      related.addEventListener("click", () => {
        document.querySelector<HTMLButtonElement>('[data-view-target="scheduled-view"]')?.click();
        setPostFilter("failed");
        window.setTimeout(() => document.getElementById(`post-${event.jobId}`)?.scrollIntoView({ block: "center" }), 250);
      });
      body.append(related);
    }
    const technical = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Technical provider error";
    const message = document.createElement("p");
    message.textContent = event.message;
    technical.append(summary, message);
    body.append(technical);
    item.append(icon, body);
    list.append(item);
  }
}

function renderEvents(
  id: string,
  events: SystemStatusResponse["events"],
  emptyMessage: string,
): void {
  const list = requiredElement<HTMLOListElement>(id);
  list.replaceChildren();
  if (events.length === 0) {
    const item = document.createElement("li");
    item.className = "empty-event";
    item.textContent = emptyMessage;
    list.append(item);
    return;
  }
  for (const event of events) {
    const item = document.createElement("li");
    item.className = `event-item event-${event.level}`;
    const heading = document.createElement("div");
    const category = document.createElement("strong");
    category.textContent = event.platform ? capitalize(event.platform) : capitalize(event.category);
    const time = document.createElement("time");
    time.dateTime = event.timestamp;
    time.textContent = formatDate(event.timestamp);
    heading.append(category, time);
    const message = document.createElement("p");
    message.textContent = event.message;
    item.append(heading, message);
    list.append(item);
  }
}

function showOAuthResult(): void {
  const url = new URL(window.location.href);
  const platform = (["youtube", "instagram", "tiktok"] as const).find((name) => url.searchParams.has(name));
  if (!platform) return;
  const result = url.searchParams.get(platform);
  if (result === "connected") showToast(`${capitalize(platform)} connected securely.`);
  else showToast(url.searchParams.get("message") ?? `${capitalize(platform)} connection failed.`, true);
  url.searchParams.delete(platform);
  url.searchParams.delete("message");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function toAsset(key: string, file: File) {
  return { key, originalName: file.name, contentType: file.type, size: file.size };
}

function setR2Progress(progress: { video: number; thumbnail: number }, uploadThumbnail: File): void {
  const totalBytes = videoFile!.size + uploadThumbnail.size;
  const uploadedBytes = videoFile!.size * progress.video + uploadThumbnail.size * progress.thumbnail;
  setProgress("uploading", "Staging files directly in R2...", 6 + Math.round((uploadedBytes / totalBytes) * 40));
}

function setProgress(state: UploadState, label: string, percent: number): void {
  currentPercent = Math.max(currentPercent, percent);
  if (state === "failed" || state === "cancelled") currentPercent = percent;
  uploadStatus.hidden = false;
  statusState.textContent = capitalize(state);
  statusState.className = `state-badge state-${state}`;
  statusLabel.textContent = label;
  statusPercent.textContent = `${Math.round(currentPercent)}%`;
  progressBar.style.width = `${currentPercent}%`;
  uploadStatus.dataset.state = state;
  cancelButton.hidden = !["uploading"].includes(state);
  cancelButton.disabled = state !== "uploading";
}

function setBusy(isBusy: boolean): void {
  saveButton.disabled = isBusy;
  form.setAttribute("aria-busy", String(isBusy));
  saveButton.querySelector("span")!.textContent = isBusy ? "Working..." : "Upload & publish";
  if (!isBusy) cancelButton.hidden = true;
}

function resetForm(): void {
  form.reset();
  platformSelection = selectionFromToggleInputs();
  syncPlatformSelectionControls();
  videoFile = null;
  videoDurationSeconds = 0;
  thumbnailFile = null;
  videoDropzone.classList.remove("has-file");
  thumbnailDropzone.classList.remove("has-file");
  requiredElement<HTMLElement>("video-name").textContent = "Drop your MP4 here";
  requiredElement<HTMLElement>("video-meta").textContent = "or click to choose a file - up to 2 GB";
  requiredElement<HTMLElement>("thumbnail-name").textContent = "Choose a thumbnail";
  requiredElement<HTMLElement>("thumbnail-meta").textContent = "JPG, PNG, or WebP - up to 10 MB";
  requiredElement<HTMLElement>("thumbnail-preview").style.backgroundImage = "";
  requiredElement<HTMLElement>("thumbnail-preview").classList.remove("has-image");
  if (thumbnailObjectUrl) URL.revokeObjectURL(thumbnailObjectUrl);
  thumbnailObjectUrl = null;
  updateCount("title-count", 0);
  updateCount("description-count", 0);
  setScheduleMinimum();
  updateScheduleRequirement();
}

function setScheduleMinimum(): void {
  const minimum = new Date(Date.now() + 2 * 60 * 1000);
  const local = new Date(minimum.getTime() - minimum.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  scheduledAtInput.min = local;
}

function updateScheduleRequirement(): void {
  const youtubeEnabled = platformSelection.youtube;
  scheduledAtInput.required = youtubeEnabled;
  requiredElement<HTMLElement>("timezone-label").textContent = youtubeEnabled
    ? `All selected platforms use this time (${timezone}); YouTube uses its native schedule`
    : `Choose a future time (${timezone}), or leave blank to publish Instagram/TikTok now`;
}

function setAllPlatforms(enabled: boolean): void {
  applyPlatformSelection(allPlatformSelection(enabled));
}

function applyPlatformSelection(next: PlatformSelection): void {
  const enableTikTok = !platformSelection.tiktok && next.tiktok;
  platformSelection = next;
  for (const platform of PLATFORMS) platformToggleInputs[platform].checked = next[platform];
  syncPlatformSelectionControls();
  updateScheduleRequirement();
  if (enableTikTok && tiktokConnected) void refreshTikTokCreatorInfo();
}

function syncPlatformSelectionControls(): void {
  const state = selectionControlState(platformSelection);
  selectAllPlatformsButton.disabled = state.allSelected;
  selectAllPlatformsButton.setAttribute("aria-pressed", String(state.allSelected));
  selectNoPlatformsButton.disabled = state.noneSelected;
  selectNoPlatformsButton.setAttribute("aria-pressed", String(state.noneSelected));
}

function selectionFromToggleInputs(): PlatformSelection {
  return Object.fromEntries(
    PLATFORMS.map((platform) => [platform, platformToggleInputs[platform].checked]),
  ) as PlatformSelection;
}

function selectedPlatforms(): Platform[] {
  return selectedPlatformsFor(platformSelection);
}

function selectedPlatformsFromJob(job: StoredJob): Platform[] {
  return (Object.entries(job.platforms) as Array<[Platform, boolean]>)
    .filter(([, enabled]) => enabled)
    .map(([platform]) => platform);
}

function readVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    video.preload = "metadata";
    video.addEventListener("loadedmetadata", () => {
      const duration = video.duration;
      URL.revokeObjectURL(url);
      if (!Number.isFinite(duration) || duration <= 0) reject(new Error("Invalid video duration."));
      else resolve(duration);
    }, { once: true });
    video.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read video metadata."));
    }, { once: true });
    video.src = url;
  });
}

function showToast(message: string, isError = false): void {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 7000);
}

function throwIfCancelled(): void {
  if (cancelRequested) throw new Error("Upload cancelled by user.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function updateCount(id: string, value: number): void {
  requiredElement<HTMLElement>(id).textContent = String(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function toLocalDateTime(value: string): string {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return minutes ? `${minutes}:${String(remainder).padStart(2, "0")}` : `${remainder}s`;
}

function humanizeStatus(value: string): string {
  return value.toLowerCase().replaceAll("_", " ");
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}`);
  return element as T;
}
