// Standard library imports
import * as path from 'node:path';
import { Buffer } from 'node:buffer';

// Third-party imports
import pMap from 'p-map';

// Local imports - agent utils
import { logFilesLoaded, type AgentTrace } from '@agent/trace';
import type { MediaEntry } from '@agent/utils/mediaTypes';
import { getSdkErrorMessage } from '@common/errors';
import type { FileLocation, LoadedMediaMetadata } from '@shared/schemas';

// Local imports - utils
import { ensureArray } from '@utils/core';
import { AbsoluteFS, getComparablePath, getMimeType } from '@utils/files';
import { getExtensionLowercase } from '@utils/core/pathCore';
import {
  countPdfPages,
  getBase64EncodedMedia,
  processPdf2Png,
} from '@utils/media/img';
import type { ModelCapabilities } from 'llm-zoo';

/**
 * Result of loading a media file.
 * @property path - Display path for logging/UI (workspace-relative for workspace files,
 *   absolute for external files). This is not used for file operations.
 * @property ok - Whether the file was successfully loaded
 */
export type MediaFileResult =
  | {
      path: string;
      ok: true;
      media: LoadedMediaMetadata;
    }
  | {
      path: string;
      ok: false;
    };

type ProcessImageResult = {
  kind: 'image';
  mediaType: string;
  data: string | string[];
};

type ProcessAudioResult = {
  kind: 'audio';
  mediaType: string;
  data: string;
};

type ProcessedMediaResult = ProcessImageResult | ProcessAudioResult;

interface MediaAttachmentProcessorOptions {
  getCapabilities: () => ModelCapabilities;
  isOpenAIProvider: () => boolean;
}

export class MediaAttachmentProcessor {
  constructor(
    private logger: AgentTrace,
    private readonly options: MediaAttachmentProcessorOptions,
  ) {}

  public setLogger(logger: AgentTrace): void {
    this.logger = logger;
  }

  private get capabilities(): ModelCapabilities {
    return this.options.getCapabilities();
  }

  private get isOpenAIProvider(): boolean {
    return this.options.isOpenAIProvider();
  }

  private async processImage(
    mediaFile: string,
    ext: string,
  ): Promise<ProcessImageResult> {
    let mediaType: string;
    let mediaData: string | string[];

    if (ext === '.pdf') {
      const pageCount = await countPdfPages(mediaFile);
      if (pageCount === 0) {
        throw new Error(`Failed to process PDF file as image: ${mediaFile}`);
      }

      if (this.capabilities.supportsNativePdf) {
        this.logger.debug('Using native PDF', {
          data: { mediaFile, pageCount },
        });
        mediaType = 'application/pdf';
        mediaData = await getBase64EncodedMedia(mediaFile);
        return { kind: 'image', mediaType, data: mediaData };
      }

      mediaType = 'image/png';
      this.logger.debug(`Converting PDF to PNG: ${mediaFile}`);
      const pdfResult = await processPdf2Png(mediaFile);
      if (pdfResult === null) {
        throw new Error(`Failed to process PDF file as image: ${mediaFile}`);
      }
      mediaData = pdfResult;
    } else {
      const mimeType = getMimeType(mediaFile);
      if (mimeType?.startsWith('image/')) {
        mediaType = mimeType;
        this.logger.debug('Processing as image', {
          data: { mediaFile, mediaType },
        });
        mediaData = await getBase64EncodedMedia(mediaFile);
      } else {
        throw new Error(
          `Unsupported image extension: ${ext}. Image support: ${this.capabilities.supportsVision}`,
        );
      }
    }

    return { kind: 'image', mediaType, data: mediaData };
  }

  private async processAudio(
    mediaFile: string,
    ext: string,
  ): Promise<ProcessAudioResult> {
    const mimeType = getMimeType(mediaFile);
    if (
      !mimeType?.startsWith('audio/') ||
      !this.capabilities.supportsNativeAudio
    ) {
      throw new Error(
        `Unsupported or disabled audio extension: ${ext}. Audio support: ${this.capabilities.supportsNativeAudio}`,
      );
    }

    this.logger.debug('Processing as audio', { data: { mediaFile, mimeType } });
    let mediaData = await getBase64EncodedMedia(mediaFile);
    if (Array.isArray(mediaData)) {
      this.logger.warn(
        `Audio file ${mediaFile} processed into multiple parts, using only the first.`,
      );
      mediaData = mediaData.at(0)!;
    }

    return { kind: 'audio', mediaType: mimeType, data: mediaData };
  }

  public async loadEntries(
    mediaFiles: FileLocation[],
  ): Promise<{ entries: MediaEntry[]; results: MediaFileResult[] }> {
    if (mediaFiles.length === 0) {
      return { entries: [], results: [] };
    }

    // Use pMap with concurrency control for I/O-intensive media loading
    const MEDIA_CONCURRENCY = 4;

    const loadResults = await pMap(
      mediaFiles,
      async (
        location,
      ): Promise<
        | {
            ok: true;
            entry: MediaEntry | MediaEntry[] | undefined;
            result: MediaFileResult;
          }
        | { ok: false; location: FileLocation; reason: unknown }
      > => {
        try {
          const { entry, result } = await this.loadMediaEntry(location);
          return { ok: true, entry, result };
        } catch (reason) {
          return { ok: false, location, reason };
        }
      },
      { concurrency: MEDIA_CONCURRENCY, stopOnError: false },
    );

    const entries: MediaEntry[] = [];
    const results: MediaFileResult[] = [];

    for (const loadResult of loadResults) {
      if (loadResult.ok) {
        const { entry, result } = loadResult;
        results.push(result);

        if (entry) {
          const entryList = ensureArray(entry);
          entries.push(...entryList);
        }
      } else {
        const { location, reason } = loadResult;
        const displayPath = getComparablePath(location);
        this.logger.error(
          `Failed to load media entry for ${displayPath}: ${getSdkErrorMessage(reason)}`,
          {
            data: { path: displayPath, error: reason },
          },
        );
        results.push({ path: displayPath, ok: false });
      }
    }

    return { entries, results };
  }

  public logResults(results: MediaFileResult[]): void {
    if (results.length === 0) {
      return;
    }

    if (results.some((result) => !result.ok)) {
      this.logger.warn('Some media files failed to load');
    }

    logFilesLoaded(this.logger, 'all', results);
  }

  private async loadMediaEntry(
    location: FileLocation,
  ): Promise<{ entry?: MediaEntry | MediaEntry[]; result: MediaFileResult }> {
    const absolutePath = location.absolutePath;
    // Workspace/run-storage paths remain concise and relative; external media
    // keeps its absolute path so a terminal row identifies the actual file.
    const displayPath = getComparablePath(location);
    const fileExistsResult = await AbsoluteFS.exists(absolutePath);

    if (!fileExistsResult) {
      this.logger.error(`File not found: ${displayPath}`);
      return { result: { path: displayPath, ok: false } };
    }

    let fileSize: number;
    try {
      const stats = await AbsoluteFS.stat(absolutePath);
      fileSize = stats.size;
    } catch (err) {
      this.logger.error(
        `Unable to read file info for ${displayPath}: ${getSdkErrorMessage(err)}`,
        { data: { path: displayPath, error: err } },
      );
      return { result: { path: displayPath, ok: false } };
    }

    if (fileSize === 0) {
      this.logger.warn(`Skipping empty media file: ${displayPath}`);
      return { result: { path: displayPath, ok: false } };
    }

    const fileExtension = getExtensionLowercase(absolutePath);

    try {
      // Process as audio or image based on mime type
      const processed = this.isAudio(fileExtension)
        ? await this.processAudio(absolutePath, fileExtension)
        : await this.processImage(absolutePath, fileExtension);
      this.logger.debug('Processed media', {
        data: {
          kind: processed.kind,
          path: displayPath,
          mediaType: processed.mediaType,
        },
      });

      const entry = this.createEntriesForProcessedMedia(
        displayPath,
        absolutePath,
        fileExtension,
        processed,
      );

      return {
        entry,
        result: {
          path: displayPath,
          ok: true,
          media: {
            kind: processed.kind,
            mimeType: processed.mediaType,
            sizeBytes: fileSize,
          },
        },
      };
    } catch (err) {
      this.logger.error(
        `Failed to process media ${displayPath}: ${getSdkErrorMessage(err)}`,
        {
          data: { path: displayPath, error: err },
        },
      );
      return { result: { path: displayPath, ok: false } };
    }
  }

  private shouldReturnNativePdf(
    processed: ProcessImageResult,
    fileExtension: string,
  ): boolean {
    return (
      fileExtension === '.pdf' &&
      processed.mediaType === 'application/pdf' &&
      this.isOpenAIProvider &&
      this.capabilities.supportsVision &&
      this.capabilities.supportsNativePdf
    );
  }

  private createEntriesForProcessedMedia(
    mediaFile: string,
    absolutePath: string,
    fileExtension: string,
    processed: ProcessedMediaResult,
  ): MediaEntry | MediaEntry[] {
    if (
      processed.kind === 'image' &&
      this.shouldReturnNativePdf(processed, fileExtension)
    ) {
      const entry = this.createEntry(
        path.basename(mediaFile),
        Array.isArray(processed.data) ? processed.data[0] : processed.data,
        processed.mediaType,
        processed.kind,
        absolutePath,
        true,
      );
      this.logger.debug(`Added native PDF: ${mediaFile}`);
      return entry;
    }

    const dataParts = ensureArray(processed.data);
    const isImage = processed.kind === 'image';
    const derivedFromConversion =
      isImage &&
      fileExtension === '.pdf' &&
      processed.mediaType !== 'application/pdf';
    const baseName = path.basename(mediaFile);

    const entries = dataParts.map((data, index) => {
      const matchesSource = !derivedFromConversion && dataParts.length === 1;
      const fileName =
        dataParts.length === 1 ? baseName : `${baseName}_page_${index + 1}`;
      return this.createEntry(
        fileName,
        data,
        processed.mediaType,
        processed.kind,
        absolutePath,
        matchesSource,
      );
    });

    if (entries.length === 1) {
      this.logger.debug(
        `Adding single part to the media contents: ${mediaFile}`,
      );
      return entries[0];
    }

    this.logger.debug(
      `Adding ${entries.length} pages/parts to the media contents`,
    );
    return entries;
  }

  private createEntry(
    fileName: string,
    data: string,
    mediaType: string,
    mediaCategory: ProcessedMediaResult['kind'],
    absolutePath: string,
    matchesSource: boolean,
  ): MediaEntry {
    const entry: MediaEntry = {
      file_name: fileName,
      data,
      media_type: mediaType,
      media_category: mediaCategory,
      binary_data: Buffer.from(data, 'base64'),
      bytes_match_source: matchesSource,
    };

    if (matchesSource) {
      entry.source_path = absolutePath;
    }

    return entry;
  }

  private isAudio(ext: string): boolean {
    return getMimeType(ext)?.startsWith('audio/') ?? false;
  }
}
