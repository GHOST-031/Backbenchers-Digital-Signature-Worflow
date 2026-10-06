import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 50;
export interface PdfInfo {
  pageCount: number;
  byteLength: number;
}
export interface PdfPageDimensions {
  width: number;
  height: number;
}
export interface PdfSigningProvider {
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}
export class LocalDemoPdfSigningProvider implements PdfSigningProvider {
  async sign(bytes: Uint8Array): Promise<Uint8Array> {
    const pdf = await PDFDocument.load(bytes);
    pdf.setSubject(
      "Locally sealed OD workflow document; no PDF certificate signature",
    );
    pdf.setKeywords(["od-workflow-local-seal", "manifest-verified"]);
    return pdf.save();
  }
}
/** Test adapter for callers that explicitly require a no-sealing failure. */
export class PendingPdfSigningProvider implements PdfSigningProvider {
  async sign(bytes: Uint8Array): Promise<Uint8Array> {
    void bytes;
    throw new Error(
      "no signature was applied: certificate-backed PDF signing is not configured",
    );
  }
}
export const pdfSigningProvider: PdfSigningProvider =
  new LocalDemoPdfSigningProvider();
export interface PdfSignaturePlacement {
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  method: "TYPED" | "DRAWN";
  value: string | null;
  image: Uint8Array | null;
}
export interface PdfService {
  validate(bytes: Uint8Array): Promise<PdfInfo>;
  pageDimensions(
    bytes: Uint8Array,
    pageNumber: number,
  ): Promise<PdfPageDimensions>;
  prepareForRendering(bytes: Uint8Array): Promise<Uint8Array>;
  renderSignatures(
    bytes: Uint8Array,
    placements: PdfSignaturePlacement[],
  ): Promise<Uint8Array>;
  seal(_bytes: Uint8Array): Promise<Uint8Array>;
}
export class LocalPdfService implements PdfService {
  constructor(
    private readonly signingProvider: PdfSigningProvider = pdfSigningProvider,
  ) {}
  async validate(bytes: Uint8Array): Promise<PdfInfo> {
    if (bytes.byteLength > MAX_PDF_BYTES)
      throw new Error("PDF exceeds the 10 MB limit");
    if (
      bytes.byteLength < 8 ||
      new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-"
    )
      throw new Error("File is not a PDF");
    try {
      const task = getDocument({
        data: new Uint8Array(bytes),
        useSystemFonts: true,
      });
      const document = await task.promise;
      const pageCount = document.numPages;
      await task.destroy();
      if (pageCount > MAX_PDF_PAGES)
        throw new Error("PDF exceeds the 50-page limit");
      if (pageCount < 1) throw new Error("PDF contains no pages");
      return { pageCount, byteLength: bytes.byteLength };
    } catch (error) {
      if (
        error instanceof Error &&
        /limit|contains no pages/.test(error.message)
      )
        throw error;
      throw new Error("PDF is invalid or cannot be parsed", { cause: error });
    }
  }
  async pageDimensions(
    bytes: Uint8Array,
    pageNumber: number,
  ): Promise<PdfPageDimensions> {
    const { pageCount } = await this.validate(bytes);
    if (
      !Number.isInteger(pageNumber) ||
      pageNumber < 1 ||
      pageNumber > pageCount
    )
      throw new Error("Page number is outside the PDF");
    const task = getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
    });
    try {
      const page = await task.promise.then((document) =>
        document.getPage(pageNumber),
      );
      const { width, height } = page.getViewport({ scale: 1 });
      return { width, height };
    } finally {
      await task.destroy();
    }
  }
  async prepareForRendering(bytes: Uint8Array): Promise<Uint8Array> {
    await this.validate(bytes);
    return new Uint8Array(bytes);
  }
  async renderSignatures(
    bytes: Uint8Array,
    placements: PdfSignaturePlacement[],
  ): Promise<Uint8Array> {
    const pdf = await PDFDocument.load(bytes);
    const pages = pdf.getPages();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const field of placements) {
      const page = pages[field.pageNumber - 1];
      if (!page) throw new Error("Signature field page is outside the PDF");
      const { width, height } = page.getSize();
      const x = field.x * width;
      const y = height - (field.y + field.height) * height;
      const boxWidth = field.width * width;
      const boxHeight = field.height * height;
      if (field.method === "DRAWN") {
        if (!field.image) throw new Error("Drawn signature image is missing");
        const image = await pdf.embedPng(field.image);
        const scale = Math.min(
          boxWidth / image.width,
          boxHeight / image.height,
        );
        const drawnWidth = image.width * scale;
        const drawnHeight = image.height * scale;
        page.drawImage(image, {
          x: x + (boxWidth - drawnWidth) / 2,
          y: y + (boxHeight - drawnHeight) / 2,
          width: drawnWidth,
          height: drawnHeight,
        });
      } else {
        if (!field.value?.trim()) throw new Error("Typed signature is missing");
        const size = Math.max(8, Math.min(24, boxHeight * 0.62));
        const textWidth = font.widthOfTextAtSize(field.value, size);
        const scale = Math.min(1, (boxWidth * 0.94) / Math.max(textWidth, 1));
        page.drawText(field.value, {
          x: x + boxWidth * 0.03,
          y: y + (boxHeight - size) / 2,
          size: size * scale,
          font,
          color: rgb(0.08, 0.12, 0.32),
          maxWidth: boxWidth * 0.94,
        });
      }
    }
    return pdf.save();
  }
  async seal(bytes: Uint8Array): Promise<Uint8Array> {
    return this.signingProvider.sign(bytes);
  }
}
export const pdfService: PdfService = new LocalPdfService();
