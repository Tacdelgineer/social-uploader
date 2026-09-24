import "./styles.css";
import {
  THUMBNAIL_MAX_BYTES,
  VIDEO_CONTENT_TYPES,
  VIDEO_MAX_BYTES,
  YOUTUBE_THUMBNAIL_CONTENT_TYPES,
  type ApiError,
  type CompleteYouTubeResponse,
  type CreateJobResponse,
  type DraftRequest,
  type PresignRequest,
  type PresignResponse,
  type YouTubeConnectionStatus,
} from "../shared/contracts";

const form = requiredElement<HTMLFormElement>("draft-form");
const videoInput = requiredElement<HTMLInputElement>("video-input");
const thumbnailInput = requiredElement<HTMLInputElement>("thumbnail-input");
const videoDropzone = requiredElement<HTMLElement>("video-dropzone");
const thumbnailDropzone = requiredElement<HTMLElement>("thumbnail-dropzone");
const titleInput = requiredElement<HTMLInputElement>("title");
const descriptionInput = requiredElement<HTMLTextAreaElement>("description");
const scheduledAtInput = requiredElement<HTMLInputElement>("scheduled-at");
const saveButton = requiredElement<HTMLButtonElement>("save-button");
const uploadStatus = requiredElement<HTMLElement>("upload-status");
const statusLabel = requiredElement<HTMLElement>("status-label");
const statusPercent = requiredElement<HTMLElement>("status-percent");
const progressBar = requiredElement<HTMLElement>("progress-bar");
const toast = requiredElement<HTMLElement>("toast");
const youtubeConnect = requiredElement<HTMLButtonElement>("youtube-connect");
const youtubeDisconnect = requiredElement<HTMLButtonElement>("youtube-disconnect");
const youtubeConnectionLabel = requiredElement<HTMLElement>("youtube-connection-label");

let videoFile: File | null = null;
let thumbnailFile: File | null = null;
let thumbnailObjectUrl: string | null = null;
let youtubeConnected = false;
let toastTimer: number | undefined;

setupDropzone(videoDropzone, videoInput, setVideo);
setupDropzone(thumbnailDropzone, thumbnailInput, setThumbnail);
setScheduleMinimum();
void refreshYouTubeStatus();
showOAuthResult();

titleInput.addEventListener("input", () => updateCount("title-count", titleInput.value.length));
descriptionInput.addEventListener("input", () =>
  updateCount("description-count", descriptionInput.value.length),
);

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
requiredElement<HTMLElement>("timezone-label").textContent = `Scheduled in ${timezone}`;

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

document.querySelectorAll<HTMLButtonElement>("[data-placeholder]").forEach((button) => {
  button.addEventListener("click", () => {
    showToast(`${button.dataset.placeholder ?? "Platform"} remains a placeholder in Milestone 2.`);
  });
});

document.querySelectorAll<HTMLInputElement>(".toggle-wrap input").forEach((toggle) => {
  toggle.addEventListener("click", (event) => event.stopPropagation());
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!validateForm()) return;

  setBusy(true);
  const jobId = crypto.randomUUID();

  try {
    setProgress("Reserving capped temporary storage...", 3);
    const reservation = await requestPresign(jobId, videoFile!, thumbnailFile!);
    const { video: videoUpload, thumbnail: thumbnailUpload } = reservation.uploads;

    setProgress("Staging files directly in R2...", 6);
    const progress = { video: 0, thumbnail: 0 };
    await Promise.all([
      uploadDirectToR2(videoUpload.uploadUrl, videoFile!, (value) => {
        progress.video = value;
        setR2Progress(progress);
      }),
      uploadDirectToR2(thumbnailUpload.uploadUrl, thumbnailFile!, (value) => {
        progress.thumbnail = value;
        setR2Progress(progress);
      }),
    ]);

    setProgress("Creating YouTube schedule...", 48);
    const job = buildJob(jobId, videoUpload.objectKey, thumbnailUpload.objectKey);
    const created = await apiRequest<CreateJobResponse>("/api/jobs", {
      method: "POST",
      body: JSON.stringify(job),
    });

    setProgress("Uploading video directly to YouTube...", 52);
    const videoId = await uploadDirectToYouTube(
      created.youtube.uploadUrl,
      created.youtube.accessToken,
      videoFile!,
      (value) => setProgress("Uploading video directly to YouTube...", 52 + Math.round(value * 39)),
    );

    setProgress("Applying thumbnail and verifying schedule...", 94);
    const completed = await apiRequest<CompleteYouTubeResponse>(
      `/api/jobs/${encodeURIComponent(jobId)}/youtube/complete`,
      { method: "POST", body: JSON.stringify({ videoId }) },
    );
    setProgress("Scheduled and temporary media deleted", 100);
    showToast(`YouTube accepted video ${completed.videoId}; temporary R2 files were deleted.`);
    resetForm();
  } catch (error) {
    showToast(`${errorMessage(error)} Temporary files remain protected by 7-day cleanup.`, true);
    setProgress("Upload stopped", 0);
  } finally {
    setBusy(false);
  }
});

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
  requiredElement<HTMLElement>("video-name").textContent = file.name;
  requiredElement<HTMLElement>("video-meta").textContent = `${formatBytes(file.size)} - MP4 ready`;
  videoDropzone.classList.add("has-file");
}

function setThumbnail(file: File): void {
  if (!(YOUTUBE_THUMBNAIL_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    showToast("Choose a JPG or PNG thumbnail for YouTube.", true);
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

function validateForm(): boolean {
  if (!youtubeConnected) {
    showToast("Connect YouTube before uploading.", true);
    youtubeConnect.focus();
    return false;
  }
  if (!requiredElement<HTMLInputElement>("youtube-enabled").checked) {
    showToast("Enable YouTube for this milestone.", true);
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
  if (!form.reportValidity()) return false;
  const publishAt = new Date(scheduledAtInput.value);
  if (Number.isNaN(publishAt.getTime()) || publishAt.getTime() <= Date.now() + 60_000) {
    showToast("Choose a publish time at least one minute in the future.", true);
    scheduledAtInput.focus();
    return false;
  }
  return true;
}

function buildJob(jobId: string, videoKey: string, thumbnailKey: string): DraftRequest {
  return {
    id: jobId,
    title: titleInput.value.trim(),
    description: descriptionInput.value,
    scheduledAt: new Date(scheduledAtInput.value).toISOString(),
    timezone,
    platforms: { youtube: true, instagram: false, tiktok: false },
    youtube: {
      visibility: "public",
      madeForKids: requiredElement<HTMLSelectElement>("youtube-made-for-kids").value === "true",
    },
    assets: {
      video: toAsset(videoKey, videoFile!),
      thumbnail: toAsset(thumbnailKey, thumbnailFile!),
    },
  };
}

async function requestPresign(
  jobId: string,
  video: File,
  thumbnail: File,
): Promise<PresignResponse> {
  const payload: PresignRequest = {
    jobId,
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
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`R2 rejected ${file.name} (HTTP ${xhr.status}).`));
    });
    xhr.addEventListener("error", () => reject(new Error(`Could not upload ${file.name} to R2.`)));
    xhr.addEventListener("abort", () => reject(new Error(`Upload cancelled for ${file.name}.`)));
    xhr.send(file);
  });
}

function uploadDirectToYouTube(
  url: string,
  accessToken: string,
  file: File,
  onProgress: (value: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    xhr.addEventListener("load", () => {
      const payload = parseJson(xhr.responseText) as
        | { id?: string; error?: { message?: string } }
        | null;
      if (xhr.status >= 200 && xhr.status < 300 && payload?.id) resolve(payload.id);
      else reject(new Error(payload?.error?.message ?? `YouTube upload failed (HTTP ${xhr.status}).`));
    });
    xhr.addEventListener("error", () => reject(new Error("The direct YouTube upload was interrupted.")));
    xhr.addEventListener("abort", () => reject(new Error("The direct YouTube upload was cancelled.")));
    xhr.send(file);
  });
}

async function apiRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
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

async function refreshYouTubeStatus(): Promise<void> {
  try {
    const status = await apiRequest<YouTubeConnectionStatus>("/api/oauth/youtube/status", { method: "GET" });
    setYouTubeConnection(status.connected);
  } catch {
    setYouTubeConnection(false);
    youtubeConnectionLabel.textContent = "Connection check failed";
  }
}

function setYouTubeConnection(connected: boolean): void {
  youtubeConnected = connected;
  youtubeConnectionLabel.textContent = connected ? "Connected" : "Not connected";
  youtubeConnectionLabel.classList.toggle("is-connected", connected);
  youtubeConnect.textContent = connected ? "Reconnect YouTube" : "Connect YouTube";
  youtubeDisconnect.hidden = !connected;
}

function showOAuthResult(): void {
  const url = new URL(window.location.href);
  const result = url.searchParams.get("youtube");
  if (!result) return;
  if (result === "connected") showToast("YouTube connected securely.");
  else showToast(url.searchParams.get("message") ?? "YouTube connection failed.", true);
  url.searchParams.delete("youtube");
  url.searchParams.delete("message");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function toAsset(key: string, file: File) {
  return { key, originalName: file.name, contentType: file.type, size: file.size };
}

function setR2Progress(progress: { video: number; thumbnail: number }): void {
  const totalBytes = videoFile!.size + thumbnailFile!.size;
  const uploadedBytes = videoFile!.size * progress.video + thumbnailFile!.size * progress.thumbnail;
  setProgress("Staging files directly in R2...", 6 + Math.round((uploadedBytes / totalBytes) * 40));
}

function setProgress(label: string, percent: number): void {
  uploadStatus.hidden = false;
  statusLabel.textContent = label;
  statusPercent.textContent = `${percent}%`;
  progressBar.style.width = `${percent}%`;
}

function setBusy(isBusy: boolean): void {
  saveButton.disabled = isBusy;
  form.setAttribute("aria-busy", String(isBusy));
  saveButton.querySelector("span")!.textContent = isBusy ? "Working..." : "Upload & schedule";
}

function resetForm(): void {
  form.reset();
  videoFile = null;
  thumbnailFile = null;
  videoDropzone.classList.remove("has-file");
  thumbnailDropzone.classList.remove("has-file");
  requiredElement<HTMLElement>("video-name").textContent = "Drop your MP4 here";
  requiredElement<HTMLElement>("video-meta").textContent = "or click to choose a file - up to 2 GB";
  requiredElement<HTMLElement>("thumbnail-name").textContent = "Choose a thumbnail";
  requiredElement<HTMLElement>("thumbnail-meta").textContent = "JPG or PNG - up to 10 MB";
  requiredElement<HTMLElement>("thumbnail-preview").style.backgroundImage = "";
  requiredElement<HTMLElement>("thumbnail-preview").classList.remove("has-image");
  if (thumbnailObjectUrl) URL.revokeObjectURL(thumbnailObjectUrl);
  thumbnailObjectUrl = null;
  updateCount("title-count", 0);
  updateCount("description-count", 0);
  setScheduleMinimum();
}

function setScheduleMinimum(): void {
  const minimum = new Date(Date.now() + 2 * 60 * 1000);
  const local = new Date(minimum.getTime() - minimum.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  scheduledAtInput.min = local;
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
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}`);
  return element as T;
}
