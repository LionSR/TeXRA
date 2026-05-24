// Standard library imports
import { strict as assert } from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';

// Local imports - agent
import type { AgentTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentCategory, AgentSettingSchema } from '@agent/core/AgentDataclass';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/modelHandlerOpenAIResponse';

// Type imports
import { pathToLocation } from '@utils/files';
import type { ResponseInputItem } from 'openai/resources/responses/responses';

type LoggerStub = Partial<AgentTrace> & {
  streamId: string;
};

function createLoggerStub(): LoggerStub {
  return {
    streamId: 'test-channel',
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
    domain: () => {
      /* no-op for tests */
    },
  };
}

function createConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: 'gpt-4.1',
    fullName: 'gpt-4.1',
    shortName: 'gpt-4.1',
    label: 'GPT 4.1',
    provider: ModelProvider.OPENAI,
    maxOutputTokens: overrides.maxOutputTokens ?? 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: overrides.contextWindow ?? 200000,
    capabilities: {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsReasoning: false,
      supportsVision: false,
      ...(overrides.capabilities ?? {}),
    },
    openRouterOnly: overrides.openRouterOnly ?? true,
  };
}

function createHandler(
  configOverrides: Partial<ModelConfig> = {},
): ModelHandlerOpenAIResponse {
  const handler = new ModelHandlerOpenAIResponse(createConfig(configOverrides));
  handler.setLogger(createLoggerStub() as unknown as AgentTrace);
  handler.getStreamingConfig = () => false;
  return handler;
}

function createResponse(id: string, usage?: { input_tokens: number }) {
  return {
    id,
    status: 'completed',
    output: [],
    output_text: 'ok',
    usage,
  };
}

function createMessages(count: number): ResponseInputItem[] {
  return Array.from({ length: count }, (_, index) => ({
    role: 'user',
    content: `message ${index + 1}`,
  })) as ResponseInputItem[];
}

describe('ModelHandlerOpenAIResponse.createResponse', () => {
  it('rejects concurrent calls on the same handler instance', async () => {
    const handler = createHandler();
    let resolveCreate: (response: any) => void = () => undefined;
    const firstResponse = new Promise<any>((resolve) => {
      resolveCreate = resolve;
    });
    const client = {
      responses: {
        create: () => firstResponse,
      },
    };

    const firstCall = handler.createResponse({
      client: client as any,
      messages: createMessages(1),
      temperature: 0,
    });

    await assert.rejects(
      handler.createResponse({
        client: client as any,
        messages: createMessages(1),
        temperature: 0,
      }),
      /single-turn per instance/,
    );

    resolveCreate(createResponse('resp-1', { input_tokens: 12 }));
    await firstCall;
  });

  it('sends full history after a completed response without usage disables chaining', async () => {
    const handler = createHandler();
    const requests: any[] = [];
    const client = {
      responses: {
        create: async (params: any) => {
          requests.push(params);
          return requests.length === 1
            ? createResponse('resp-missing-usage')
            : createResponse('resp-2', { input_tokens: 20 });
        },
      },
    };
    const firstTurnMessages = createMessages(2);
    const secondTurnMessages = createMessages(3);

    await handler.createResponse({
      client: client as any,
      messages: firstTurnMessages,
      temperature: 0,
    });
    await handler.createResponse({
      client: client as any,
      messages: secondTurnMessages,
      temperature: 0,
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].previous_response_id, undefined);
    assert.equal(requests[1].previous_response_id, undefined);
    assert.deepEqual(requests[1].input, secondTurnMessages);
  });

  it('uses the preserved token baseline after an invalid previous response id clears chaining', async () => {
    const handler = createHandler({
      openRouterOnly: false,
      maxOutputTokens: 120000,
      contextWindow: 200000,
    });
    const requests: any[] = [];
    let tokenCountCalls = 0;
    const client = {
      responses: {
        inputTokens: {
          count: async () => {
            tokenCountCalls += 1;
            if (tokenCountCalls === 3) {
              throw new Error('token counting unavailable');
            }
            return { input_tokens: 1000 };
          },
        },
        create: async (params: any) => {
          requests.push(params);
          if (requests.length === 1) {
            return createResponse('resp-baseline', { input_tokens: 100000 });
          }
          if (requests.length === 2) {
            throw new Error(
              "Previous response with id 'resp-baseline' not found.",
            );
          }
          return createResponse('resp-rebuilt', { input_tokens: 100500 });
        },
      },
    };
    const firstTurnMessages = createMessages(2);
    const rebuiltMessages = createMessages(3);

    await handler.createResponse({
      client: client as any,
      messages: firstTurnMessages,
      temperature: 0,
    });

    await assert.rejects(
      handler.createResponse({
        client: client as any,
        messages: rebuiltMessages,
        temperature: 0,
      }),
      /Previous response/,
    );
    await handler.createResponse({
      client: client as any,
      messages: rebuiltMessages,
      temperature: 0,
    });

    assert.equal(requests.length, 3);
    assert.equal(requests[1].previous_response_id, 'resp-baseline');
    assert.equal(requests[2].previous_response_id, undefined);
    assert.deepEqual(requests[2].input, rebuiltMessages);
    assert.equal(tokenCountCalls, 3);
    assert.equal(requests[2].max_output_tokens, 99990);
  });
});

describe('ModelHandlerOpenAIResponse.extractAssistantText', () => {
  it('extracts assistant text from response output text parts', () => {
    const handler = createHandler();
    const message = {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'output_text', text: 'alpha' },
        { type: 'refusal', refusal: 'skip' },
        { type: 'input_text', text: ' beta' },
      ],
    } as unknown as ResponseInputItem;

    assert.equal(handler.extractAssistantText(message), 'alpha beta');
  });

  it('ignores non-assistant message content', () => {
    const handler = createHandler();
    const message = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'not assistant text' }],
    } as unknown as ResponseInputItem;

    assert.equal(handler.extractAssistantText(message), undefined);
  });
});

describe('ModelHandlerOpenAIResponse.initializeOutputAndPrefill', () => {
  it('skips pseudo-prefill instruction when prefill is empty', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openai-response-prefill-empty-'),
    );
    const outputPath = path.join(tempDir, 'r0', 'output.xml');

    try {
      const handler = createHandler();
      const agentSetting = AgentSettingSchema.parse({
        agentCategory: AgentCategory.Workflow,
        documentTag: 'documents',
        endTag: '</documents>',
      });
      const userMessage: ResponseInputItem = {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'revise the document' }],
      } as ResponseInputItem;
      const messages: ResponseInputItem[] = [userMessage];
      const workspaceState = AgentWorkspaceState.create();

      const [isComplete, updatedMessages] =
        await handler.initializeOutputAndPrefill(
          {} as AgentConfig,
          agentSetting,
          messages,
          workspaceState,
          pathToLocation(outputPath),
          '',
        );

      assert.equal(isComplete, false);
      assert.equal(updatedMessages.length, 1);
      const onlyContent = (updatedMessages[0] as any).content;
      assert.deepEqual(onlyContent, [
        { type: 'input_text', text: 'revise the document' },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
