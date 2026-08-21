// Third-party imports
import pMap from 'p-map';

// Local imports - agent utils
import { logFilesLoaded, type AgentTrace } from '@agent/trace';
import type { MediaEntry } from '@agent/types/mediaTypes';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import {
  fileLocationDisplayPath,
  type FileLocation,
  type LoadedMediaMetadata,
} from '@shared/schemas';

// Local imports - utils
import { ensureArray } from '@utils/core';
import { getPromptFileName } from '@utils/prompt';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { getMimeType, isImageMimeType } from '@utils/files/mimeUtils';
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

type MediaLoadOutcome =
  | { ok: true; entry?: MediaEntry | MediaEntry[]; result: MediaFileResult }
  | { ok: false; location: FileLocation; reason: unknown };

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
    if (ext !== '.pdf') {
      const mimeType = getMimeType(mediaFile);
      if (!mimeType || !isImageMimeType(mimeType)) {
        throw new Error(
          `Unsupported image extension: ${ext}. Image support: ${this.capabilities.supportsVision}`,
        );
      }
      this.logger.debug('Processing as image', {
        data: { mediaFile, mediaType: mimeType },
      });
      return {
        kind: 'image',
        mediaType: mimeType,
        data: await getBase64EncodedMedia(mediaFile),
      };
    }

    const pageCount = await countPdfPages(mediaFile);
    if (pageCount === 0) {
      throw new Error(`Failed to process PDF file as image: ${mediaFile}`);
    }

    if (this.capabilities.supportsNativePdf) {
      this.logger.debug('Using native PDF', {
        data: { mediaFile, pageCount },
      });
      return {
        kind: 'image',
        mediaType: 'application/pdf',
        data: await getBase64EncodedMedia(mediaFile),
      };
    }

    this.logger.debug(`Converting PDF to PNG: ${mediaFile}`);
    const pdfResult = await processPdf2Png(mediaFile);
    if (pdfResult === null) {
      throw new Error(`Failed to process PDF file as image: ${mediaFile}`);
    }
    return { kind: 'image', mediaType: 'image/png', data: pdfResult };
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
      async (location): Promise<MediaLoadOutcome> => {
        try {
          return { ok: true, ...(await this.loadMediaEntry(location)) };
        } catch (reason) {
          return { ok: false, location, reason };
        }
      },
      { concurrency: MEDIA_CONCURRENCY, stopOnError: false },
    );

    const entries: MediaEntry[] = [];
    const results: MediaFileResult[] = [];

    for (const loadResult of loadResults) {
      if (!loadResult.ok) {
        const displayPath = fileLocationDisplayPath(loadResult.location);
        this.logger.error(
          `Failed to load media entry for ${displayPath}: ${getSdkErrorMessage(loadResult.reason)}`,
          {
            data: { path: displayPath, error: loadResult.reason },
          },
        );
        results.push({ path: displayPath, ok: false });
        continue;
      }

      results.push(loadResult.result);
      if (loadResult.entry) {
        entries.push(...ensureArray(loadResult.entry));
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
    const displayPath = fileLocationDisplayPath(location);
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

  private createEntriesForProcessedMedia(
    mediaFile: string,
    absolutePath: string,
    fileExtension: string,
    processed: ProcessedMediaResult,
  ): MediaEntry | MediaEntry[] {
    // Same rule as a text document's <document name="…">: workspace-relative,
    // so figures/setup/panel.pdf and figures/results/panel.pdf stay distinct to
    // the model. Provider filename fields basename it at their own call site.
    const baseName = getPromptFileName(absolutePath);
    const isPdf = processed.kind === 'image' && fileExtension === '.pdf';

    if (
      isPdf &&
      processed.mediaType === 'application/pdf' &&
      this.isOpenAIProvider &&
      this.capabilities.supportsVision &&
      this.capabilities.supportsNativePdf
    ) {
      const entry = this.createEntry(
        baseName,
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
    const derivedFromConversion =
      isPdf && processed.mediaType !== 'application/pdf';
    const matchesSource = !derivedFromConversion && dataParts.length === 1;

    const entries = dataParts.map((data, index) => {
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
