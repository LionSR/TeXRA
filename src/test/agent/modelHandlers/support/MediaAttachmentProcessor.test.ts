// Standard library imports
import { Buffer } from 'buffer';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { strict as assert } from 'assert';

// Third-party imports
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';

// Local imports - agent
import {
  MediaAttachmentProcessor,
  type MediaFileResult,
} from '@agent/modelHandlers/support/MediaAttachmentProcessor';
import type { AgentLogger } from '@logger/AgentLogger';
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelCapabilities,
} from '@model/ModelConfig';
import { AbsoluteFS } from '@utils/files';

interface LoggerStub extends Partial<AgentLogger> {
  channelId: string;
  debugMessages: string[];
  warnMessages: string[];
  errorMessages: string[];
  fileListEntries: MediaFileResult[][];
}

function createLoggerStub(): { logger: AgentLogger; stub: LoggerStub } {
  const stub: LoggerStub = {
    channelId: 'media-test',
    debugMessages: [],
    warnMessages: [],
    errorMessages: [],
    fileListEntries: [],
    debug(message: string) {
      this.debugMessages.push(message);
    },
    info: () => {
      /* no-op */
    },
    warn(message: string) {
      this.warnMessages.push(message);
    },
    error(message: string) {
      this.errorMessages.push(message);
    },
    fileList(entries: MediaFileResult[]) {
      this.fileListEntries.push(entries);
    },
    getActiveGroupId: () => undefined,
  };

  return { logger: stub as unknown as AgentLogger, stub };
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

  before(() => {
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

  after(() => {
    absoluteFsAny.exists = originalExists;
    absoluteFsAny.stat = originalStat;
  });

  function createProcessor(
    logger: AgentLogger,
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

  function createEmptyFixture(): string {
    return createTempFile('empty.bin', Buffer.alloc(0));
  }

  it('processes PDF fixtures using native ingestion when supported', async () => {
    const pdfPath = await createPdfFixture();
    const { logger, stub } = createLoggerStub();
    const processor = createProcessor(logger, {
      supportsVision: true,
      supportsNativePdf: true,
    });

    const { entries, results } = await processor.loadEntries([pdfPath]);

    assert.deepEqual(results, [{ path: pdfPath, ok: true }]);
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
    const { logger, stub } = createLoggerStub();
    const processor = createProcessor(
      logger,
      {
        supportsNativeAudio: true,
      },
      false,
    );

    const { entries, results } = await processor.loadEntries([audioPath]);

    assert.deepEqual(results, [{ path: audioPath, ok: true }]);
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

  it('reports empty media fixtures as failed loads', async () => {
    const emptyPath = createEmptyFixture();
    const { logger, stub } = createLoggerStub();
    const processor = createProcessor(logger, { supportsVision: true });

    const { entries, results } = await processor.loadEntries([emptyPath]);

    assert.equal(entries.length, 0, 'empty files should not yield entries');
    assert.deepEqual(results, [{ path: emptyPath, ok: false }]);

    processor.logResults(results);
    assert.equal(stub.fileListEntries.length, 1, 'should log failed media');
    assert.equal(stub.warnMessages.length, 1, 'should warn about failed media');
  });
});
