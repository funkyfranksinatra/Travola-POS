"use client";
// lib/menu-file.ts — turning a manager's file into pages the extractor
// can read, choosing the CHEAPER and more accurate path per file.
//
// A PDF exported from a design tool carries a real text layer: the
// characters are already there, exactly as typeset. Sending that text
// costs a fraction of the tokens of an image and cannot introduce OCR
// errors — a "$18" never becomes "$1B". So: try the text layer first,
// and fall back to rasterising only when there isn't one (a scanned
// menu, a photo taken on a phone).
//
// The check is per-page, not per-file: restaurants routinely have a
// digital food menu with a scanned wine insert.
// pdfjs is imported LAZILY, inside the browser-only code path. A
// top-level import drags it into the server bundle, where prerendering
// /menu dies on `DOMMatrix is not defined` — the library needs browser
// globals it cannot have during SSR. Type-only imports are erased and
// stay safe at the top.
import type { PDFPageProxy } from "pdfjs-dist";

type PdfJs = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfJs> | null = null;

async function loadPdfjs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((mod) => {
      // pdfjs needs its worker; bundling it from the package keeps this
      // working offline and avoids a CDN the CSP would block anyway.
      if (!mod.GlobalWorkerOptions.workerSrc) {
        mod.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url
        ).toString();
      }
      return mod;
    });
  }
  return pdfjsPromise;
}

export type MenuPage = { text?: string; image?: string };
export type ReadResult = { pages: MenuPage[]; kind: "text" | "vision" | "mixed" };

export const MAX_PAGES = 12;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Below this many characters a "text layer" is page furniture (a
 *  header, a page number) rather than a menu, so the page is rasterised
 *  instead. Tuned so a sparse cocktail list still counts as text. */
const MIN_TEXT_CHARS = 120;
/** Rasterisation width. Large enough for small print on a wine list,
 *  small enough to stay well inside request limits. */
const RASTER_WIDTH = 1600;

async function rasterize(page: PDFPageProxy): Promise<string> {
  const initial = page.getViewport({ scale: 1 });
  const scale = Math.min(3, RASTER_WIDTH / initial.width);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas unavailable");
  // White ground: a transparent PDF page rasterises to black-on-black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.82);
}

async function readImageFile(file: File): Promise<string> {
  // Photos off a phone are far larger than the extractor needs; scaling
  // down keeps the request inside limits without losing small print.
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, RASTER_WIDTH / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas unavailable");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.82);
}

export function isSupported(file: File) {
  const name = file.name.toLowerCase();
  return (
    file.type === "application/pdf" ||
    file.type.startsWith("image/") ||
    /\.(pdf|png|jpe?g|webp|heic|heif|gif|bmp|tiff?)$/.test(name)
  );
}

/** Read one or more files into extractor pages. `onProgress` reports
 *  human-meaningful steps, because rasterising a 12-page wine list on a
 *  tablet takes long enough that silence reads as a hang. */
export async function readMenuFiles(
  files: File[],
  onProgress?: (message: string) => void
): Promise<ReadResult> {
  const pages: MenuPage[] = [];
  let textPages = 0;
  let visionPages = 0;

  for (const file of files) {
    if (!isSupported(file)) throw new Error(`${file.name}: unsupported file type`);
    if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is too large (max 20MB)`);

    const isPdf =
      file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

    if (!isPdf) {
      onProgress?.(`Reading ${file.name}…`);
      pages.push({ image: await readImageFile(file) });
      visionPages += 1;
      if (pages.length >= MAX_PAGES) break;
      continue;
    }

    const pdfjs = await loadPdfjs();
    const data = new Uint8Array(await file.arrayBuffer());
    // Keep the loading task: destroying THAT is what frees the worker.
    const task = pdfjs.getDocument({ data });
    const pdf = await task.promise;
    const count = Math.min(pdf.numPages, MAX_PAGES - pages.length);

    for (let n = 1; n <= count; n += 1) {
      onProgress?.(`Reading page ${n} of ${count}…`);
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (text.length >= MIN_TEXT_CHARS) {
        pages.push({ text });
        textPages += 1;
      } else {
        // No usable text layer — a scan. Rasterise for vision.
        onProgress?.(`Page ${n} is a scan — preparing image…`);
        pages.push({ image: await rasterize(page) });
        visionPages += 1;
      }
      page.cleanup();
    }
    await pdf.cleanup();
    await task.destroy();
    if (pages.length >= MAX_PAGES) break;
  }

  if (!pages.length) throw new Error("nothing readable in that file");
  return {
    pages,
    kind: textPages && visionPages ? "mixed" : visionPages ? "vision" : "text",
  };
}
