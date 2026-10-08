// Image fetching, encoding, and Anki media helpers.

export interface FetchedImage {
  mime: string;
  dataBase64: string;
  bytes: number;
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/x-icon": "ico",
};

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  tiff: "image/tiff",
  ico: "image/x-icon",
};

export function extensionForMime(mime: string): string {
  const clean = (mime || "").split(";")[0].trim().toLowerCase();
  return MIME_EXTENSIONS[clean] ?? "png";
}

export function guessMimeFromUrl(url: string): string {
  try {
    const path = url.split("?")[0].split("#")[0];
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    return EXT_MIME[ext] ?? "image/png";
  } catch {
    return "image/png";
  }
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function dataUrlToRef(dataUrl: string): { mime: string; dataBase64: string } | null {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const mime = match[1] || "image/png";
  if (match[2]) return { mime, dataBase64: match[3] };
  const decoded = decodeURIComponent(match[3]);
  const bytes = new TextEncoder().encode(decoded);
  return { mime, dataBase64: arrayBufferToBase64(bytes.buffer as ArrayBuffer) };
}

/** Fetch image bytes in the extension background (host permissions bypass CORS). */
export async function fetchImageBytes(url: string, timeoutMs = 20_000): Promise<FetchedImage> {
  if (url.startsWith("data:")) {
    const ref = dataUrlToRef(url);
    if (!ref) throw new Error("Unsupported data URL");
    return { mime: ref.mime, dataBase64: ref.dataBase64, bytes: base64ToBytes(ref.dataBase64).length };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const headerMime = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    const mime = headerMime.startsWith("image/") ? headerMime : guessMimeFromUrl(url);
    return { mime, dataBase64: arrayBufferToBase64(buffer), bytes: buffer.byteLength };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Timed out fetching the image");
    }
    throw new Error(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function mediaFilename(dataBase64: string, mime: string): Promise<string> {
  const hash = await sha256Hex(dataBase64);
  return `acc-img-${hash.slice(0, 20)}.${extensionForMime(mime)}`;
}

/** Best-effort downscale/re-encode using an offscreen canvas, when available. */
export async function downscaleImage(
  dataBase64: string,
  mime: string,
  maxDimension: number,
): Promise<{ dataBase64: string; mime: string } | null> {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") return null;
  try {
    const blob = new Blob([base64ToBytes(dataBase64)], { type: mime });
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) return null;
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const outType = mime === "image/png" ? "image/png" : "image/jpeg";
    const outBlob = await canvas.convertToBlob({ type: outType, quality: 0.85 });
    const buffer = await outBlob.arrayBuffer();
    return { dataBase64: arrayBufferToBase64(buffer), mime: outType };
  } catch {
    return null;
  }
}
