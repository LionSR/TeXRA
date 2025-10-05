// Standard library imports
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

// Third-party imports
import { PDFDocument } from '@cantoo/pdf-lib';
import { fromPath } from 'pdf2pic';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { getConfig } from '@utils/config';
import { AbsoluteFS, getMimeType, resolveFilePath } from '@utils/files';
import { checkMultipleToolsInstalled } from '@utils/system';
import { executeCommand } from '@utils/system/execUtils';

const CHANNEL = 'ImgUtils';
logger.initialize(CHANNEL);

/**
 * Get the maximum image dimension from VS Code configuration
 * @returns Maximum image dimension (defaults to 2000)
 */
function getMaxImageDimension(): number {
  return getConfig<number>('maxImageDimension', 2000);
}

// Define the temporary directory path
const TEMP_DIR = path.join(os.tmpdir(), 'texra-pdf-conversion');

// ImageMagick configuration is now in toolUtils.ts

/** Ensure the pdf2pic temporary directory exists. */
function ensureTempDir(): void {
  if (!AbsoluteFS.existsSync(TEMP_DIR)) {
    AbsoluteFS.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

/** Resolve a file path and ensure it exists. */
async function resolveExistingFile(
  filePath: string,
): Promise<{ absolutePath: string; exists: boolean }> {
  const absolutePath = resolveFilePath(filePath);
  const exists = await AbsoluteFS.exists(absolutePath);

  if (!exists) {
    throw new Error(`File not found: ${filePath}`);
  }

  return { absolutePath, exists };
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
  const files = AbsoluteFS.readDirSync(basePath);
  const tempFiles = files.filter((file) => file.startsWith(tempFilePattern));

  for (const file of tempFiles) {
    const fullPath = path.join(basePath, file);
    try {
      AbsoluteFS.deleteSync(fullPath);
      logger.debug(CHANNEL, `Cleaned up temporary file: ${file}`);
    } catch (err) {
      logger.warn(CHANNEL, `Failed to delete temporary file ${file}: ${err}`);
    }
  }
}

/**
 * Select the appropriate image processing tool
 * @returns Tool name ('magick' or 'gm') and command prefix
 */
async function selectImageTool(): Promise<{ tool: string; prefix: string[] }> {
  const [hasMagick, hasGm] = await checkMultipleToolsInstalled(
    ['magick', 'gm'],
    false,
  );
  if (hasMagick) {
    return { tool: 'magick', prefix: ['magick'] };
  } else if (hasGm) {
    return { tool: 'gm', prefix: ['gm'] };
  } else {
    throw new Error('Neither ImageMagick nor GraphicsMagick is installed');
  }
}

/**
 * Get the dimensions of an image file
 * @param imagePath Path to the image file
 * @returns Promise resolving to width and height
 */
async function getImageDimensions(
  imagePath: string,
): Promise<{ width: number; height: number }> {
  const { prefix } = await selectImageTool();
  const identifyArgs = [
    ...prefix,
    'identify',
    '-format',
    '%w %h',
    imagePath,
  ];
  const result = await executeCommand(identifyArgs, { channel: CHANNEL });
  if (!result.success || !result.stdout) {
    throw new Error(result.stderr || 'Failed to get image dimensions');
  }
  const [widthStr, heightStr] = result.stdout.trim().split(/\s+/);
  const width = parseInt(widthStr, 10);
  const height = parseInt(heightStr, 10);

  if (isNaN(width) || isNaN(height)) {
    throw new Error(
      `Invalid dimensions parsed: width=${widthStr}, height=${heightStr}`,
    );
  }

  return { width, height };
}

/**
 * Resize an image if it exceeds the maximum dimensions
 * @param imagePath Path to the image file
 * @returns Promise resolving to the path of the resized image (or original if no resize needed)
 */
async function resizeImageIfNeeded(imagePath: string): Promise<string> {
  const maxDimension = getMaxImageDimension();
  const { width, height } = await getImageDimensions(imagePath);
  if (width <= maxDimension && height <= maxDimension) {
    return imagePath;
  }
  const ext = path.extname(imagePath);
  const tempPath = path.join(
    os.tmpdir(),
    `texra-resized-${crypto.randomUUID()}${ext}`,
  );
  const { tool, prefix } = await selectImageTool();
  const convertArgs = [
    ...prefix,
    ...(tool === 'gm' ? ['convert'] : []),
    imagePath,
    '-resize',
    `${maxDimension}x${maxDimension}>`,
    tempPath,
  ];
  const result = await executeCommand(convertArgs, { channel: CHANNEL });
  if (!result.success) {
    throw new Error(result.stderr || 'Failed to resize image');
  }
  logger.debug(
    CHANNEL,
    `Resized image ${imagePath} (${width}x${height}) to fit within ${maxDimension}px`,
  );
  return tempPath;
}

/**
 * Convert an image file to a base64 encoded string
 * @param mediaPath Path to the image file (relative to workspace)
 * @returns Promise<string> Base64 encoded string of the image
 */
export async function getBase64EncodedMedia(
  mediaPath: string,
): Promise<string> {
  try {
    const { absolutePath } = await resolveExistingFile(mediaPath);
    const mimeType = getMimeType(absolutePath);
    let tempPath: string | null = null;
    let pathToRead = absolutePath;

    try {
      if (mimeType?.startsWith('image/')) {
        const resizedPath = await resizeImageIfNeeded(absolutePath);
        if (resizedPath !== absolutePath) {
          tempPath = resizedPath;
          pathToRead = resizedPath;
        }
      }

      const mediaBytes = AbsoluteFS.readBytesSync(pathToRead);
      if (mediaBytes.length === 0) {
        logger.warn(CHANNEL, `Skipping empty media file: ${mediaPath}`);
        throw new Error(`File is empty: ${mediaPath}`);
      }
      const base64String = mediaBytes.toString('base64');
      logger.debug(CHANNEL, `Successfully encoded image: ${mediaPath}`);
      return base64String;
    } finally {
      if (tempPath) {
        try {
          AbsoluteFS.deleteSync(tempPath);
          logger.debug(CHANNEL, `Removed temporary file: ${tempPath}`);
        } catch (err) {
          logger.warn(
            CHANNEL,
            `Failed to remove temporary file ${tempPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error encoding media to base64: ${err instanceof Error ? err.message : String(err)}`,
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
    const { absolutePath } = await resolveExistingFile(pdfPath);
    const pdfBytes = AbsoluteFS.readBytesSync(absolutePath);
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
    const isImageMagickInstalled = await checkMultipleToolsInstalled(
      ['magick', 'gm'],
      false,
    );
    if (!isImageMagickInstalled.some(Boolean)) {
      throw new Error('GraphicsMagick/ImageMagick is not installed.');
    }

    const { absolutePath } = await resolveExistingFile(pdfPath);
    logger.debug(CHANNEL, `Full path to PDF: ${absolutePath}`);

    ensureTempDir();

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

    const convert = fromPath(absolutePath, options);
    logger.debug(CHANNEL, `pdf2pic convert object created`);

    const result = await convert(pageNum);
    logger.debug(CHANNEL, `pdf2pic convert result: ${JSON.stringify(result)}`);

    // Update tempFilePath to match pdf2pic's naming convention
    if (!result || !result.path) {
      throw new Error('PDF conversion failed: No output path returned');
    }
    tempFilePath = result.path;

    if (!AbsoluteFS.existsSync(tempFilePath)) {
      throw new Error(
        'Failed to convert PDF page to PNG: Output file not found',
      );
    }

    // Read the generated PNG file and convert to base64
    const imageBuffer = AbsoluteFS.readBytesSync(tempFilePath);
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
export async function processPdf2Png(
  pdfPath: string,
  maxPages?: number,
  quality?: number,
  maxSize?: [number, number],
): Promise<string | string[] | null> {
  try {
    const { absolutePath } = await resolveExistingFile(pdfPath);
    const pageCount = await countPdfPages(absolutePath);
    if (pageCount === 0) {
      return null;
    }

    // Use default values if not provided
    const finalQuality = quality || 300;
    const finalMaxSize: [number, number] = maxSize || [1024, 1024];

    if (pageCount === 1) {
      return await singlePagePdf2Png(
        absolutePath,
        1,
        finalQuality,
        finalMaxSize,
      );
    } else {
      return await multiPagePdf2Png(
        absolutePath,
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
