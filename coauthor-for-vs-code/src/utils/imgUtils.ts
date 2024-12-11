import * as fs from 'fs';
import * as path from 'path';
import { PDFDocument } from 'pdf-lib';
import { debug, error, initializeLogging } from './logUtils';
import { getWorkspacePath } from './commonUtils';

const CHANNEL = 'ImageUtils';
initializeLogging(CHANNEL);

/**
 * Get the number of pages in a PDF file using pdf-lib
 * @param pdfPath Path to the PDF file (can be relative to workspace)
 * @returns Promise<number> Number of pages in the PDF
 */
export async function countPdfPages(pdfPath: string): Promise<number> {
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      error(CHANNEL, 'No workspace path found');
      return 0;
    }

    // Convert relative path to absolute path
    const absolutePath = path.isAbsolute(pdfPath)
      ? pdfPath
      : path.join(workspacePath, pdfPath);

    // Check if file exists
    if (!fs.existsSync(absolutePath)) {
      error(CHANNEL, `PDF file not found: ${absolutePath}`);
      return 0;
    }

    // Read the PDF file using pdf-lib
    const pdfBytes = fs.readFileSync(absolutePath);
    const pdfDoc = await PDFDocument.load(pdfBytes, {
      updateMetadata: false,
      ignoreEncryption: true,
    });
    const pageCount = pdfDoc.getPageCount();

    debug(CHANNEL, `PDF page count for ${pdfPath}: ${pageCount}`);
    return pageCount;
  } catch (err) {
    error(
      CHANNEL,
      `Error counting PDF pages: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}
