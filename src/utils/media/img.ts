// Standard library imports
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

// Third-party imports
import { PDFDocument } from '@cantoo/pdf-lib';
import { fromPath } from 'pdf2pic';

// Local imports - log
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { getConfig } from '@utils/config';
import { AbsoluteFS, getMimeType, WorkspaceFS } from '@utils/files';
import { checkMultipleToolsInstalled } from '@utils/system';
import { executeCommand } from '@utils/system/execUtils';

const CHANNEL = 'ImgUtils';
logger.initialize(CHANNEL);

/**
 * Get the maximum image dimension from VS Code configuration
 * @returns Maximum image dimension (defaults to 2000)
 */
function getMaxImageDimension(): number {
  return getConfig<number>('texra.maxImageDimension', 2000);
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

/** Resolve a file path and return the absolute path, or null if not found. */
async function resolveFile(filePath: string): Promise<string | null> {
  const absolutePath = WorkspaceFS.toAbsolute(filePath);
  const exists = await AbsoluteFS.exists(absolutePath);
  return exists ? absolutePath : null;
}

/** Load a PDF and return its page count. Expects an absolute path. */
async function loadPdfPageCount(absolutePath: string): Promise<number> {
  const pdfBytes = AbsoluteFS.readBytesSync(absolutePath);
  const pdfDoc = await PDFDocument.load(pdfBytes, {
    updateMetadata: false,
    ignoreEncryption: true,
  });
  return pdfDoc.getPageCount();
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
      logger.warn(
        CHANNEL,
        `Failed to delete temporary file ${file}: ${toErrorMessage(err)}`,
      );
    }
  }
}

/**
 * Select the appropriate image processing tool
 * @returns Tool name ('magick' or 'gm')
 */
async function selectImageTool(): Promise<'magick' | 'gm'> {
  const [hasMagick, hasGm] = await checkMultipleToolsInstalled(
    ['magick', 'gm'],
    false,
  );
  if (hasMagick) return 'magick';
  if (hasGm) return 'gm';
  throw new Error('Neither ImageMagick nor GraphicsMagick is installed');
}

/** Get the dimensions of an image file using ImageMagick or GraphicsMagick. */
async function getImageDimensions(
  imagePath: string,
  tool: 'magick' | 'gm',
): Promise<{ width: number; height: number }> {
  const identifyArgs = [tool, 'identify', '-format', '%w %h', imagePath];
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

/** Maximum image dimension (pixels) accepted by provider APIs. */
const API_MAX_IMAGE_DIMENSION = 8000;

/** Resize an image if it exceeds the maximum dimensions. Returns the original path if no resize needed. */
async function resizeImageIfNeeded(imagePath: string): Promise<string> {
  const tool = await selectImageTool();
  const maxDimension = Math.min(
    getMaxImageDimension(),
    API_MAX_IMAGE_DIMENSION,
  );
  const { width, height } = await getImageDimensions(imagePath, tool);

  if (width <= maxDimension && height <= maxDimension) {
    return imagePath;
  }

  const ext = path.extname(imagePath);
  const tempPath = path.join(
    os.tmpdir(),
    `texra-resized-${crypto.randomUUID()}${ext}`,
  );

  // ImageMagick v7+: magick input -resize ... output
  // GraphicsMagick: gm convert input -resize ... output
  const convertArgs = [
    tool,
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

/** Convert an image file to a base64 encoded string, resizing if needed. */
export async function getBase64EncodedMedia(
  mediaPath: string,
): Promise<string> {
  const absolutePath = await resolveFile(mediaPath);
  if (!absolutePath) {
    throw new Error(`File not found: ${mediaPath}`);
  }

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
      throw new Error(`File is empty: ${mediaPath}`);
    }

    logger.debug(CHANNEL, `Successfully encoded image: ${mediaPath}`);
    return mediaBytes.toString('base64');
  } finally {
    if (tempPath) {
      try {
        AbsoluteFS.deleteSync(tempPath);
      } catch (err) {
        logger.warn(
          CHANNEL,
          `Failed to remove temporary file ${tempPath}: ${toErrorMessage(err)}`,
        );
      }
    }
  }
}

/** Get the number of pages in a PDF file. Returns 0 if file not found or error. */
export async function countPdfPages(pdfPath: string): Promise<number> {
  try {
    const absolutePath = await resolveFile(pdfPath);
    if (!absolutePath) {
      logger.debug(CHANNEL, `PDF file not found: ${pdfPath}`);
      return 0;
    }
    return await loadPdfPageCount(absolutePath);
  } catch (err) {
    logger.error(CHANNEL, `Error counting PDF pages: ${toErrorMessage(err)}`);
    return 0;
  }
}

/** Convert a single page of a PDF to a base64 encoded PNG image. */
export async function singlePagePdf2Png(
  pdfPath: string,
  pageNum: number = 1,
  quality: number = 300,
  maxSize: [number, number] = [1024, 1024],
): Promise<string> {
  try {
    // Check for GraphicsMagick/ImageMagick installation
    const toolsInstalled = await checkMultipleToolsInstalled(
      ['magick', 'gm'],
      false,
    );
    if (!toolsInstalled.some(Boolean)) {
      throw new Error('GraphicsMagick/ImageMagick is not installed.');
    }

    const absolutePath = await resolveFile(pdfPath);
    if (!absolutePath) {
      throw new Error(`PDF file not found: ${pdfPath}`);
    }

    ensureTempDir();

    const tempFilePattern = `temp_${Date.now()}`;
    const options = {
      density: quality,
      width: maxSize[0],
      height: maxSize[1],
      preserveAspectRatio: true,
      format: 'png',
      saveFilename: path.parse(tempFilePattern).name,
      savePath: TEMP_DIR,
    };

    const convert = fromPath(absolutePath, options);
    const result = await convert(pageNum);

    if (!result?.path) {
      throw new Error('PDF conversion failed: No output path returned');
    }

    if (!AbsoluteFS.existsSync(result.path)) {
      throw new Error(
        'Failed to convert PDF page to PNG: Output file not found',
      );
    }

    const imageBuffer = AbsoluteFS.readBytesSync(result.path);
    logger.debug(
      CHANNEL,
      `Successfully converted page ${pageNum} of ${pdfPath} to PNG`,
    );
    return imageBuffer.toString('base64');
  } finally {
    await cleanupTempFiles(TEMP_DIR, 'temp_');
  }
}

/** Convert multiple pages of a PDF to base64 encoded PNG images. */
export async function multiPagePdf2Png(
  pdfPath: string,
  quality: number = 300,
  maxSize: [number, number] = [1024, 1024],
  maxPages: number = 100,
): Promise<string[]> {
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
}

/** Process a PDF file and return base64 encoded PNG image(s). Returns null on error. */
export async function processPdf2Png(
  pdfPath: string,
  maxPages?: number,
  quality?: number,
  maxSize?: [number, number],
): Promise<string | string[] | null> {
  try {
    const absolutePath = await resolveFile(pdfPath);
    if (!absolutePath) {
      logger.debug(CHANNEL, `PDF file not found: ${pdfPath}`);
      return null;
    }

    const pageCount = await loadPdfPageCount(absolutePath);
    if (pageCount === 0) {
      return null;
    }

    const finalQuality = quality ?? 300;
    const finalMaxSize: [number, number] = maxSize ?? [1024, 1024];

    if (pageCount === 1) {
      return await singlePagePdf2Png(pdfPath, 1, finalQuality, finalMaxSize);
    }
    return await multiPagePdf2Png(
      pdfPath,
      finalQuality,
      finalMaxSize,
      maxPages,
    );
  } catch (err) {
    logger.error(CHANNEL, `Error processing PDF input: ${toErrorMessage(err)}`);
    return null;
  }
}
