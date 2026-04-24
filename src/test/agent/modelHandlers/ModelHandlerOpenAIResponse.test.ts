// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';

// Local imports - agent
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/modelHandlerOpenAIResponse';

// Type imports
import type { AgentLogger } from '@logger/AgentLogger';
import type { ResponseInputItem } from 'openai/resources/responses/responses';

type LoggerStub = Partial<AgentLogger> & {
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
    logProgress: () => {
      /* no-op for tests */
    },
    logContextManagement: () => {
      /* no-op for tests */
    },
    withCurrentGroup: () => undefined,
    runWithinCurrentGroup: async (fn: () => any) => fn(),
    runWithGroup: async (_groupId: string | undefined, fn: () => any) => fn(),
  };
}

function createConfig(): ModelConfig {
  return {
    name: 'gpt-4.1',
    fullName: 'gpt-4.1',
    shortName: 'gpt-4.1',
    label: 'GPT 4.1',
    provider: ModelProvider.OPENAI,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 200000,
    capabilities: {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsReasoning: false,
      supportsVision: false,
    },
    openRouterOnly: true,
  };
}

function createHandler(): ModelHandlerOpenAIResponse {
  const handler = new ModelHandlerOpenAIResponse(createConfig());
  handler.setLogger(createLoggerStub() as unknown as AgentLogger);
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
});
