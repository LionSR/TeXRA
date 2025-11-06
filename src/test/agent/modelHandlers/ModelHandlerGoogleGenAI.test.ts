// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import type {
  File,
  Part,
  UploadFileParameters,
  FunctionCall,
  Content,
} from '@google/genai';
import {
  createPartFromBase64,
  createPartFromText,
  createPartFromUri,
} from '@google/genai';

// Local imports - agent
import {
  ModelHandlerGoogleGenAI,
  convertMessagesToGoogleContentHistory,
} from '@agent/modelHandlers/modelHandlerGoogleGenAI';
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
    withCurrentGroup: () => undefined,
    runWithinCurrentGroup: async (fn: () => any) => fn(),
    runWithGroup: async (_groupId: string | undefined, fn: () => any) => fn(),
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
  it('creates inline parts when base64 media is provided', async () => {
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

    assert.equal(uploadCalls.length, 0, 'should not invoke files.upload');
    assert.deepEqual(parts, [
      createPartFromBase64(entry.data, 'application/pdf'),
    ]);
  });

  it('does not emit duplicate fileList logs for inline attachments', async () => {
    const clientStub = {
      files: {
        upload: async () => {
          throw new Error('upload should not be called for inline payloads');
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
    };

    await handler.invokeUpload([entry]);

    assert.equal(
      stub.fileListEntries.length,
      0,
      'uploadMediaEntries should not emit fileList logs',
    );
  });

  it('falls back to files.upload when inline payload exceeds the configured limit', async () => {
    const uploadCalls: UploadFileParameters[] = [];
    const clientStub = {
      files: {
        upload: async (params: UploadFileParameters) => {
          uploadCalls.push(params);
          return {
            name: 'files/large',
            uri: 'files/large',
            mimeType: params.config?.mimeType ?? 'application/pdf',
            displayName: params.config?.displayName ?? 'large.pdf',
          } satisfies Partial<File> as File;
        },
      },
    };

    class LimitedInlineHandler extends GoogleHandlerTestDouble {
      protected override getInlineUploadLimitBytes(): number {
        return 1;
      }
    }

    const handler = new LimitedInlineHandler(buildGoogleConfig(), clientStub);
    const { logger } = createLoggerStub();
    handler.setLogger(logger);

    const oversized = Buffer.from([0, 1]).toString('base64');
    const entry: MediaEntry = {
      file_name: 'large.pdf',
      data: oversized,
      media_type: 'application/pdf',
      media_category: 'image',
      source_path: '/tmp/large.pdf',
    };

    const parts = await handler.invokeUpload([entry]);

    assert.equal(uploadCalls.length, 1, 'should invoke files.upload once');
    assert.deepEqual(parts, [
      createPartFromUri('files/large', 'application/pdf'),
    ]);
  });

  it('builds media entries once and delegates upload inside createMediaMessage', async () => {
    const uploadedEntries: MediaEntry[][] = [];
    const loadCalls: string[][] = [];
    const loggedResults: Array<Array<{ path: string; ok: boolean }>> = [];

    class RecordingHandler extends ModelHandlerGoogleGenAI {
      constructor(config: ModelConfig) {
        super(config);
      }

      override async getClient(): Promise<any> {
        throw new Error('getClient should not be called in this test');
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

    const handlerMediaProcessor = handler as unknown as {
      mediaProcessor: {
        loadEntries: (mediaFiles: string[]) => Promise<{
          entries: MediaEntry[];
          results: Array<{ path: string; ok: boolean }>;
        }>;
        logResults: (results: Array<{ path: string; ok: boolean }>) => void;
      };
    };
    const originalLoadEntries =
      handlerMediaProcessor.mediaProcessor.loadEntries.bind(
        handlerMediaProcessor.mediaProcessor,
      );
    const originalLogResults =
      handlerMediaProcessor.mediaProcessor.logResults.bind(
        handlerMediaProcessor.mediaProcessor,
      );

    handlerMediaProcessor.mediaProcessor.loadEntries = async (
      mediaFiles: string[],
    ) => {
      loadCalls.push(mediaFiles);
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
    };

    handlerMediaProcessor.mediaProcessor.logResults = (results) => {
      loggedResults.push(results);
      originalLogResults(results);
    };

    const parts = await handler.createMediaMessage(['doc.pdf']);

    assert.deepEqual(loadCalls, [['doc.pdf']]);
    assert.deepEqual(parts, [
      createPartFromUri('files/doc', 'application/pdf'),
    ]);
    assert.equal(uploadedEntries.length, 1, 'uploads should run once');
    assert.equal(uploadedEntries[0][0].file_name, 'doc.pdf');
    assert.equal(stub.fileListEntries.length, 1, 'should log processed media');
    assert.deepEqual(loggedResults, [[{ path: 'doc.pdf', ok: true }]]);

    handlerMediaProcessor.mediaProcessor.loadEntries = originalLoadEntries;
    handlerMediaProcessor.mediaProcessor.logResults = originalLogResults;
  });
});

describe('convertMessagesToGoogleContentHistory', () => {
  it('groups consecutive turns using SDK helpers', () => {
    const { logger } = createLoggerStub();
    const messages: Content[] = [
      { role: 'user', parts: [createPartFromText('first')] },
      { role: 'user', parts: [createPartFromText('second')] },
      { role: 'model', parts: [createPartFromText('reply one')] },
      { role: 'model', parts: [createPartFromText('reply two')] },
    ];

    const history = convertMessagesToGoogleContentHistory(messages, logger);

    assert.equal(history.length, 2, 'user and model messages should merge');
    assert.equal(history[0].role, 'user');
    const userParts = history[0].parts ?? [];
    assert.equal(userParts.length, 2);
    assert.equal((userParts[0] as Part & { text: string }).text, 'first');
    assert.equal((userParts[1] as Part & { text: string }).text, 'second');

    assert.equal(history[1].role, 'model');
    const modelParts = history[1].parts ?? [];
    assert.equal(modelParts.length, 2);
    assert.equal((modelParts[0] as Part & { text: string }).text, 'reply one');
    assert.equal((modelParts[1] as Part & { text: string }).text, 'reply two');
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
