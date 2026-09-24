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
  type StoredJob,
  type SystemStatusResponse,
  type YouTubeConnectionStatus,
} from "../shared/contracts";

type UploadState = "uploading" | "processing" | "scheduled" | "failed" | "cancelled";

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

let videoFile: File | null = null;
let thumbnailFile: File | null = null;
let thumbnailObjectUrl: string | null = null;
let youtubeConnected = false;
let toastTimer: number | undefined;
let currentPercent = 0;
let activeJobId: string | null = null;
let cancelRequested = false;
const activeXhrs = new Set<XMLHttpRequest>();

setupDropzone(videoDropzone, videoInput, setVideo);
setupDropzone(thumbnailDropzone, thumbnailInput, setThumbnail);
setupViewNavigation();
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

cancelButton.addEventListener("click", () => {
  cancelRequested = true;
  for (const xhr of activeXhrs) xhr.abort();
  setProgress("cancelled", "Upload cancelled", currentPercent);
  if (activeJobId) void reportJobState(activeJobId, "cancelled", "Upload cancelled by user.");
});

requiredElement<HTMLButtonElement>("status-refresh").addEventListener("click", () => {
  void refreshSystemStatus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!validateForm()) return;

  setBusy(true);
  cancelRequested = false;
  activeJobId = null;
  currentPercent = 0;
  uploadResult.hidden = true;
  const jobId = crypto.randomUUID();

  try {
    setProgress("uploading", "Reserving capped temporary storage...", 3);
    const reservation = await requestPresign(jobId, videoFile!, thumbnailFile!);
    throwIfCancelled();
    const { video: videoUpload, thumbnail: thumbnailUpload } = reservation.uploads;

    setProgress("uploading", "Staging files directly in R2...", 6);
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
    throwIfCancelled();

    setProgress("uploading", "Creating YouTube upload session...", 48);
    const job = buildJob(jobId, videoUpload.objectKey, thumbnailUpload.objectKey);
    const created = await apiRequest<CreateJobResponse>("/api/jobs", {
      method: "POST",
      body: JSON.stringify(job),
    });
    activeJobId = created.id;
    throwIfCancelled();

    setProgress("uploading", "Uploading video directly to YouTube...", 52);
    const videoId = await uploadDirectToYouTube(
      created.youtube.uploadUrl,
      created.youtube.accessToken,
      videoFile!,
      (value) => setProgress("uploading", "Uploading video directly to YouTube...", 52 + Math.round(value * 39)),
    );
    throwIfCancelled();

    setProgress("processing", "YouTube received the video; verifying its schedule...", 94);
    const completed = await apiRequest<CompleteYouTubeResponse>(
      `/api/jobs/${encodeURIComponent(jobId)}/youtube/complete`,
      { method: "POST", body: JSON.stringify({ videoId }) },
    );
    showScheduledResult(completed);
  } catch (error) {
    const recovered = activeJobId ? await recoverScheduledJob(activeJobId) : null;
    if (recovered) {
      showScheduledResult(recovered);
    } else {
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
    }
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
    });
  });
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

async function requestPresign(jobId: string, video: File, thumbnail: File): Promise<PresignResponse> {
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

async function recoverScheduledJob(jobId: string): Promise<CompleteYouTubeResponse | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await delay(700);
    try {
      const job = await apiRequest<StoredJob>(`/api/jobs/${encodeURIComponent(jobId)}`);
      if ((job.status === "scheduled" || job.status === "scheduled_on_youtube") && job.youtubeResult) {
        return {
          id: job.id,
          status: "scheduled",
          videoId: job.youtubeResult.videoId,
          publishAt: job.youtubeResult.publishAt,
          mediaDeleted: job.youtubeResult.mediaDeleted ?? job.status === "scheduled_on_youtube",
          thumbnailApplied: job.youtubeResult.thumbnailApplied,
          warnings: job.youtubeResult.warnings ?? [],
        };
      }
      if (job.status === "failed" || job.status === "cancelled") return null;
    } catch {
      // A lost completion response may briefly race KV visibility; retry a few times.
    }
  }
  return null;
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

function showScheduledResult(completed: CompleteYouTubeResponse): void {
  setProgress(
    "scheduled",
    completed.mediaDeleted
      ? "Scheduled successfully; temporary media deleted"
      : "Scheduled successfully; R2 cleanup needs attention",
    100,
  );
  requiredElement<HTMLElement>("result-video-id").textContent = completed.videoId;
  requiredElement<HTMLElement>("result-scheduled-at").textContent = formatDate(completed.publishAt);
  requiredElement<HTMLElement>("result-cleanup").textContent = completed.mediaDeleted
    ? "Temporary video and thumbnail deleted"
    : "Temporary media retained; 7-day cleanup fallback remains active";
  const warningElement = requiredElement<HTMLElement>("result-warnings");
  warningElement.textContent = completed.warnings.join(" ");
  warningElement.hidden = completed.warnings.length === 0;
  uploadResult.hidden = false;
  showToast(
    completed.warnings.length
      ? `YouTube scheduled ${completed.videoId} with ${completed.warnings.length} warning(s).`
      : `YouTube scheduled ${completed.videoId} for ${formatDate(completed.publishAt)}.`,
  );
  resetForm();
}

async function refreshYouTubeStatus(): Promise<void> {
  try {
    const status = await apiRequest<YouTubeConnectionStatus>("/api/oauth/youtube/status");
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
  renderJobs(status);
  renderEvents("errors-list", status.recentErrors, "No recent errors.");
  renderEvents("events-list", status.events, "No app events yet.");
}

function renderConnection(id: string, connected: boolean): void {
  const element = requiredElement<HTMLElement>(id);
  element.textContent = connected ? "Connected" : "Not connected";
  element.classList.toggle("is-connected", connected);
}

function renderJobs(status: SystemStatusResponse): void {
  const body = requiredElement<HTMLTableSectionElement>("jobs-table-body");
  body.replaceChildren();
  if (status.jobs.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "empty-cell";
    cell.textContent = "No upload jobs yet.";
    row.append(cell);
    body.append(row);
    return;
  }
  for (const job of status.jobs) {
    const row = document.createElement("tr");
    const platform = document.createElement("td");
    platform.textContent = capitalize(job.platform);
    const state = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `job-state state-${job.status}`;
    badge.textContent = capitalize(job.status);
    if (job.lastError) badge.title = job.lastError;
    state.append(badge);
    appendCells(
      row,
      platform,
      state,
      formatBytes(job.fileSizeBytes),
      formatDate(job.createdAt),
      job.scheduledAt ? formatDate(job.scheduledAt) : "—",
      job.temporaryMediaDeleted ? "Deleted" : "Retained",
    );
    body.append(row);
  }
}

function appendCells(row: HTMLTableRowElement, ...values: Array<string | HTMLTableCellElement>): void {
  for (const value of values) {
    if (value instanceof HTMLTableCellElement) row.append(value);
    else {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
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
  setProgress("uploading", "Staging files directly in R2...", 6 + Math.round((uploadedBytes / totalBytes) * 40));
}

function setProgress(state: UploadState, label: string, percent: number): void {
  currentPercent = Math.max(currentPercent, percent);
  if (state === "failed" || state === "cancelled") currentPercent = percent;
  uploadStatus.hidden = false;
  statusState.textContent = capitalize(state);
  statusState.className = `state-badge state-${state}`;
  statusLabel.textContent = label;
  statusPercent.textContent = `${currentPercent}%`;
  progressBar.style.width = `${currentPercent}%`;
  uploadStatus.dataset.state = state;
  cancelButton.hidden = !["uploading"].includes(state);
  cancelButton.disabled = state !== "uploading";
}

function setBusy(isBusy: boolean): void {
  saveButton.disabled = isBusy;
  form.setAttribute("aria-busy", String(isBusy));
  saveButton.querySelector("span")!.textContent = isBusy ? "Working..." : "Upload & schedule";
  if (!isBusy) cancelButton.hidden = true;
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
