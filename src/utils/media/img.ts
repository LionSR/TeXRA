// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Data, Effect, FileSystem } from 'effect';
import { imageSize } from 'image-size';

// Local imports - log
import { createLog } from '@logger/logUtils';
import type { ConfigProvider } from '@platform/interfaces';
import { getMimeType, isImageMimeType } from '@utils/files/mimeUtils';
import { readConfig } from '@utils/config/configUtils';
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

/**
 * A media file that could not be turned into model input for a reason other
 * than the filesystem's own (`PlatformError`): missing or empty, unmeasurable,
 * or an image tool or PDF parser that failed. The message is the one the run
 * transcript shows.
 */
class MediaConversionFailed extends Data.TaggedError('MediaConversionFailed')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A throw or rejection from outside Effect, carrying its own message. */
const conversionFailure = (cause: unknown): MediaConversionFailed =>
  new MediaConversionFailed({ message: toErrorMessage(cause), cause });

/** A step that runs outside Effect (image tools, the PDF parser), typed. */
const conversionStep = <A>(
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, MediaConversionFailed> =>
  Effect.tryPromise({ try: evaluate, catch: conversionFailure });

/** Base64 of file bytes, without copying them. */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    'base64',
  );
}

/** Remove a file or directory this module created, warning when it cannot. */
function removeTemporary(
  fs: FileSystem.FileSystem,
  target: string,
  what: string,
): Effect.Effect<void> {
  return fs
    .remove(target, { recursive: true, force: true })
    .pipe(
      Effect.catchTag('PlatformError', (error) =>
        Effect.sync(() =>
          log.warn(`Failed to remove ${what} ${target}: ${error.message}`),
        ),
      ),
    );
}

/** Get the dimensions of an image file. Pure JS — no external binary required. */
const getImageDimensions = Effect.fn('img.getImageDimensions')(
  function* (imagePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const bytes = yield* fs.readFile(imagePath);
    return yield* Effect.try({
      try: () => imageSize(bytes),
      catch: conversionFailure,
    });
  },
  Effect.catchTag(['PlatformError', 'MediaConversionFailed'], (error) =>
    Effect.fail(
      new MediaConversionFailed({
        message: `Failed to get image dimensions: ${error.message}`,
        cause: error,
      }),
    ),
  ),
);

/** Maximum image dimension (pixels) accepted by provider APIs. */
const API_MAX_IMAGE_DIMENSION = 8000;

/**
 * Bytes of an image, resized when it exceeds the maximum dimensions. The limit
 * comes from the configuration of the workspace the caller is reading for,
 * held as data, not from whichever roots the calling fiber carries.
 */
const resizeImageIfNeeded = Effect.fn('img.resizeImageIfNeeded')(function* (
  imagePath: string,
  config: ConfigProvider,
) {
  const fs = yield* FileSystem.FileSystem;
  const configuredMaxDimension = yield* Effect.try({
    try: () => readConfig<number>(config, 'texra.maxImageDimension'),
    catch: conversionFailure,
  });
  const maxDimension = Math.min(
    configuredMaxDimension,
    API_MAX_IMAGE_DIMENSION,
  );
  const { width, height } = yield* getImageDimensions(imagePath);

  if (width <= maxDimension && height <= maxDimension) {
    return yield* fs.readFile(imagePath);
  }

  // Resizing (unlike measuring) still needs an external tool — only
  // required once we know the image actually exceeds the limit.
  const tool = yield* conversionStep(detectImageTool);
  if (!tool) {
    return yield* new MediaConversionFailed({
      message: 'Neither ImageMagick nor GraphicsMagick is installed',
    });
  }

  const ext = path.extname(imagePath);
  return yield* Effect.acquireUseRelease(
    fs.makeTempFile({ prefix: 'texra-resized-', suffix: ext }),
    (tempPath) =>
      Effect.gen(function* () {
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
        const result = yield* Effect.tryPromise({
          try: (signal) =>
            executeCommand(convertArgs, {
              channel: CHANNEL,
              // Both operands are absolute paths, so the conversion is
              // independent of where it runs: the process cwd is the honest
              // root rather than a workspace this module never receives, and
              // there are no workspace settings to carry with it.
              cwd: process.cwd(),
              settings: undefined,
              signal,
            }),
          catch: conversionFailure,
        });
        if (!result.success) {
          return yield* new MediaConversionFailed({
            message: result.stderr || 'Failed to resize image',
          });
        }

        log.debug(
          `Resized image ${imagePath} (${width}x${height}) to fit within ${maxDimension}px`,
        );
        return yield* fs.readFile(tempPath);
      }),
    (tempPath) => removeTemporary(fs, tempPath, 'temporary file'),
  );
});

/**
 * Base64 of a media file at an absolute path, resizing an oversized image
 * first. A missing or empty file fails with {@link MediaConversionFailed}. A
 * non-image file that exists but cannot be read fails with the filesystem's
 * `PlatformError`; an image whose bytes cannot be measured fails with
 * {@link MediaConversionFailed}.
 */
export const getBase64EncodedMedia = Effect.fn('img.getBase64EncodedMedia')(
  function* (mediaPath: string, config: ConfigProvider) {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(mediaPath))) {
      return yield* new MediaConversionFailed({
        message: `File not found: ${mediaPath}`,
      });
    }

    const mediaBytes = yield* isImageMimeType(getMimeType(mediaPath))
      ? resizeImageIfNeeded(mediaPath, config)
      : fs.readFile(mediaPath);
    if (mediaBytes.length === 0) {
      return yield* new MediaConversionFailed({
        message: `File is empty: ${mediaPath}`,
      });
    }

    log.debug(`Successfully encoded image: ${mediaPath}`);
    return toBase64(mediaBytes);
  },
);

/** The number of pages in the PDF at an absolute path; 0 if it is missing or unreadable. */
export const countPdfPages = Effect.fn('img.countPdfPages')(
  function* (pdfPath: string) {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(pdfPath))) {
      log.debug(`PDF file not found: ${pdfPath}`);
      return 0;
    }
    const bytes = yield* fs.readFile(pdfPath);
    return yield* conversionStep(() => countPdfPagesInBuffer(bytes));
  },
  Effect.catchTag(['PlatformError', 'MediaConversionFailed'], (error) =>
    Effect.sync(() => {
      log.error(`Error counting PDF pages: ${error.message}`);
      return 0;
    }),
  ),
);

/**
 * Convert a single page of an already-resolved PDF to a base64 encoded PNG.
 * The caller owns resolving the path, verifying the image tool, and creating
 * the temp directory once per conversion, so none is re-probed per page.
 */
const singlePagePdf2Png = Effect.fn('img.singlePagePdf2Png')(function* (
  absolutePath: string,
  pageNum: number,
  tempDir: string,
  tool: 'magick' | 'gm',
) {
  const fs = yield* FileSystem.FileSystem;
  const outputPath = path.join(tempDir, `page-${pageNum}.png`);
  // Density is an input option; `>` fits the page inside 1024×1024.
  const convertArgs = [
    tool,
    ...(tool === 'gm' ? ['convert'] : []),
    '-density',
    `${PDF_RASTER_DENSITY}x${PDF_RASTER_DENSITY}`,
    `${absolutePath}[${pageNum - 1}]`,
    '-units',
    'PixelsPerInch',
    '-resize',
    `${PDF_RASTER_MAX_SIZE[0]}x${PDF_RASTER_MAX_SIZE[1]}>`,
    outputPath,
  ];
  // ImageMagick and GraphicsMagick hand the rasterization to a Ghostscript
  // delegate, so signal the tree: an interrupted conversion must not leave the
  // delegate running over the page it is still writing.
  const result = yield* Effect.tryPromise({
    try: (signal) =>
      executeCommand(convertArgs, {
        channel: CHANNEL,
        // Absolute input and output paths, and no workspace of its own: see
        // `resizeImageIfNeeded`.
        cwd: process.cwd(),
        settings: undefined,
        signal,
        killProcessTree: true,
      }),
    catch: conversionFailure,
  });
  if (!result.success) {
    return yield* new MediaConversionFailed({
      message:
        result.stderr || 'PDF conversion failed: No output path returned',
    });
  }

  if (!(yield* fs.exists(outputPath))) {
    return yield* new MediaConversionFailed({
      message: 'Failed to convert PDF page to PNG: Output file not found',
    });
  }

  const imageBytes = yield* fs.readFile(outputPath);
  log.debug(`Successfully converted page ${pageNum} of ${absolutePath} to PNG`);
  return toBase64(imageBytes);
});

/** Upper bound on the pages rasterized from one PDF. */
const PDF_MAX_PAGES = 100;

/**
 * One base64 encoded PNG per page of the PDF at an absolute path; null if it
 * is missing, has no pages, or cannot be rasterized.
 */
export const processPdf2Png = Effect.fn('img.processPdf2Png')(
  function* (pdfPath: string) {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(pdfPath))) {
      log.debug(`PDF file not found: ${pdfPath}`);
      return null;
    }

    const bytes = yield* fs.readFile(pdfPath);
    const pageCount = yield* conversionStep(() => countPdfPagesInBuffer(bytes));
    if (pageCount === 0) {
      return null;
    }

    const tool = yield* conversionStep(detectImageTool);
    if (!tool) {
      return yield* new MediaConversionFailed({
        message: 'GraphicsMagick/ImageMagick is not installed.',
      });
    }

    // Private per-conversion directory so the release below can delete every
    // page it holds without touching pages a concurrent conversion is reading.
    return yield* Effect.acquireUseRelease(
      fs.makeTempDirectory({ prefix: 'texra-pdf-conversion-' }),
      (tempDir) =>
        Effect.gen(function* () {
          const pagesToConvert = Math.min(pageCount, PDF_MAX_PAGES);
          if (pagesToConvert < pageCount) {
            // The cap protects against pathological PDFs, but dropping pages
            // silently lets a model reason about a paper it has only part of.
            log.warn(
              `Rasterizing only the first ${pagesToConvert} of ${pageCount} pages from ${pdfPath}; the rest are not attached.`,
            );
          }
          const base64Images: string[] = [];
          for (let pageNum = 1; pageNum <= pagesToConvert; pageNum++) {
            base64Images.push(
              yield* singlePagePdf2Png(pdfPath, pageNum, tempDir, tool),
            );
          }
          log.debug(
            `Successfully converted ${base64Images.length} pages from ${pdfPath}`,
          );
          return base64Images;
        }),
      (tempDir) => removeTemporary(fs, tempDir, 'temporary directory'),
    );
  },
  Effect.catchTag(['PlatformError', 'MediaConversionFailed'], (error) =>
    Effect.sync(() => {
      log.error(`Error processing PDF input: ${error.message}`);
      return null;
    }),
  ),
);
