import "./styles.css";
import {
  THUMBNAIL_CONTENT_TYPES,
  THUMBNAIL_MAX_BYTES,
  VIDEO_CONTENT_TYPES,
  VIDEO_MAX_BYTES,
  type ApiError,
  type AssetKind,
  type DraftRequest,
  type PresignRequest,
  type PresignResponse,
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

let videoFile: File | null = null;
let thumbnailFile: File | null = null;
let thumbnailObjectUrl: string | null = null;
let toastTimer: number | undefined;

setupDropzone(videoDropzone, videoInput, (file) => setVideo(file));
setupDropzone(thumbnailDropzone, thumbnailInput, (file) => setThumbnail(file));

titleInput.addEventListener("input", () => updateCount("title-count", titleInput.value.length));
descriptionInput.addEventListener("input", () =>
  updateCount("description-count", descriptionInput.value.length),
);

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
requiredElement<HTMLElement>("timezone-label").textContent = `Saved in ${timezone}`;

document.querySelectorAll<HTMLButtonElement>(".connect-button").forEach((button) => {
  button.addEventListener("click", () => {
    showToast(`${button.dataset.platform ?? "Platform"} OAuth is planned for Milestone 2.`);
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
    setProgress("Preparing secure uploads…", 4);
    const [videoUpload, thumbnailUpload] = await Promise.all([
      requestPresign(jobId, "video", videoFile!),
      requestPresign(jobId, "thumbnail", thumbnailFile!),
    ]);

    setProgress("Uploading files directly to R2…", 8);
    const progress = { video: 0, thumbnail: 0 };
    await Promise.all([
      uploadDirect(videoUpload.uploadUrl, videoFile!, (value) => {
        progress.video = value;
        setCombinedProgress(progress);
      }),
      uploadDirect(thumbnailUpload.uploadUrl, thumbnailFile!, (value) => {
        progress.thumbnail = value;
        setCombinedProgress(progress);
      }),
    ]);

    setProgress("Saving draft metadata…", 94);
    const draft: DraftRequest = {
      id: jobId,
      title: titleInput.value.trim(),
      description: descriptionInput.value,
      scheduledAt: scheduledAtInput.value ? new Date(scheduledAtInput.value).toISOString() : null,
      timezone,
      platforms: {
        youtube: requiredElement<HTMLInputElement>("youtube-enabled").checked,
        instagram: requiredElement<HTMLInputElement>("instagram-enabled").checked,
        tiktok: requiredElement<HTMLInputElement>("tiktok-enabled").checked,
      },
      assets: {
        video: toAsset(videoUpload.objectKey, videoFile!),
        thumbnail: toAsset(thumbnailUpload.objectKey, thumbnailFile!),
      },
    };

    await apiRequest("/api/drafts", { method: "POST", body: JSON.stringify(draft) });
    setProgress("Draft saved", 100);
    showToast(`Draft ${jobId.slice(0, 8)} saved successfully.`);
    resetForm();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    showToast(message, true);
    setProgress("Upload failed", 0);
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
  requiredElement<HTMLElement>("video-meta").textContent = `${formatBytes(file.size)} · MP4 ready`;
  videoDropzone.classList.add("has-file");
}

function setThumbnail(file: File): void {
  if (!(THUMBNAIL_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    showToast("Choose a JPG, PNG, or WebP thumbnail.", true);
    return;
  }
  if (file.size <= 0 || file.size > THUMBNAIL_MAX_BYTES) {
    showToast("The thumbnail must be between 1 byte and 10 MB.", true);
    return;
  }
  thumbnailFile = file;
  requiredElement<HTMLElement>("thumbnail-name").textContent = file.name;
  requiredElement<HTMLElement>("thumbnail-meta").textContent = `${formatBytes(file.size)} · ready`;
  thumbnailDropzone.classList.add("has-file");
  if (thumbnailObjectUrl) URL.revokeObjectURL(thumbnailObjectUrl);
  thumbnailObjectUrl = URL.createObjectURL(file);
  requiredElement<HTMLElement>("thumbnail-preview").style.backgroundImage = `url("${thumbnailObjectUrl}")`;
  requiredElement<HTMLElement>("thumbnail-preview").classList.add("has-image");
}

function validateForm(): boolean {
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
  const anyPlatform = ["youtube-enabled", "instagram-enabled", "tiktok-enabled"].some(
    (id) => requiredElement<HTMLInputElement>(id).checked,
  );
  if (!anyPlatform) {
    showToast("Choose at least one destination.", true);
    return false;
  }
  return true;
}

async function requestPresign(jobId: string, kind: AssetKind, file: File): Promise<PresignResponse> {
  const payload: PresignRequest = {
    jobId,
    kind,
    fileName: file.name,
    contentType: file.type,
    size: file.size,
  };
  return apiRequest<PresignResponse>("/api/uploads/presign", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

function uploadDirect(url: string, file: File, onProgress: (value: number) => void): Promise<void> {
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
    xhr.addEventListener("error", () => reject(new Error(`Could not upload ${file.name}.`)));
    xhr.addEventListener("abort", () => reject(new Error(`Upload cancelled for ${file.name}.`)));
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

function toAsset(key: string, file: File) {
  return { key, originalName: file.name, contentType: file.type, size: file.size };
}

function setCombinedProgress(progress: { video: number; thumbnail: number }): void {
  const totalBytes = videoFile!.size + thumbnailFile!.size;
  const uploadedBytes = videoFile!.size * progress.video + thumbnailFile!.size * progress.thumbnail;
  setProgress("Uploading files directly to R2…", 8 + Math.round((uploadedBytes / totalBytes) * 84));
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
  saveButton.querySelector("span")!.textContent = isBusy ? "Uploading…" : "Upload & save draft";
}

function resetForm(): void {
  form.reset();
  videoFile = null;
  thumbnailFile = null;
  videoDropzone.classList.remove("has-file");
  thumbnailDropzone.classList.remove("has-file");
  requiredElement<HTMLElement>("video-name").textContent = "Drop your MP4 here";
  requiredElement<HTMLElement>("video-meta").textContent = "or click to choose a file · up to 2 GB";
  requiredElement<HTMLElement>("thumbnail-name").textContent = "Choose a thumbnail";
  requiredElement<HTMLElement>("thumbnail-meta").textContent = "JPG, PNG, or WebP · up to 10 MB";
  requiredElement<HTMLElement>("thumbnail-preview").style.backgroundImage = "";
  requiredElement<HTMLElement>("thumbnail-preview").classList.remove("has-image");
  if (thumbnailObjectUrl) URL.revokeObjectURL(thumbnailObjectUrl);
  thumbnailObjectUrl = null;
  updateCount("title-count", 0);
  updateCount("description-count", 0);
}

function showToast(message: string, isError = false): void {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 5000);
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
