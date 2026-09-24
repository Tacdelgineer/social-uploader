import {
  INSTAGRAM_COVER_MAX_BYTES,
  THUMBNAIL_MAX_BYTES,
  type Platform,
} from "../shared/contracts";

const JPEG_QUALITY_STEPS = [0.92, 0.84, 0.76, 0.68, 0.6, 0.52] as const;
const SIZE_HEADROOM_BYTES = 64 * 1024;
const MAX_CANVAS_EDGE = 8_192;

export function thumbnailNeedsJpegConversion(file: Pick<File, "type" | "size">, platforms: Platform[]): boolean {
  if (platforms.includes("instagram")) {
    return file.type !== "image/jpeg" || file.size > INSTAGRAM_COVER_MAX_BYTES;
  }
  return platforms.includes("youtube") && file.type === "image/webp";
}

export async function prepareThumbnailForPlatforms(file: File, platforms: Platform[]): Promise<File> {
  if (!thumbnailNeedsJpegConversion(file, platforms)) return file;
  const limit = platforms.includes("instagram") ? INSTAGRAM_COVER_MAX_BYTES : THUMBNAIL_MAX_BYTES;
  return convertToJpeg(file, limit - SIZE_HEADROOM_BYTES);
}

async function convertToJpeg(file: File, targetBytes: number): Promise<File> {
  const image = await loadImage(file);
  let scale = Math.min(1, MAX_CANVAS_EDGE / Math.max(image.naturalWidth, image.naturalHeight));

  for (let resizeAttempt = 0; resizeAttempt < 8; resizeAttempt += 1) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not prepare the Instagram cover.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    for (const quality of JPEG_QUALITY_STEPS) {
      const blob = await canvasToBlob(canvas, quality);
      if (blob.size <= targetBytes) {
        const baseName = file.name.replace(/\.[^.]+$/u, "") || "cover";
        return new File([blob], `${baseName}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
      }
    }
    scale *= 0.82;
  }

  throw new Error("The cover could not be compressed below Instagram's 8 MB limit. Choose a smaller image.");
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.addEventListener("load", () => {
      URL.revokeObjectURL(url);
      resolve(image);
    }, { once: true });
    image.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      reject(new Error("The selected cover could not be decoded as an image."));
    }, { once: true });
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("This browser could not convert the cover to JPEG."));
    }, "image/jpeg", quality);
  });
}
