import { PDFDocument } from 'pdf-lib';
import { debug, error, initializeLogging } from './logUtils';
import { getWorkspacePath, readFileBytesSync, fileExists } from './fileUtils';

const CHANNEL = 'ImageUtils';
initializeLogging(CHANNEL);

/**
 * Convert an image file to a base64 encoded string
 * @param imagePath Path to the image file (relative to workspace)
 * @returns Promise<string> Base64 encoded string of the image
 */
export async function getBase64EncodedImage(imagePath: string): Promise<string> {
  try {
    // Check if file exists
    if (!(await fileExists(imagePath))) {
      error(CHANNEL, `Image file not found: ${imagePath}`);
      throw new Error(`Image file not found: ${imagePath}`);
    }

    // Read the image file as bytes
    const imageBytes = readFileBytesSync(imagePath);
    
    // Convert to base64
    const base64String = imageBytes.toString('base64');
    
    debug(CHANNEL, `Successfully encoded image: ${imagePath}`);
    return base64String;
  } catch (err) {
    error(
      CHANNEL,
      `Error encoding image to base64: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

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

    // Check if file exists
    if (!(await fileExists(pdfPath))) {
      error(CHANNEL, `PDF file not found: ${pdfPath}`);
      return 0;
    }

    // Read the PDF file using pdf-lib
    const pdfBytes = readFileBytesSync(pdfPath);
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
