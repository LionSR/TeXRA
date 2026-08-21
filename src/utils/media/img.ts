// Standard library imports
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { imageSize } from 'image-size';
import { fromPath } from 'pdf2pic';

// Local imports - log
import { createLog } from '@logger/logUtils';
import { generateShortId } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { getMimeType, isImageMimeType } from '@utils/files/mimeUtils';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { createTexraTempDir } from '@utils/files/tempDir';
import { getConfig } from '@utils/config/configUtils';
import { detectImageTool } from '@utils/system/toolUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { executeCommand } from '@utils/system/execUtils';

import { countPdfPagesInBuffer } from './pdfPageCount';

const CHANNEL = 'ImgUtils';
const log = createLog(CHANNEL);

/** DPI/density used when rasterizing a PDF page to PNG. */
const PDF_RASTER_DENSITY = 300;

/** Maximum [width, height] in px for a rasterized PDF page. */
const PDF_RASTER_MAX_SIZE: [number, number] = [1024, 1024];

/** Resolve a file path and return the absolute path, or null if not found. */
async function resolveFile(filePath: string): Promise<string | null> {
  const absolutePath = WorkspaceFS.toAbsolute(filePath);
  const exists = await AbsoluteFS.exists(absolutePath);
  return exists ? absolutePath : null;
}

/** Remove a conversion's private temp directory and every page it holds. */
async function removeConversionTempDir(tempDir: string): Promise<void> {
  try {
    await AbsoluteFS.delete(tempDir, { recursive: true });
  } catch (err) {
    log.warn(
      `Failed to remove temporary directory ${tempDir}: ${toErrorMessage(err)}`,
    );
  }
}

/** Get the dimensions of an image file. Pure JS — no external binary required. */
function getImageDimensions(imagePath: string): {
  width: number;
  height: number;
} {
  try {
    return imageSize(AbsoluteFS.readBytesSync(imagePath));
  } catch (err) {
    throw new Error(`Failed to get image dimensions: ${toErrorMessage(err)}`);
  }
}

/** Maximum image dimension (pixels) accepted by provider APIs. */
const API_MAX_IMAGE_DIMENSION = 8000;

/** Resize an image if it exceeds the maximum dimensions. Returns the original path if no resize needed. */
async function resizeImageIfNeeded(imagePath: string): Promise<string> {
  const maxDimension = Math.min(
    getConfig<number>('texra.maxImageDimension', 2000),
    API_MAX_IMAGE_DIMENSION,
  );
  const { width, height } = getImageDimensions(imagePath);

  if (width <= maxDimension && height <= maxDimension) {
    return imagePath;
  }

  // Resizing (unlike measuring) still needs an external tool — only
  // required once we know the image actually exceeds the limit.
  const tool = await detectImageTool();
  if (!tool) {
    throw new Error('Neither ImageMagick nor GraphicsMagick is installed');
  }

  const ext = path.extname(imagePath);
  const tempPath = path.join(
    os.tmpdir(),
    `texra-resized-${generateShortId()}${ext}`,
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

  log.debug(
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

  try {
    if (isImageMimeType(mimeType)) {
      const resizedPath = await resizeImageIfNeeded(absolutePath);
      if (resizedPath !== absolutePath) {
        tempPath = resizedPath;
      }
    }

    const mediaBytes = AbsoluteFS.readBytesSync(tempPath ?? absolutePath);
    if (mediaBytes.length === 0) {
      throw new Error(`File is empty: ${mediaPath}`);
    }

    log.debug(`Successfully encoded image: ${mediaPath}`);
    return mediaBytes.toString('base64');
  } finally {
    if (tempPath) {
      try {
        AbsoluteFS.deleteSync(tempPath);
      } catch (err) {
        log.warn(
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
      log.debug(`PDF file not found: ${pdfPath}`);
      return 0;
    }
    return await countPdfPagesInBuffer(AbsoluteFS.readBytesSync(absolutePath));
  } catch (err) {
    log.error(`Error counting PDF pages: ${toErrorMessage(err)}`);
    return 0;
  }
}

/**
 * Convert a single page of an already-resolved PDF to a base64 encoded PNG.
 * The caller owns resolving the path, verifying the image tool, and creating
 * the temp directory once per conversion, so none is re-probed per page.
 */
async function singlePagePdf2Png(
  absolutePath: string,
  pageNum: number,
  tempDir: string,
): Promise<string> {
  const convert = fromPath(absolutePath, {
    density: PDF_RASTER_DENSITY,
    width: PDF_RASTER_MAX_SIZE[0],
    height: PDF_RASTER_MAX_SIZE[1],
    preserveAspectRatio: true,
    format: 'png',
    saveFilename: `page-${pageNum}`,
    savePath: tempDir,
  });
  const result = await convert(pageNum);

  if (!result?.path) {
    throw new Error('PDF conversion failed: No output path returned');
  }

  if (!AbsoluteFS.existsSync(result.path)) {
    throw new Error('Failed to convert PDF page to PNG: Output file not found');
  }

  const imageBuffer = AbsoluteFS.readBytesSync(result.path);
  log.debug(`Successfully converted page ${pageNum} of ${absolutePath} to PNG`);
  return imageBuffer.toString('base64');
}

/** Upper bound on the pages rasterized from one PDF. */
const PDF_MAX_PAGES = 100;

/** Process a PDF file and return one base64 encoded PNG per page. Returns null on error. */
export async function processPdf2Png(
  pdfPath: string,
): Promise<string[] | null> {
  try {
    const absolutePath = await resolveFile(pdfPath);
    if (!absolutePath) {
      log.debug(`PDF file not found: ${pdfPath}`);
      return null;
    }

    const pageCount = await countPdfPagesInBuffer(
      AbsoluteFS.readBytesSync(absolutePath),
    );
    if (pageCount === 0) {
      return null;
    }

    if (!(await detectImageTool())) {
      throw new Error('GraphicsMagick/ImageMagick is not installed.');
    }

    // Private per-conversion directory so the cleanup below can delete every
    // page it holds without touching pages a concurrent conversion is reading.
    const tempDir = await createTexraTempDir('texra-pdf-conversion-');
    try {
      const pagesToConvert = Math.min(pageCount, PDF_MAX_PAGES);
      const base64Images: string[] = [];
      for (let pageNum = 1; pageNum <= pagesToConvert; pageNum++) {
        base64Images.push(
          await singlePagePdf2Png(absolutePath, pageNum, tempDir),
        );
      }
      log.debug(
        `Successfully converted ${base64Images.length} pages from ${pdfPath}`,
      );
      return base64Images;
    } finally {
      await removeConversionTempDir(tempDir);
    }
  } catch (err) {
    log.error(`Error processing PDF input: ${toErrorMessage(err)}`);
    return null;
  }
}
