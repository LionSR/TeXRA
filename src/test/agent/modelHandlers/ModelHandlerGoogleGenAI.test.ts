// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import type {
  File,
  Part,
  UploadFileParameters,
  FunctionCall,
} from '@google/genai';
import { createPartFromUri } from '@google/genai';

// Local imports - agent
import { ModelHandlerGoogleGenAI } from '@agent/modelHandlers/modelHandlerGoogleGenAI';
import { MediaEntry } from '@agent/utils/mediaTypes';
import type { AgentLogger } from '@logger/AgentLogger';

// Local imports - model config
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelCapabilities,
  ModelConfig,
  ModelProvider,
} from '@model/ModelConfig';

interface LoggerStub extends Partial<AgentLogger> {
  channelId: string;
  fileListEntries: Array<Array<{ path: string; ok: boolean }>>;
}

function createLoggerStub(): { logger: AgentLogger; stub: LoggerStub } {
  const stub: LoggerStub = {
    channelId: 'test-channel',
    fileListEntries: [],
    debug: () => {
      /* no-op for tests */
    },
    info: () => {
      /* no-op for tests */
    },
    warn: () => {
      /* no-op for tests */
    },
    error: () => {
      /* no-op for tests */
    },
    fileList(entries: Array<{ path: string; ok: boolean }>) {
      this.fileListEntries.push(entries);
    },
    getActiveGroupId: () => undefined,
  };

  return { logger: stub as unknown as AgentLogger, stub };
}

function buildGoogleConfig(
  overrides: Partial<ModelCapabilities> = {},
): ModelConfig {
  const capabilities: ModelCapabilities = {
    ...DEFAULT_MODEL_CAPABILITIES,
    supportsVision: true,
    supportsNativePdf: true,
    ...overrides,
  };

  return {
    name: 'test-google',
    fullName: 'test-google',
    provider: ModelProvider.GOOGLE,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 100000,
    capabilities,
    openRouterOnly: false,
  };
}

class GoogleHandlerTestDouble extends ModelHandlerGoogleGenAI {
  constructor(
    config: ModelConfig,
    private readonly clientStub: any,
  ) {
    super(config);
  }

  override async getClient(): Promise<any> {
    return this.clientStub;
  }

  async invokeUpload(entries: MediaEntry[]): Promise<Part[]> {
    return this.uploadMediaEntries(entries);
  }
}

describe('ModelHandlerGoogleGenAI media uploads', () => {
  it('uploads MediaEntry instances via files.upload using file paths when available', async () => {
    const uploadCalls: UploadFileParameters[] = [];

    const clientStub = {
      files: {
        upload: async (params: UploadFileParameters) => {
          uploadCalls.push(params);
          return {
            name: 'files/test-file',
            uri: 'files/test-file',
            mimeType: params.config?.mimeType ?? 'application/pdf',
            displayName: params.config?.displayName ?? 'test.pdf',
          };
        },
      },
    };

    const handler = new GoogleHandlerTestDouble(
      buildGoogleConfig(),
      clientStub,
    );
    const { logger } = createLoggerStub();
    handler.setLogger(logger);

    const entry: MediaEntry = {
      file_name: 'sample.pdf',
      data: Buffer.from('%PDF-1.7').toString('base64'),
      media_type: 'application/pdf',
      media_category: 'image',
      source_path: '/tmp/sample.pdf',
    };

    const parts = await handler.invokeUpload([entry]);

    assert.equal(uploadCalls.length, 1, 'should invoke files.upload once');
    const [uploadParams] = uploadCalls;
    assert.equal(
      uploadParams.file,
      '/tmp/sample.pdf',
      'file payload should reference the source path',
    );
    assert.equal(uploadParams.config?.mimeType, 'application/pdf');
    assert.equal(uploadParams.config?.displayName, 'sample.pdf');

    assert.deepEqual(parts, [
      createPartFromUri('files/test-file', 'application/pdf'),
    ]);
  });

  it('does not emit duplicate fileList logs while uploading media', async () => {
    const clientStub = {
      files: {
        upload: async (params: UploadFileParameters) => {
          return {
            name: 'files/test-file',
            uri: 'files/test-file',
            mimeType: params.config?.mimeType ?? 'application/pdf',
            displayName: params.config?.displayName ?? 'test.pdf',
          } satisfies Partial<File> as File;
        },
      },
    };

    const handler = new GoogleHandlerTestDouble(
      buildGoogleConfig(),
      clientStub,
    );
    const { logger, stub } = createLoggerStub();
    handler.setLogger(logger);

    const entry: MediaEntry = {
      file_name: 'sample.pdf',
      data: Buffer.from('%PDF-1.7').toString('base64'),
      media_type: 'application/pdf',
      media_category: 'image',
      source_path: '/tmp/sample.pdf',
    };

    await handler.invokeUpload([entry]);

    assert.equal(
      stub.fileListEntries.length,
      0,
      'uploadMediaEntries should not emit fileList logs',
    );
  });

  it('prefers binary payloads when provided on media entries', async () => {
    let uploadInvocationCount = 0;
    const clientStub = {
      files: {
        upload: async (params: UploadFileParameters) => {
          uploadInvocationCount += 1;
          return {
            name: 'files/audio',
            uri: 'files/audio',
            mimeType: params.config?.mimeType ?? 'audio/wav',
            displayName: params.config?.displayName ?? 'audio.wav',
          } satisfies Partial<File> as File;
        },
      },
    };

    const handler = new GoogleHandlerTestDouble(
      buildGoogleConfig({ supportsNativeAudio: true }),
      clientStub,
    );
    const { logger } = createLoggerStub();
    handler.setLogger(logger);

    const binaryPayload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const entry: MediaEntry = {
      file_name: 'audio.wav',
      data: 'not-valid-base64',
      media_type: 'audio/wav',
      media_category: 'audio',
      binary_data: binaryPayload,
    };

    const parts = await handler.invokeUpload([entry]);

    assert.equal(uploadInvocationCount, 1, 'should still upload once');
    assert.deepEqual(parts, [createPartFromUri('files/audio', 'audio/wav')]);
  });

  it('ignores source paths when bytes no longer match the encoded payload', async () => {
    const uploadCalls: UploadFileParameters[] = [];

    const clientStub = {
      files: {
        upload: async (params: UploadFileParameters) => {
          uploadCalls.push(params);
          return {
            name: 'files/converted',
            uri: 'files/converted',
            mimeType: params.config?.mimeType ?? 'image/png',
            displayName: params.config?.displayName ?? 'converted.png',
          } satisfies Partial<File> as File;
        },
      },
    };

    const handler = new GoogleHandlerTestDouble(
      buildGoogleConfig({ supportsNativePdf: false }),
      clientStub,
    );
    const { logger } = createLoggerStub();
    handler.setLogger(logger);

    const pngPayload = Buffer.from([0, 1, 2, 3]).toString('base64');
    const entry: MediaEntry = {
      file_name: 'converted_page_1',
      data: pngPayload,
      media_type: 'image/png',
      media_category: 'image',
      source_path: '/tmp/original.pdf',
      bytes_match_source: false,
    };

    const parts = await handler.invokeUpload([entry]);

    assert.equal(uploadCalls.length, 1, 'should invoke files.upload once');
    const [uploadParams] = uploadCalls;
    assert.ok(
      uploadParams.file instanceof globalThis.Blob,
      'file payload should be uploaded from memory instead of the stale path',
    );

    assert.deepEqual(parts, [
      createPartFromUri('files/converted', 'image/png'),
    ]);
  });

  it('falls back to Blob payloads when media entries only contain encoded data', async () => {
    const uploadCalls: UploadFileParameters[] = [];

    const clientStub = {
      files: {
        upload: async (params: UploadFileParameters) => {
          uploadCalls.push(params);
          return {
            name: 'files/base64',
            uri: 'files/base64',
            mimeType: params.config?.mimeType ?? 'application/pdf',
            displayName: params.config?.displayName ?? 'fallback.pdf',
          } satisfies Partial<File> as File;
        },
      },
    };

    const handler = new GoogleHandlerTestDouble(
      buildGoogleConfig(),
      clientStub,
    );
    const { logger } = createLoggerStub();
    handler.setLogger(logger);

    const entry: MediaEntry = {
      file_name: 'no-path.pdf',
      data: Buffer.from('%PDF-1.5').toString('base64'),
      media_type: 'application/pdf',
      media_category: 'image',
    };

    const parts = await handler.invokeUpload([entry]);

    assert.equal(uploadCalls.length, 1, 'should invoke files.upload once');
    const [uploadParams] = uploadCalls;
    assert.ok(
      uploadParams.file instanceof globalThis.Blob,
      'file payload should be a Blob when no file path is provided',
    );

    assert.deepEqual(parts, [
      createPartFromUri('files/base64', 'application/pdf'),
    ]);
  });

  it('builds media entries once and delegates upload inside createMediaMessage', async () => {
    const uploadedEntries: MediaEntry[][] = [];
    const buildCalls: string[][] = [];

    class RecordingHandler extends ModelHandlerGoogleGenAI {
      constructor(config: ModelConfig) {
        super(config);
      }

      override async getClient(): Promise<any> {
        throw new Error('getClient should not be called in this test');
      }

      override async buildMediaEntries(mediaFiles: string[]): Promise<{
        entries: MediaEntry[];
        results: Array<{ path: string; ok: boolean }>;
      }> {
        buildCalls.push(mediaFiles);
        return {
          entries: [
            {
              file_name: 'doc.pdf',
              data: Buffer.from('%PDF-1.4').toString('base64'),
              media_type: 'application/pdf',
              media_category: 'image',
              binary_data: Buffer.from('%PDF-1.4'),
            },
          ],
          results: [{ path: 'doc.pdf', ok: true }],
        };
      }

      override async uploadMediaEntries(
        entries: MediaEntry[],
      ): Promise<Part[]> {
        uploadedEntries.push(entries);
        return [createPartFromUri('files/doc', 'application/pdf')];
      }
    }

    const handler = new RecordingHandler(buildGoogleConfig());
    const { logger, stub } = createLoggerStub();
    handler.setLogger(logger);

    const parts = await handler.createMediaMessage(['doc.pdf']);

    assert.deepEqual(parts, [
      createPartFromUri('files/doc', 'application/pdf'),
    ]);
    assert.deepEqual(buildCalls, [['doc.pdf']]);
    assert.equal(uploadedEntries.length, 1, 'uploads should run once');
    assert.equal(uploadedEntries[0][0].file_name, 'doc.pdf');
    assert.equal(stub.fileListEntries.length, 1, 'should log processed media');
  });
});

describe('ModelHandlerGoogleGenAI tool attachments', () => {
  it('appends tool attachments as inline data parts', async () => {
    const handler = new ModelHandlerGoogleGenAI(buildGoogleConfig());
    const { logger } = createLoggerStub();
    handler.setLogger(logger);

    const attachmentBytes = new Uint8Array([1, 2, 3, 4]);
    const toolResult: Record<string, unknown> = {
      output: 'generated figures',
      files: [
        {
          path: 'figures/plot.png',
          mimeType: 'image/png',
          bytes: attachmentBytes,
          description: 'Plot preview',
        },
      ],
    };

    const functionCall: FunctionCall = {
      name: 'extract_figures',
      args: { source: 'doc.tex' },
    };

    const messages = await handler.createToolUseFollowUpMessages(
      undefined,
      'call-123',
      'extract_figures',
      functionCall,
      toolResult,
    );

    assert.equal(
      messages.length,
      2,
      'should produce call and response messages',
    );

    const responseParts = messages[1].parts ?? [];
    assert.equal(
      responseParts.length,
      2,
      'response should contain function response and attachment parts',
    );
    const [responsePart, attachmentPart] = responseParts;

    const functionResponse = responsePart.functionResponse;
    assert(
      functionResponse,
      'response part should include functionResponse payload',
    );

    const sanitizedResponse = functionResponse.response as Record<
      string,
      unknown
    >;
    const attachmentSummary = sanitizedResponse.attachmentSummary as string;
    assert(
      attachmentSummary,
      'attachment summary should be present on sanitized response',
    );
    assert(!attachmentSummary.includes('read_file'));

    const files = sanitizedResponse.files as Array<Record<string, unknown>>;
    assert.deepEqual(files, [
      {
        path: 'figures/plot.png',
        mimeType: 'image/png',
        description: 'Plot preview',
      },
    ]);

    assert(
      !functionResponse?.parts,
      'function response should not embed parts',
    );

    assert.equal(attachmentPart.inlineData?.mimeType, 'image/png');
    assert.equal(
      attachmentPart.inlineData?.data,
      Buffer.from(attachmentBytes).toString('base64'),
    );
  });
});
