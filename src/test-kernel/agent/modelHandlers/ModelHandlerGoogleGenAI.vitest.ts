// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import {
  createPartFromBase64,
  createPartFromText,
  createPartFromUri,
  type Content,
  type File,
  type FunctionCall,
  type Part,
  type UploadFileParameters,
} from '@google/genai';
import { describe, it } from 'vitest';
import { type ModelConfig, ModelProvider } from 'llm-zoo';

// Local imports - test support

// Local imports - agent
import { noopTrace, type AgentTrace } from '@agent/trace';
import { validateGoogleMessageHistory } from '@agent/modelHandlers/google/googleMessageHelpers';
import { ModelHandlerGoogleGenAI } from '@agent/modelHandlers/google/modelHandlerGoogleGenAI';
import { extractToolAttachments } from '@agent/core/tools/toolAttachmentExtraction';
import { MediaEntry } from '@agent/utils/mediaTypes';
import type { FileLocation } from '@shared/schemas';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

// Local imports - utilities
import { pathToLocation } from '@utils/files';

interface LogRecorder extends AgentTrace {
  fileListEntries: Array<Array<{ path: string; ok: boolean }>>;
  warnMessages: string[];
}

function createLogRecorder(): { logger: AgentTrace; stub: LogRecorder } {
  const stub: LogRecorder = {
    ...noopTrace,
    fileListEntries: [],
    warnMessages: [],
    warn(message: string) {
      this.warnMessages.push(message);
    },
    domain(event) {
      if (event.key === 'filesLoaded') {
        const data = event.data as {
          entries: Array<{ path: string; ok: boolean }>;
        };
        this.fileListEntries.push(data.entries);
      }
    },
  };

  return { logger: stub, stub };
}

const GOOGLE_TEST_CONFIG = Object.freeze({
  name: 'test-google',
  label: 'Test Google',
  fullName: 'test-google',
  shortName: 'test-google',
  provider: ModelProvider.GOOGLE,
  contextWindow: 100_000,
  capabilities: Object.freeze({
    supportsVision: true,
    supportsNativePdf: true,
  }),
});

function createGoogleGenAIHandler(): ModelHandlerGoogleGenAI {
  const handler = new ModelHandlerGoogleGenAI(
    buildTestModelConfig(GOOGLE_TEST_CONFIG),
  );
  const { logger } = createLogRecorder();
  handler.setLogger(logger);
  return handler;
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
      buildTestModelConfig(GOOGLE_TEST_CONFIG),
      clientStub,
    );
    const { logger } = createLogRecorder();
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
      buildTestModelConfig(GOOGLE_TEST_CONFIG),
      clientStub,
    );
    const { logger, stub } = createLogRecorder();
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

    const handler = new LimitedInlineHandler(
      buildTestModelConfig(GOOGLE_TEST_CONFIG),
      clientStub,
    );
    const { logger } = createLogRecorder();
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

  it('keeps Google upload failure details in the visible warning', async () => {
    const clientStub = {
      files: {
        upload: async () => {
          throw new Error('provider quota exhausted');
        },
      },
    };

    class LimitedInlineHandler extends GoogleHandlerTestDouble {
      protected override getInlineUploadLimitBytes(): number {
        return 1;
      }
    }

    const handler = new LimitedInlineHandler(
      buildTestModelConfig(GOOGLE_TEST_CONFIG),
      clientStub,
    );
    const { logger, stub } = createLogRecorder();
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

    assert.deepEqual(parts, []);
    assert.equal(stub.warnMessages.length, 1);
    assert.match(stub.warnMessages[0] ?? '', /large\.pdf/);
    assert.match(stub.warnMessages[0] ?? '', /provider quota exhausted/);
  });

  it('builds media entries once and delegates upload inside createMediaMessage', async () => {
    const uploadedEntries: MediaEntry[][] = [];
    const loadCalls: FileLocation[][] = [];
    const loggedResults: Array<Array<{ path: string; ok: boolean }>> = [];

    class RecordingHandler extends ModelHandlerGoogleGenAI {
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

    const handler = new RecordingHandler(
      buildTestModelConfig(GOOGLE_TEST_CONFIG),
    );
    const { logger, stub } = createLogRecorder();
    handler.setLogger(logger);

    const handlerMediaProcessor = handler as unknown as {
      mediaProcessor: {
        loadEntries: (mediaFiles: FileLocation[]) => Promise<{
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
      mediaFiles: FileLocation[],
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

    const docLocation = pathToLocation('/tmp/doc.pdf');
    const parts = await (
      handler as unknown as {
        createMediaMessage: (files: FileLocation[]) => Promise<Part[]>;
      }
    ).createMediaMessage([docLocation]);

    assert.equal(loadCalls.length, 1, 'loadEntries should be called once');
    assert.equal(loadCalls[0].length, 1, 'should pass one media file');
    assert.equal(loadCalls[0][0].absolutePath, '/tmp/doc.pdf');
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

describe('validateGoogleMessageHistory', () => {
  it('logs warning for consecutive same-role messages', () => {
    const warnings: string[] = [];
    const logger = {
      warn: (msg: string) => warnings.push(msg),
      debug: () => {},
    } as unknown as AgentTrace;

    const messages: Content[] = [
      { role: 'user', parts: [createPartFromText('first')] },
      { role: 'user', parts: [createPartFromText('second')] }, // consecutive
    ];

    validateGoogleMessageHistory(messages, logger);

    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('Consecutive user messages'));
  });

  it('does not warn for properly alternating messages', () => {
    const warnings: string[] = [];
    const logger = {
      warn: (msg: string) => warnings.push(msg),
      debug: () => {},
    } as unknown as AgentTrace;

    const messages: Content[] = [
      { role: 'user', parts: [createPartFromText('hello')] },
      { role: 'model', parts: [createPartFromText('hi')] },
      { role: 'user', parts: [createPartFromText('bye')] },
    ];

    validateGoogleMessageHistory(messages, logger);

    assert.equal(warnings.length, 0, 'should not warn for valid history');
  });
});

describe('ModelHandlerGoogleGenAI createUserFollowUpMessages', () => {
  it('merges with existing user message to maintain alternating turns', async () => {
    const handler = createGoogleGenAIHandler();

    // Start with messages ending in user (simulating after tool response)
    const messages: Content[] = [
      { role: 'user', parts: [createPartFromText('initial')] },
      { role: 'model', parts: [createPartFromText('model reply')] },
      { role: 'user', parts: [createPartFromText('tool response')] },
    ];

    await handler.createUserFollowUpMessages(messages, 'user instruction');

    // Should merge into existing user message, not create a new one
    assert.equal(messages.length, 3, 'should not add a new message');
    assert.equal(messages[2].role, 'user');
    const userParts = messages[2].parts ?? [];
    assert.equal(userParts.length, 2, 'should have merged parts');
    assert.equal(
      (userParts[0] as Part & { text: string }).text,
      'tool response',
    );
    assert.equal(
      (userParts[1] as Part & { text: string }).text,
      'user instruction',
    );
  });

  it('adds new user message when last message is model', async () => {
    const handler = createGoogleGenAIHandler();

    // Start with messages ending in model
    const messages: Content[] = [
      { role: 'user', parts: [createPartFromText('initial')] },
      { role: 'model', parts: [createPartFromText('model reply')] },
    ];

    await handler.createUserFollowUpMessages(messages, 'new user message');

    // Should add a new user message
    assert.equal(messages.length, 3, 'should add a new message');
    assert.equal(messages[2].role, 'user');
    const userParts = messages[2].parts ?? [];
    assert.equal(userParts.length, 1);
    assert.equal(
      (userParts[0] as Part & { text: string }).text,
      'new user message',
    );
  });
});

describe('ModelHandlerGoogleGenAI tool attachments', () => {
  it('embeds tool attachments as function response parts with inline data', async () => {
    const handler = createGoogleGenAIHandler();

    const attachmentBytes = new Uint8Array([1, 2, 3, 4]);
    const toolResult = {
      status: 'executed' as const,
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

    // Handlers receive the sanitized payload and extracted attachments —
    // binary data is stripped from the payload and carried separately.
    const { attachments, sanitizedResult } = extractToolAttachments(toolResult);
    assert.equal(attachments.length, 1, 'should extract one attachment');
    assert.deepEqual(
      sanitizedResult.files,
      [
        {
          path: 'figures/plot.png',
          mimeType: 'image/png',
          description: 'Plot preview',
        },
      ],
      'sanitized payload should keep file metadata without binary data',
    );

    const functionCall: FunctionCall = {
      name: 'extract_figures',
      args: { source: 'doc.tex' },
      id: 'call-123',
    };

    const providerCall = {
      provider: 'google',
      callId: functionCall.id!,
      name: functionCall.name!,
      input: functionCall.args,
      raw: functionCall,
    } as const;

    const messages = await handler.createToolUseFollowUpMessages(
      undefined,
      providerCall,
      sanitizedResult,
      attachments,
    );

    assert.equal(
      messages.length,
      2,
      'should produce call and response messages',
    );

    const responseParts = messages[1].parts ?? [];
    assert.equal(
      responseParts.length,
      1,
      'response should contain a single function response part',
    );
    const [responsePart] = responseParts;

    const functionResponse = responsePart.functionResponse;
    assert(
      functionResponse,
      'response part should include functionResponse payload',
    );
    assert.equal(functionResponse.id, 'call-123');
    assert.equal(functionResponse.name, 'extract_figures');

    const sanitizedResponse = functionResponse.response as Record<
      string,
      unknown
    >;
    const resultText = sanitizedResponse.result as string;
    assert(resultText.includes('generated figures'));
    assert(
      resultText.includes('Attachments included in this response:'),
      'attachment summary should be appended to the response text',
    );
    assert(resultText.includes('- figures/plot.png (image/png)'));
    assert(!resultText.includes('read_file'));

    const attachmentParts = functionResponse.parts ?? [];
    assert.equal(
      attachmentParts.length,
      1,
      'function response should embed the attachment as a native part',
    );
    assert.equal(attachmentParts[0].inlineData?.mimeType, 'image/png');
    assert.equal(
      attachmentParts[0].inlineData?.data,
      Buffer.from(attachmentBytes).toString('base64'),
    );
  });
});
