// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import {
  createPartFromBase64,
  createPartFromText,
  createPartFromUri,
  FinishReason,
  GenerateContentResponse,
  type Content,
  type File,
  type FunctionCall,
  type Part,
  type UploadFileParameters,
} from '@google/genai';
import { describe, expect, it } from 'vitest';
import { type ModelConfig, ModelProvider } from 'llm-zoo';

// Local imports
import { noopTrace, type AgentTrace } from '@agent/trace';
import type { AgentSetting } from '@agent/core/definition/AgentDataclass';
import { validateGoogleMessageHistory } from '@agent/modelHandlers/google/googleMessageHelpers';
import { ModelHandlerGoogleGenAI } from '@agent/modelHandlers/google/modelHandlerGoogleGenAI';
import { extractToolAttachments } from '@agent/core/tools/toolAttachmentExtraction';
import { MediaEntry } from '@agent/utils/mediaTypes';
import { detectPartialText } from '@common/errors/sdkErrorUtils';
import type { FileLocation } from '@shared/schemas';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { pathToLocation } from '@utils/files';

interface LogRecorder extends AgentTrace {
  fileListEntries: Array<Array<{ path: string; ok: boolean }>>;
  warnMessages: string[];
}

function createLogRecorder(): LogRecorder {
  return {
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
  handler.setLogger(createLogRecorder());
  return handler;
}

/**
 * A handler wired for `createResponse` tests: token counting off (no client
 * round-trip for a token count), a silent logger, and the streaming decision
 * pinned instead of read from configuration.
 */
function createGoogleGenAIHandlerForRequests(
  streaming: boolean,
): ModelHandlerGoogleGenAI {
  const handler = new ModelHandlerGoogleGenAI(
    buildTestModelConfig(GOOGLE_TEST_CONFIG, {
      capabilities: { supportsTokenCounting: false },
    }),
  );
  handler.setLogger({ ...noopTrace });
  handler.setOutputStreaming(streaming);
  (handler as any).getStreamingConfig = () => streaming;
  return handler;
}

/** A chat client whose stream yields the chunks produced by `chunks`. */
function createStreamingClient(chunks: () => AsyncGenerator<unknown>): any {
  return {
    chats: {
      create: () => ({
        sendMessageStream: async () => chunks(),
        sendMessage: async () => {
          throw new Error(
            'sendMessage should not be called when streaming is enabled',
          );
        },
      }),
    },
    models: {},
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

/** Forces every payload past the inline limit so uploads take the files API. */
class LimitedInlineHandler extends GoogleHandlerTestDouble {
  protected override getInlineUploadLimitBytes(): number {
    return 1;
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
    handler.setLogger(createLogRecorder());

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
    const recorder = createLogRecorder();
    handler.setLogger(recorder);

    const entry: MediaEntry = {
      file_name: 'sample.pdf',
      data: Buffer.from('%PDF-1.7').toString('base64'),
      media_type: 'application/pdf',
      media_category: 'image',
    };

    await handler.invokeUpload([entry]);

    assert.equal(
      recorder.fileListEntries.length,
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

    const handler = new LimitedInlineHandler(
      buildTestModelConfig(GOOGLE_TEST_CONFIG),
      clientStub,
    );
    handler.setLogger(createLogRecorder());

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

    const handler = new LimitedInlineHandler(
      buildTestModelConfig(GOOGLE_TEST_CONFIG),
      clientStub,
    );
    const recorder = createLogRecorder();
    handler.setLogger(recorder);

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
    assert.equal(recorder.warnMessages.length, 1);
    assert.match(recorder.warnMessages[0] ?? '', /large\.pdf/);
    assert.match(recorder.warnMessages[0] ?? '', /provider quota exhausted/);
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
    const recorder = createLogRecorder();
    handler.setLogger(recorder);

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
    assert.equal(
      recorder.fileListEntries.length,
      1,
      'should log processed media',
    );
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

describe('ModelHandlerGoogleGenAI streaming failure diagnostics', () => {
  it('retains partial text from a mid-stream failure', async () => {
    const handler = createGoogleGenAIHandlerForRequests(true);
    const failure = new Error('relay connection dropped mid-stream');
    const messages: Content[] = [
      { role: 'user', parts: [createPartFromText('Hi there')] },
    ];

    // The stream yields visible text, then fails as a dropped connection would
    // after content has already been produced.
    let caught: unknown;
    try {
      await handler.createResponse({
        client: createStreamingClient(async function* () {
          yield {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [createPartFromText('partial text before the drop')],
                },
              },
            ],
          };
          throw failure;
        }),
        messages,
        temperature: 0,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(failure);
    expect(detectPartialText(failure)).toBe('partial text before the drop');
  });
});

describe('ModelHandlerGoogleGenAI response extraction', () => {
  it('preserves trailing whitespace without duplicating an existing end tag', () => {
    const handler = createGoogleGenAIHandler();
    const response = new GenerateContentResponse();
    response.candidates = [
      {
        content: {
          role: 'model',
          parts: [createPartFromText('answer</documents>\n')],
        },
        finishReason: FinishReason.STOP,
      } as any,
    ];

    expect(handler.extractResponse(response, '</documents>').text).toBe(
      'answer</documents>\n',
    );
  });
});

describe('ModelHandlerGoogleGenAI.shouldContinue', () => {
  const handler = createGoogleGenAIHandler();

  // The end tag is now a fixed protocol constant (`</documents>`), not a
  // per-agent setting; `agentSetting` is unused by the base `shouldContinue`.
  const agentSetting = {} as AgentSetting;

  it('continues when FinishReason.MAX_TOKENS is returned without the end tag', () => {
    const shouldContinue = handler.shouldContinue(
      FinishReason.MAX_TOKENS,
      'partial output',
      agentSetting,
    );

    assert.equal(shouldContinue, true);
  });

  it('stops when the end tag is present even if FinishReason.MAX_TOKENS was returned', () => {
    const shouldContinue = handler.shouldContinue(
      FinishReason.MAX_TOKENS,
      'partial output</documents>',
      agentSetting,
    );

    assert.equal(shouldContinue, false);
  });

  it('does not continue when stop reason indicates a normal stop', () => {
    const shouldContinue = handler.shouldContinue(
      FinishReason.STOP,
      'partial output',
      agentSetting,
    );

    assert.equal(shouldContinue, false);
  });
});

describe('ModelHandlerGoogleGenAI.extractToolUse', () => {
  const handler = createGoogleGenAIHandler();

  it('returns the SDK-provided tool call identifier', () => {
    const response: any = {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  id: 'google-call-1',
                  name: 'read_file',
                  args: { path: 'syk_v5.tex' },
                },
              },
            ],
          },
        },
      ],
    };

    const [toolInfo] = handler.extractToolUse(response);
    assert.ok(toolInfo, 'expected tool info to be returned');

    assert.equal(toolInfo?.callId, 'google-call-1');
    assert.equal(toolInfo?.name, 'read_file');
    assert.deepEqual(toolInfo?.input, { path: 'syk_v5.tex' });
  });
});

describe('ModelHandlerGoogleGenAI.createToolUseFollowUpMessages', () => {
  const handler = createGoogleGenAIHandler();

  it('omits unsupported identifier fields on follow-up function call parts', async () => {
    const providerCall = {
      provider: 'google',
      callId: 'call-123',
      name: 'read_file',
      input: { path: 'syk_v5.tex' },
      raw: { id: 'call-123', name: 'read_file', args: { path: 'syk_v5.tex' } },
    } as const;

    const messages = await handler.createToolUseFollowUpMessages(
      undefined,
      providerCall,
      { status: 'executed' },
      [],
    );

    const callMessage = messages[0];
    assert.ok(Array.isArray(callMessage.parts), 'expected call message parts');
    const callPart = callMessage.parts.find((part) => part.functionCall);
    assert.ok(callPart, 'expected a function call part');
    const functionCall = (callPart as any).functionCall as Record<
      string,
      unknown
    >;
    assert.equal(functionCall.id, 'call-123');
    assert.equal('call_id' in functionCall, false);
    assert.equal('tool_call_id' in functionCall, false);
    assert.equal('tool_use_id' in functionCall, false);
  });
});

describe('ModelHandlerGoogleGenAI.createResponse aggregation', () => {
  // Identifier hygiene is enforced when parts are created (see the
  // createToolUseFollowUpMessages suite above): the handler only ever emits
  // the SDK-supported `id` field on function calls. createResponse therefore
  // forwards prior turns to the chat session unchanged, splitting off only
  // the final user message which is sent via sendMessage.
  it('forwards prior turns as chat history with SDK function-call ids intact', async () => {
    const handler = createGoogleGenAIHandlerForRequests(false);

    const capturedHistory: Content[][] = [];
    const fakeClient = {
      chats: {
        create: (params: any) => {
          capturedHistory.push(params.history);
          return {
            sendMessage: async () => new GenerateContentResponse(),
            sendMessageStream: async () => {
              throw new Error('streaming not expected in unit test');
            },
          };
        },
      },
      models: {},
    } as any;

    const messages: Content[] = [
      { role: 'user', parts: [createPartFromText('Hello')] },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'abc',
              name: 'ls',
              args: {},
            },
          },
        ],
      },
      { role: 'user', parts: [createPartFromText('Continue?')] },
    ];

    await handler.createResponse({
      client: fakeClient,
      messages,
      temperature: 0,
    });

    assert.equal(
      capturedHistory.length,
      1,
      'expected one chat history payload',
    );
    const history = capturedHistory[0];
    assert.ok(Array.isArray(history), 'expected captured history array');
    assert.deepEqual(
      history,
      messages.slice(0, -1),
      'history should contain all but the final user message, unchanged',
    );
    const modelEntry = history[1];
    const callPart = (modelEntry.parts as any[]).find(
      (part) => part && typeof part === 'object' && 'functionCall' in part,
    );
    assert.ok(callPart, 'expected function call part in model entry');
    const functionCall = (callPart as any).functionCall as Record<
      string,
      unknown
    >;
    assert.equal(functionCall.id, 'abc');
  });

  it('aggregates streamed chunks without relying on SDK response promises', async () => {
    const handler = createGoogleGenAIHandlerForRequests(true);

    const chunkOne = new GenerateContentResponse();
    chunkOne.candidates = [
      {
        content: {
          role: 'model',
          parts: [createPartFromText('Hello')],
        },
      } as any,
    ];
    const chunkTwo = new GenerateContentResponse();
    chunkTwo.candidates = [
      {
        content: {
          role: 'model',
          parts: [createPartFromText(' world')],
        },
        finishReason: FinishReason.STOP,
      } as any,
    ];
    chunkTwo.usageMetadata = {
      inputTokenCount: 1,
      outputTokenCount: 2,
      totalTokenCount: 3,
    } as any;

    const messages: Content[] = [
      { role: 'user', parts: [createPartFromText('Hi there')] },
    ];

    const response = await handler.createResponse({
      client: createStreamingClient(async function* () {
        yield chunkOne;
        yield chunkTwo;
      }),
      messages,
      temperature: 0,
    });

    assert.ok(response, 'expected a response to be returned');
    const candidate = response.response.candidates?.[0];
    assert.ok(candidate, 'expected a candidate in the aggregated response');
    assert.equal(
      candidate.content?.parts?.length,
      2,
      'expected both streamed parts to be present',
    );
    assert.equal(response.response.text, 'Hello world');
    assert.equal(candidate.finishReason, FinishReason.STOP);
    assert.deepEqual(response.response.usageMetadata, chunkTwo.usageMetadata);
  });

  it('concatenates automaticFunctionCallingHistory across streamed chunks', async () => {
    const handler = createGoogleGenAIHandlerForRequests(true);

    const chunkOne = new GenerateContentResponse();
    chunkOne.candidates = [
      {
        content: {
          role: 'model',
          parts: [createPartFromText('First')],
        },
      } as any,
    ];
    chunkOne.automaticFunctionCallingHistory = [{ name: 'callOne' } as any];

    const chunkTwo = new GenerateContentResponse();
    chunkTwo.candidates = [
      {
        content: {
          role: 'model',
          parts: [createPartFromText('Second')],
        },
      } as any,
    ];
    chunkTwo.automaticFunctionCallingHistory = [{ name: 'callTwo' } as any];

    const messages: Content[] = [
      { role: 'user', parts: [createPartFromText('Hi there')] },
    ];

    const response = await handler.createResponse({
      client: createStreamingClient(async function* () {
        yield chunkOne;
        yield chunkTwo;
      }),
      messages,
      temperature: 0,
    });

    assert.ok(response.response.automaticFunctionCallingHistory);
    assert.equal(response.response.automaticFunctionCallingHistory?.length, 2);
    assert.deepEqual(response.response.automaticFunctionCallingHistory?.[0], {
      name: 'callOne',
    });
    assert.deepEqual(response.response.automaticFunctionCallingHistory?.[1], {
      name: 'callTwo',
    });
  });
});
