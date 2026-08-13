// Third-party imports
import { PDFDocument } from '@cantoo/pdf-lib';

/**
 * Count the pages of an in-memory PDF.
 *
 * Throws when the bytes cannot be parsed as a PDF, so each caller states its
 * own failure policy instead of inheriting a silent zero.
 */
export async function countPdfPagesInBuffer(
  bytes: Uint8Array,
): Promise<number> {
  const pdfDoc = await PDFDocument.load(bytes, {
    updateMetadata: false,
    ignoreEncryption: true,
  });
  return pdfDoc.getPageCount();
}
