// Node imports
import { Buffer } from 'node:buffer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it, beforeAll, afterAll } from 'vitest';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { DEFAULT_MODEL_CAPABILITIES, type ModelCapabilities } from 'llm-zoo';

// Local imports
import { noopTrace, type AgentTrace } from '@agent/trace';
import {
  MediaAttachmentProcessor,
  type MediaFileResult,
} from '@agent/modelHandlers/support/MediaAttachmentProcessor';
import type { MediaEntry } from '@agent/types/mediaTypes';
import { attachProviderError } from '@common/errors/sdkError/errorMetadata';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { fileLocationDisplayPath } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { pathToLocation } from '@utils/files/fileLocation';

interface MediaLogRecorder extends AgentTrace {
  debugMessages: string[];
  warnMessages: string[];
  errorMessages: string[];
  fileListEntries: MediaFileResult[][];
}

function createMediaLogRecorder(): MediaLogRecorder {
  return {
    ...noopTrace,
    debugMessages: [],
    warnMessages: [],
    errorMessages: [],
    fileListEntries: [],
    debug(message: string) {
      this.debugMessages.push(message);
    },
    warn(message: string) {
      this.warnMessages.push(message);
    },
    error(message: string) {
      this.errorMessages.push(message);
    },
    domain(event) {
      if (event.key === 'filesLoaded') {
        const data = event.data as { entries: readonly MediaFileResult[] };
        this.fileListEntries.push([...data.entries]);
      }
    },
  };
}

describe('MediaAttachmentProcessor', () => {
  const absoluteFsAny = AbsoluteFS as unknown as {
    exists: (filePath: string) => Promise<boolean>;
    stat: (
      filePath: string,
    ) => Promise<{ type: number; ctime: number; mtime: number; size: number }>;
  };
  const originalExists = absoluteFsAny.exists;
  const originalStat = absoluteFsAny.stat;
  const tempDirs: string[] = [];

  // Real node fs is required because fixtures live in os.tmpdir().
  setupPlatform({}, { fs: nodeFilesystem });

  beforeAll(() => {
    absoluteFsAny.exists = async (filePath: string) => {
      if (!path.isAbsolute(filePath)) {
        throw new Error(`Expected absolute path, received ${filePath}`);
      }
      return fs.existsSync(filePath);
    };

    absoluteFsAny.stat = async (filePath: string) => {
      if (!path.isAbsolute(filePath)) {
        throw new Error(`Expected absolute path, received ${filePath}`);
      }
      const stats = fs.statSync(filePath);
      return {
        type: 0,
        ctime: stats.ctimeMs,
        mtime: stats.mtimeMs,
        size: stats.size,
      };
    };
  });

  afterAll(async () => {
    absoluteFsAny.exists = originalExists;
    absoluteFsAny.stat = originalStat;
    await cleanupTempDirs(tempDirs);
  });

  function createProcessor(
    logger: AgentTrace,
    capabilities: Partial<ModelCapabilities>,
    isOpenAIProvider: boolean = true,
  ): MediaAttachmentProcessor {
    const mergedCapabilities: ModelCapabilities = {
      ...DEFAULT_MODEL_CAPABILITIES,
      ...capabilities,
    };

    return new MediaAttachmentProcessor(logger, {
      getCapabilities: () => mergedCapabilities,
      isOpenAIProvider: () => isOpenAIProvider,
    });
  }

  async function createTempFile(
    fileName: string,
    contents: Buffer,
  ): Promise<string> {
    const directory = await makeTempDir('media-processor-test-', tempDirs);
    const filePath = path.join(directory, fileName);
    fs.writeFileSync(filePath, contents);
    return filePath;
  }

  async function createPdfFixture(): Promise<string> {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([200, 200]);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    page.setFont(font);
    page.setFontSize(12);
    page.drawText('Media processor PDF fixture', { x: 24, y: 100 });
    const pdfBytes = await pdfDoc.save();
    return createTempFile('fixture.pdf', Buffer.from(pdfBytes));
  }

  function createSilenceWavBuffer(durationMs = 250, sampleRate = 8000): Buffer {
    const bytesPerSample = 2; // 16-bit mono audio
    const sampleCount = Math.max(
      1,
      Math.floor((sampleRate * durationMs) / 1000),
    );
    const pcmData = Buffer.alloc(sampleCount * bytesPerSample);

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmData.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // Subchunk1Size for PCM
    header.writeUInt16LE(1, 20); // Audio format PCM
    header.writeUInt16LE(1, 22); // Mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * bytesPerSample, 28); // Byte rate
    header.writeUInt16LE(bytesPerSample, 32); // Block align
    header.writeUInt16LE(16, 34); // Bits per sample
    header.write('data', 36);
    header.writeUInt32LE(pcmData.length, 40);

    return Buffer.concat([header, pcmData]);
  }

  async function createAudioFixture(): Promise<string> {
    return createTempFile('fixture.wav', createSilenceWavBuffer());
  }

  async function createRawAudioFixture(extension: string): Promise<string> {
    return createTempFile(`fixture${extension}`, Buffer.alloc(128));
  }

  async function createEmptyFixture(): Promise<string> {
    return createTempFile('empty.bin', Buffer.alloc(0));
  }

  function expectAudioResult(
    results: MediaFileResult[],
    displayPath: string,
    mimeType: string,
    sourcePath: string,
  ): void {
    assert.deepEqual(results, [
      {
        path: displayPath,
        ok: true,
        media: {
          kind: 'audio',
          mimeType,
          sizeBytes: fs.statSync(sourcePath).size,
        },
      },
    ]);
  }

  function expectAudioEntry(entry: MediaEntry, sourcePath: string): void {
    assert.equal(entry.media_category, 'audio');
    assert.equal(entry.source_path, sourcePath);
    assert.equal(entry.bytes_match_source, true);
    assert.ok(entry.data.length > 0, 'Audio data should be base64 encoded');
  }

  it('processes PDF fixtures using native ingestion when supported', async () => {
    const pdfPath = await createPdfFixture();
    const pdfLocation = pathToLocation(pdfPath);
    const displayPath = fileLocationDisplayPath(pdfLocation);
    const stub = createMediaLogRecorder();
    const processor = createProcessor(stub, {
      supportsVision: true,
      supportsNativePdf: true,
    });

    const { entries, results } = await processor.loadEntries([pdfLocation]);

    assert.deepEqual(results, [
      {
        path: displayPath,
        ok: true,
        media: {
          kind: 'image',
          mimeType: 'application/pdf',
          sizeBytes: fs.statSync(pdfPath).size,
        },
      },
    ]);
    assert.equal(
      displayPath,
      pdfPath,
      'external media keeps its absolute path',
    );
    assert.equal(entries.length, 1, 'expected a single PDF entry');

    const [entry] = entries;
    assert.equal(entry.media_type, 'application/pdf');
    assert.equal(entry.media_category, 'image');
    assert.equal(entry.source_path, pdfPath);
    assert.equal(entry.bytes_match_source, true);
    assert.ok(entry.data.length > 0, 'PDF data should be base64 encoded');

    processor.logResults(results);
    assert.equal(stub.fileListEntries.length, 1, 'should log processed PDF');
    assert.equal(
      stub.warnMessages.length,
      0,
      'no warnings expected for valid PDF',
    );
  });

  it('processes native audio fixtures into audio media entries', async () => {
    const audioPath = await createAudioFixture();
    const audioLocation = pathToLocation(audioPath);
    const stub = createMediaLogRecorder();
    const processor = createProcessor(
      stub,
      {
        supportsNativeAudio: true,
      },
      false,
    );

    const { entries, results } = await processor.loadEntries([audioLocation]);

    expectAudioResult(
      results,
      fileLocationDisplayPath(audioLocation),
      'audio/wav',
      audioPath,
    );
    assert.equal(entries.length, 1, 'expected a single audio entry');

    const [entry] = entries;
    expectAudioEntry(entry, audioPath);
    assert.ok(entry.media_type.startsWith('audio/'));

    processor.logResults(results);
    assert.equal(stub.fileListEntries.length, 1, 'should log processed audio');
  });

  it('keeps loaded workspace media relative in its typed result', async () => {
    const relativePath = 'documents/workspace.pdf';
    const mediaPath = await createPdfFixture();
    const sizeBytes = fs.statSync(mediaPath).size;
    const location = {
      kind: 'workspace',
      absolutePath: mediaPath,
      relativePath,
    } as const;
    const stub = createMediaLogRecorder();
    const processor = createProcessor(stub, {
      supportsVision: true,
      supportsNativePdf: true,
    });

    const { results } = await processor.loadEntries([location]);

    assert.deepEqual(stub.errorMessages, []);
    assert.deepEqual(results, [
      {
        path: relativePath,
        ok: true,
        media: {
          kind: 'image',
          mimeType: 'application/pdf',
          sizeBytes,
        },
      },
    ]);
  });

  it.each([
    ['.opus', 'audio/opus'],
    ['.l16', 'audio/l16'],
    ['.alaw', 'audio/alaw'],
    ['.mulaw', 'audio/mulaw'],
  ] as const)(
    'processes %s audio with provider-supported MIME type',
    async (extension, mediaType) => {
      const audioPath = await createRawAudioFixture(extension);
      const audioLocation = pathToLocation(audioPath);
      const stub = createMediaLogRecorder();
      const processor = createProcessor(
        stub,
        {
          supportsNativeAudio: true,
        },
        false,
      );

      const { entries, results } = await processor.loadEntries([audioLocation]);

      expectAudioResult(
        results,
        fileLocationDisplayPath(audioLocation),
        mediaType,
        audioPath,
      );
      assert.equal(entries.length, 1, 'expected a single audio entry');

      const [entry] = entries;
      expectAudioEntry(entry, audioPath);
      assert.equal(entry.media_type, mediaType);
    },
  );

  it('reports empty media fixtures as failed loads', async () => {
    const emptyPath = await createEmptyFixture();
    const emptyLocation = pathToLocation(emptyPath);
    const displayPath = fileLocationDisplayPath(emptyLocation);
    const stub = createMediaLogRecorder();
    const processor = createProcessor(stub, { supportsVision: true });

    const { entries, results } = await processor.loadEntries([emptyLocation]);

    assert.equal(entries.length, 0, 'empty files should not yield entries');
    assert.deepEqual(results, [{ path: displayPath, ok: false }]);

    processor.logResults(results);
    assert.equal(stub.fileListEntries.length, 1, 'should log failed media');
    assert.deepEqual(
      stub.warnMessages,
      [
        `Skipping empty media file: ${displayPath}`,
        'Some media files failed to load',
      ],
      'should warn while loading and again when logging the failed batch',
    );
  });

  it('keeps SDK-specific media load errors in the visible log message', async () => {
    const mediaPath = await createTempFile(
      'sdk-error.png',
      Buffer.from('not-png'),
    );
    const mediaLocation = pathToLocation(mediaPath);
    const displayPath = fileLocationDisplayPath(mediaLocation);
    const stub = createMediaLogRecorder();
    const processor = createProcessor(stub, { supportsVision: true });
    const fsBackedExists = absoluteFsAny.exists;

    const error = new Error('plain fallback');
    attachProviderError(error, {
      message: 'HTTP 429 Too Many Requests - provider body',
      provider: 'openai',
      statusCode: 429,
      statusText: 'Too Many Requests',
      userRetryable: true,
    });

    absoluteFsAny.exists = async () => {
      throw error;
    };

    try {
      const { entries, results } = await processor.loadEntries([mediaLocation]);

      assert.equal(entries.length, 0);
      assert.deepEqual(results, [{ path: displayPath, ok: false }]);
      assert.equal(stub.errorMessages.length, 1);
      assert.match(
        stub.errorMessages[0] ?? '',
        /HTTP 429 Too Many Requests - provider body/,
      );
    } finally {
      absoluteFsAny.exists = fsBackedExists;
    }
  });
});
