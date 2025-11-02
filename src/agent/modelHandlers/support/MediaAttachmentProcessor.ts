// Standard library imports
import * as path from 'path';
import { Buffer } from 'buffer';

// Local imports - agent utils
import { MediaEntry } from '@agent/utils/mediaTypes';
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';
import {
  countPdfPages,
  getBase64EncodedMedia,
  processPdf2Png,
} from '@frontend/media/img';
import type { ChannelLogger } from '@logger/logUtils';
import type { ModelCapabilities } from '@model/ModelConfig';
import { AbsoluteFS, WorkspaceFS, getMimeType } from '@utils/files';

export type MediaFileResult = { path: string; ok: boolean };

export type ProcessImageResult = {
  kind: 'image';
  mediaType: string;
  data: string | string[];
};

export type ProcessAudioResult = {
  kind: 'audio';
  mediaType: string;
  data: string;
};

export type ProcessedMediaResult = ProcessImageResult | ProcessAudioResult;

interface MediaAttachmentProcessorOptions {
  getCapabilities: () => ModelCapabilities;
  isOpenAIProvider: () => boolean;
}

export class MediaAttachmentProcessor {
  constructor(
    private logger: ChannelLogger,
    private readonly options: MediaAttachmentProcessorOptions,
  ) {}

  public setLogger(logger: ChannelLogger): void {
    this.logger = logger;
  }

  private get capabilities(): ModelCapabilities {
    return this.options.getCapabilities();
  }

  private get isOpenAIProvider(): boolean {
    return this.options.isOpenAIProvider();
  }

  public async processImage(
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
        this.logger.debug(
          `Using native PDF for ${mediaFile}. Page count: ${pageCount}`,
        );
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
      if (mimeType && mimeType.startsWith('image/')) {
        mediaType = mimeType;
        this.logger.debug(
          `Processing as image: ${mediaFile}, type: ${mediaType}`,
        );
        mediaData = await getBase64EncodedMedia(mediaFile);
      } else {
        throw new Error(
          `Unsupported image extension: ${ext}. Image support: ${this.capabilities.supportsVision}`,
        );
      }
    }

    return { kind: 'image', mediaType, data: mediaData };
  }

  public async processAudio(
    mediaFile: string,
    ext: string,
  ): Promise<ProcessAudioResult> {
    const mimeType = getMimeType(mediaFile);
    if (
      !mimeType ||
      !mimeType.startsWith('audio/') ||
      !this.capabilities.supportsNativeAudio
    ) {
      throw new Error(
        `Unsupported or disabled audio extension: ${ext}. Audio support: ${this.capabilities.supportsNativeAudio}`,
      );
    }

    const mediaType = mimeType;
    this.logger.debug(`Processing as audio: ${mediaFile}, type: ${mediaType}`);
    let mediaData = await getBase64EncodedMedia(mediaFile);
    if (Array.isArray(mediaData)) {
      this.logger.warn(
        `Audio file ${mediaFile} processed into multiple parts, using only the first.`,
      );
      mediaData = mediaData[0];
    }

    return { kind: 'audio', mediaType, data: mediaData };
  }

  public async processMedia(
    mediaFile: string,
    fileExtension: string,
  ): Promise<ProcessedMediaResult> {
    const ext = fileExtension.toLowerCase();
    return this.isAudio(ext)
      ? this.processAudio(mediaFile, ext)
      : this.processImage(mediaFile, ext);
  }

  public async loadEntries(
    mediaFiles: string[],
  ): Promise<{ entries: MediaEntry[]; results: MediaFileResult[] }> {
    if (mediaFiles.length === 0) {
      return { entries: [], results: [] };
    }

    const settledResults = await Promise.allSettled(
      mediaFiles.map((mediaFile) => this.loadMediaEntry(mediaFile)),
    );

    const entries: MediaEntry[] = [];
    const results: MediaFileResult[] = [];

    settledResults.forEach((settledResult, index) => {
      if (settledResult.status === 'fulfilled') {
        const { entry, result } = settledResult.value;
        results.push(result);

        if (entry) {
          const entryList = Array.isArray(entry) ? entry : [entry];
          entries.push(...entryList);
        }
      } else {
        const reason = settledResult.reason;
        const mediaFile = mediaFiles[index];
        this.logger.error(
          `Failed to load media entry for ${mediaFile}: ${getSdkErrorMessage(reason)}`,
          undefined,
          undefined,
          reason,
        );
        results.push({ path: mediaFile, ok: false });
      }
    });

    return { entries, results };
  }

  public logResults(results: MediaFileResult[]): void {
    if (results.length === 0) {
      return;
    }

    if (results.some((result) => !result.ok)) {
      this.logger.warn('Some media files failed to load');
    }

    this.logger.fileList(results);
  }

  private async loadMediaEntry(
    mediaFile: string,
  ): Promise<{ entry?: MediaEntry | MediaEntry[]; result: MediaFileResult }> {
    const absolutePath = this.resolveAbsolutePath(mediaFile);
    const fileExistsResult = await AbsoluteFS.exists(absolutePath);

    if (!fileExistsResult) {
      this.logger.error(`File not found: ${mediaFile}`);
      return { result: { path: mediaFile, ok: false } };
    }

    let fileSize: number;
    try {
      const stats = await AbsoluteFS.stat(absolutePath);
      fileSize = stats.size;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Unable to read file info for ${mediaFile}: ${message}`,
      );
      return { result: { path: mediaFile, ok: false } };
    }

    if (fileSize === 0) {
      this.logger.warn(`Skipping empty media file: ${mediaFile}`);
      return { result: { path: mediaFile, ok: false } };
    }

    const fileExtension = path.extname(mediaFile).toLowerCase();

    try {
      const processed = await this.processMedia(mediaFile, fileExtension);
      this.logger.debug(
        `Processed ${processed.kind}: ${mediaFile}, type: ${processed.mediaType}`,
      );

      const entry = this.createEntriesForProcessedMedia(
        mediaFile,
        absolutePath,
        fileExtension,
        processed,
      );

      return {
        entry,
        result: { path: mediaFile, ok: true },
      };
    } catch (err) {
      this.logger.error(
        `Failed to process media ${mediaFile}: ${getSdkErrorMessage(err)}`,
        undefined,
        undefined,
        err,
      );
      return { result: { path: mediaFile, ok: false } };
    }
  }

  private resolveAbsolutePath(mediaFile: string): string {
    return path.isAbsolute(mediaFile)
      ? mediaFile
      : WorkspaceFS.fullPath(mediaFile);
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
      const pdfData = Array.isArray(processed.data)
        ? processed.data[0]
        : processed.data;
      const entry = this.createEntry(
        path.basename(mediaFile),
        pdfData,
        processed.mediaType,
        processed.kind,
        absolutePath,
        true,
      );
      this.logger.debug(`Added native PDF: ${mediaFile}`);
      return entry;
    }

    const dataParts = Array.isArray(processed.data)
      ? processed.data
      : [processed.data];
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
    const mimeType = getMimeType(ext);
    return mimeType !== null && mimeType.startsWith('audio/');
  }
}
