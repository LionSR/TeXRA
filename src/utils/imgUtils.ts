// Standard library imports
import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

// Third-party imports
import { PDFDocument } from 'pdf-lib';
import { fromPath } from 'pdf2pic';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { getWorkspacePath, readFileBytesSync, fileExists } from './fileUtils';

const execAsync = promisify(exec);

const CHANNEL = 'ImgUtils';
logger.initialize(CHANNEL);

// Define the temporary directory path
const TEMP_DIR = path.join(os.tmpdir(), 'coauthor-pdf-conversion');

async function checkImageMagickInstalled(): Promise<boolean> {
  try {
    await execAsync('gm version');
    return true;
  } catch (err) {
    try {
      await execAsync('convert -version');
      return true;
    } catch (err2) {
      return false;
    }
  }
}

/**
 * Clean up temporary files with a given base name pattern
 * @param basePath Base directory path
 * @param tempFilePattern Pattern to match temp files
 */
async function cleanupTempFiles(
  basePath: string,
  tempFilePattern: string,
): Promise<void> {
  const files = fs.readdirSync(basePath);
  const tempFiles = files.filter((file) => file.startsWith(tempFilePattern));

  for (const file of tempFiles) {
    const fullPath = path.join(basePath, file);
    try {
      fs.unlinkSync(fullPath);
      logger.debug(CHANNEL, `Cleaned up temporary file: ${file}`);
    } catch (err) {
      logger.warn(CHANNEL, `Failed to delete temporary file ${file}: ${err}`);
    }
  }
}

/**
 * Convert an image file to a base64 encoded string
 * @param imagePath Path to the image file (relative to workspace)
 * @returns Promise<string> Base64 encoded string of the image
 */
export async function getBase64EncodedImage(
  imagePath: string,
): Promise<string> {
  try {
    // Check if file exists
    if (!(await fileExists(imagePath))) {
      logger.error(CHANNEL, `Image file not found: ${imagePath}`);
      throw new Error(`Image file not found: ${imagePath}`);
    }

    // Read the image file as bytes
    const imageBytes = readFileBytesSync(imagePath);

    // Convert to base64
    const base64String = imageBytes.toString('base64');

    logger.debug(CHANNEL, `Successfully encoded image: ${imagePath}`);
    return base64String;
  } catch (err) {
    logger.error(
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
      logger.error(CHANNEL, 'No workspace path found');
      return 1;
    }

    // Check if file exists
    if (!(await fileExists(pdfPath))) {
      logger.error(CHANNEL, `PDF file not found: ${pdfPath}`);
      return 0;
    }

    // Read the PDF file using pdf-lib
    const pdfBytes = readFileBytesSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes, {
      updateMetadata: false,
      ignoreEncryption: true,
    });
    const pageCount = pdfDoc.getPageCount();

    logger.debug(CHANNEL, `PDF page count for ${pdfPath}: ${pageCount}`);
    return pageCount;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error counting PDF pages: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

/**
 * Convert a single page of a PDF to a PNG image
 * @param pdfPath Path to the PDF file (relative to workspace)
 * @param pageNum Page number to convert (1-indexed)
 * @param quality Quality of the output PNG image (default: 300)
 * @param maxSize Maximum size of the output image (default: [1024, 1024])
 * @returns Promise<string> Base64 encoded PNG image
 */
export async function singlePagePdf2Png(
  pdfPath: string,
  pageNum: number = 1,
  quality: number = 300,
  maxSize: [number, number] = [1024, 1024],
): Promise<string> {
  const tempFilePattern = `temp_${Date.now()}`;
  let tempFilePath: string | undefined;

  try {
    logger.debug(
      CHANNEL,
      `Starting singlePagePdf2Png for ${pdfPath}, page ${pageNum}`,
    );

    // Check for GraphicsMagick/ImageMagick installation
    const isImageMagickInstalled = await checkImageMagickInstalled();
    if (!isImageMagickInstalled) {
      throw new Error(
        'GraphicsMagick/ImageMagick is not installed. Please install GraphicsMagick or ImageMagick to use PDF to PNG conversion.\n' +
          'Installation instructions:\n' +
          '- Mac: brew install graphicsmagick\n' +
          '- Ubuntu: sudo apt-get install graphicsmagick\n' +
          '- Windows: Download from http://www.graphicsmagick.org/download.html',
      );
    }

    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    // Verify file exists
    if (!(await fileExists(pdfPath))) {
      throw new Error(`PDF file not found: ${pdfPath}`);
    }

    const fullPath = path.join(workspacePath, pdfPath);
    logger.debug(CHANNEL, `Full path to PDF: ${fullPath}`);

    // Ensure the temporary directory exists
    if (!fs.existsSync(TEMP_DIR)) {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
    }

    const options = {
      density: quality,
      width: maxSize[0],
      height: maxSize[1],
      preserveAspectRatio: true,
      format: 'png',
      saveFilename: path.parse(tempFilePattern).name,
      savePath: TEMP_DIR,
    };
    logger.debug(CHANNEL, `pdf2pic options: ${JSON.stringify(options)}`);

    const convert = fromPath(fullPath, options);
    logger.debug(CHANNEL, `pdf2pic convert object created`);

    const result = await convert(pageNum);
    logger.debug(CHANNEL, `pdf2pic convert result: ${JSON.stringify(result)}`);

    // Update tempFilePath to match pdf2pic's naming convention
    if (!result || !result.path) {
      throw new Error('PDF conversion failed: No output path returned');
    }
    tempFilePath = result.path;

    if (!fs.existsSync(tempFilePath)) {
      throw new Error(
        'Failed to convert PDF page to PNG: Output file not found',
      );
    }

    // Read the generated PNG file and convert to base64
    const imageBuffer = fs.readFileSync(tempFilePath);
    const base64String = imageBuffer.toString('base64');

    logger.debug(
      CHANNEL,
      `Successfully converted page ${pageNum} of ${pdfPath} to PNG`,
    );
    return base64String;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error converting PDF page to PNG: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  } finally {
    // Always clean up all temporary files in the temporary directory
    logger.debug(CHANNEL, `Cleaning up temporary files in ${TEMP_DIR}`);
    await cleanupTempFiles(TEMP_DIR, 'temp_');
  }
}

/**
 * Convert multiple pages of a PDF to PNG images
 * @param pdfPath Path to the PDF file (relative to workspace)
 * @param quality Quality of the output PNG images (default: 300)
 * @param maxSize Maximum size of the output images (default: [1024, 1024])
 * @param maxPages Maximum number of pages to convert (default: 100)
 * @returns Promise<string[]> Array of base64 encoded PNG images
 */
export async function multiPagePdf2Png(
  pdfPath: string,
  quality: number = 300,
  maxSize: [number, number] = [1024, 1024],
  maxPages: number = 100,
): Promise<string[]> {
  try {
    const pageCount = await countPdfPages(pdfPath);
    const pagesToConvert = Math.min(pageCount, maxPages);

    const base64Images: string[] = [];
    for (let pageNum = 1; pageNum <= pagesToConvert; pageNum++) {
      const base64Image = await singlePagePdf2Png(
        pdfPath,
        pageNum,
        quality,
        maxSize,
      );
      base64Images.push(base64Image);
    }

    logger.debug(
      CHANNEL,
      `Successfully converted ${base64Images.length} pages from ${pdfPath}`,
    );
    return base64Images;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error converting multiple PDF pages: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Process a PDF file and return base64 encoded PNG image(s)
 * @param pdfPath Path to the PDF file (relative to workspace)
 * @param maxPages Maximum number of pages to convert
 * @param quality Quality of the output PNG images
 * @param maxSize Maximum size of the output images
 * @returns Promise<string | string[] | null> Base64 encoded PNG image(s) or null if error
 */
export async function processPdfInput(
  pdfPath: string,
  maxPages?: number,
  quality?: number,
  maxSize?: [number, number],
): Promise<string | string[] | null> {
  try {
    // Verify file exists
    if (!(await fileExists(pdfPath))) {
      logger.debug(CHANNEL, `PDF file not found: ${pdfPath}`);
      return null;
    }

    const pageCount = await countPdfPages(pdfPath);
    if (pageCount === 0) {
      return null;
    }

    // Use default values if not provided
    const finalQuality = quality || 300;
    const finalMaxSize: [number, number] = maxSize || [1024, 1024];

    if (pageCount === 1) {
      return await singlePagePdf2Png(pdfPath, 1, finalQuality, finalMaxSize);
    } else {
      return await multiPagePdf2Png(
        pdfPath,
        finalQuality,
        finalMaxSize,
        maxPages,
      );
    }
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error processing PDF input: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
