// Node imports
import { Buffer } from 'node:buffer';
import * as fs from 'node:fs';
import * as os from 'node:os';
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
import { attachProviderError } from '@common/errors/sdkErrorUtils';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { setupPlatform } from '@test/support/setupPlatform';
import { AbsoluteFS, pathToLocation, getShortDisplayPath } from '@utils/files';

interface MediaLogRecorder extends AgentTrace {
  debugMessages: string[];
  warnMessages: string[];
  errorMessages: string[];
  fileListEntries: MediaFileResult[][];
}

function createMediaLogRecorder(): {
  logger: AgentTrace;
  stub: MediaLogRecorder;
} {
  const stub: MediaLogRecorder = {
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

  return { logger: stub, stub };
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

  afterAll(() => {
    absoluteFsAny.exists = originalExists;
    absoluteFsAny.stat = originalStat;
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

  function createTempFile(fileName: string, contents: Buffer): string {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'media-processor-test-'),
    );
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

  function createAudioFixture(): string {
    return createTempFile('fixture.wav', createSilenceWavBuffer());
  }

  function createRawAudioFixture(extension: string): string {
    return createTempFile(`fixture${extension}`, Buffer.alloc(128));
  }

  function createEmptyFixture(): string {
    return createTempFile('empty.bin', Buffer.alloc(0));
  }

  it('processes PDF fixtures using native ingestion when supported', async () => {
    const pdfPath = await createPdfFixture();
    const pdfLocation = pathToLocation(pdfPath);
    const displayPath = getShortDisplayPath(pdfLocation);
    const { logger, stub } = createMediaLogRecorder();
    const processor = createProcessor(logger, {
      supportsVision: true,
      supportsNativePdf: true,
    });

    const { entries, results } = await processor.loadEntries([pdfLocation]);

    assert.deepEqual(results, [{ path: displayPath, ok: true }]);
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
    const audioPath = createAudioFixture();
    const audioLocation = pathToLocation(audioPath);
    const displayPath = getShortDisplayPath(audioLocation);
    const { logger, stub } = createMediaLogRecorder();
    const processor = createProcessor(
      logger,
      {
        supportsNativeAudio: true,
      },
      false,
    );

    const { entries, results } = await processor.loadEntries([audioLocation]);

    assert.deepEqual(results, [{ path: displayPath, ok: true }]);
    assert.equal(entries.length, 1, 'expected a single audio entry');

    const [entry] = entries;
    assert.equal(entry.media_category, 'audio');
    assert.ok(entry.media_type.startsWith('audio/'));
    assert.equal(entry.source_path, audioPath);
    assert.equal(entry.bytes_match_source, true);
    assert.ok(entry.data.length > 0, 'Audio data should be base64 encoded');

    processor.logResults(results);
    assert.equal(stub.fileListEntries.length, 1, 'should log processed audio');
  });

  for (const [extension, mediaType] of [
    ['.opus', 'audio/opus'],
    ['.l16', 'audio/l16'],
    ['.alaw', 'audio/alaw'],
    ['.mulaw', 'audio/mulaw'],
  ] as const) {
    it(`processes ${extension} audio with provider-supported MIME type`, async () => {
      const audioPath = createRawAudioFixture(extension);
      const audioLocation = pathToLocation(audioPath);
      const displayPath = getShortDisplayPath(audioLocation);
      const { logger } = createMediaLogRecorder();
      const processor = createProcessor(
        logger,
        {
          supportsNativeAudio: true,
        },
        false,
      );

      const { entries, results } = await processor.loadEntries([audioLocation]);

      assert.deepEqual(results, [{ path: displayPath, ok: true }]);
      assert.equal(entries.length, 1, 'expected a single audio entry');

      const [entry] = entries;
      assert.equal(entry.media_category, 'audio');
      assert.equal(entry.media_type, mediaType);
      assert.equal(entry.source_path, audioPath);
      assert.equal(entry.bytes_match_source, true);
      assert.ok(entry.data.length > 0, 'Audio data should be base64 encoded');
    });
  }

  it('reports empty media fixtures as failed loads', async () => {
    const emptyPath = createEmptyFixture();
    const emptyLocation = pathToLocation(emptyPath);
    const displayPath = getShortDisplayPath(emptyLocation);
    const { logger, stub } = createMediaLogRecorder();
    const processor = createProcessor(logger, { supportsVision: true });

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
    const mediaPath = createTempFile('sdk-error.png', Buffer.from('not-png'));
    const mediaLocation = pathToLocation(mediaPath);
    const displayPath = getShortDisplayPath(mediaLocation);
    const { logger, stub } = createMediaLogRecorder();
    const processor = createProcessor(logger, { supportsVision: true });
    const originalExists = absoluteFsAny.exists;

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
      absoluteFsAny.exists = originalExists;
    }
  });
});
