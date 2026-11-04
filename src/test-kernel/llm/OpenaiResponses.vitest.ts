// Node imports
import assert from 'node:assert/strict';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Stream } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';
import { completedTurn, type TurnRequest } from '@texra-ai/llm';
import { openaiResponsesModel } from '../../../packages/llm/src/api/openaiResponses.js';
import type { OpenAIResponsesConfiguration } from '../../../packages/llm/src/turn.js';

const CONFIG: OpenAIResponsesConfiguration = {
  protocol: 'openai-responses',
  requestedModel: 'synthetic-model',
  deployment: {
    endpoint: 'https://synthetic.invalid/v1',
    credentialScope: 'synthetic-account',
  },
  supportsDocumentInput: true,
  allowedReasoningEfforts: [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ],
  continuationInheritsInstructions: false,
  supportsForcedToolChoice: true,
  openaiEndpoint: true,
  requestDialect: 'openai',
  background: 'unsupported',
  defaults: {
    temperature: 0.7,
    maxOutputTokens: 100,
    store: false,
    reasoning: { effort: 'high', mode: 'pro', summary: 'auto' },
    serviceTier: 'fast',
  },
};
const REQUEST: TurnRequest = {
  messages: [
    { role: 'user', content: [{ kind: 'text', text: 'Compare two files.' }] },
  ],
  tools: [
    {
      name: 'read_file',
      description: 'Read a file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ],
};
const REASONING = {
  type: 'reasoning',
  id: 'rs_1',
  status: 'completed',
  summary: [
    { type: 'summary_text', text: 'plan A' },
    { type: 'summary_text', text: 'plan B' },
  ],
  content: [{ type: 'reasoning_text', text: 'reported reasoning' }],
  encrypted_content: 'enc_complete',
};
const MESSAGE = {
  type: 'message',
  role: 'assistant',
  id: 'msg_1',
  status: 'completed',
  phase: 'commentary',
  content: [
    { type: 'output_text', text: 'I will check.', annotations: [] },
    { type: 'output_text', text: 'Then compare.', annotations: [] },
  ],
};
const CALLS = ['a', 'b'].map((path, index) => ({
  type: 'function_call',
  id: `fc_${index + 1}`,
  call_id: `call_${index + 1}`,
  status: 'completed',
  name: 'read_file',
  arguments: JSON.stringify({ path }),
}));
const OUTPUT = [REASONING, MESSAGE, ...CALLS];

function snapshot(
  output: object[],
  overrides: Record<string, unknown> = {},
): object {
  return {
    id: 'resp_1',
    object: 'response',
    model: 'returned-model',
    status: 'completed',
    output,
    usage: null,
    ...overrides,
  };
}
function events(output: object[], final: object = snapshot(output)): object[] {
  return [
    {
      type: 'response.created',
      response: snapshot([], { status: 'in_progress' }),
    },
    ...output.flatMap((item, index) => [
      { type: 'response.output_item.added', output_index: index, item },
      { type: 'response.output_item.done', output_index: index, item },
    ]),
    { type: 'response.completed', response: final },
  ];
}
function sse(frames: object[], startingAt = 0): string {
  return frames
    .map(
      (frame, sequence_number) =>
        `data: ${JSON.stringify({ ...frame, sequence_number: startingAt + sequence_number })}\n\n`,
    )
    .join('');
}
function response(frames: object[]): Response {
  return new Response(sse(frames), {
    headers: {
      'content-type': 'text/event-stream',
      'x-request-id': 'request_1',
    },
  });
}
function modelWith(fetch: typeof globalThis.fetch, configuration = CONFIG) {
  return openaiResponsesModel(configuration, {
    authentication: { kind: 'api-key', apiKey: 'synthetic-not-a-secret' },
    fetch,
  });
}

describe('native OpenAI Responses protocol', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.effect(
    'rejects ambient header overrides and disables SDK diagnostic logging',
    () =>
      Effect.gen(function* () {
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
          new Response('data: malformed-provider-data\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          }),
        );
        const construct = () => modelWith(fetch);
        vi.stubEnv(
          'OPENAI_CUSTOM_HEADERS',
          'Authorization: Bearer other-account',
        );
        expect(construct).toThrow('Ambient OpenAI');
        expect(fetch).not.toHaveBeenCalled();
        vi.stubEnv('OPENAI_CUSTOM_HEADERS', '');
        vi.stubEnv('OPENAI_LOG', 'debug');
        const logs = (['debug', 'log', 'info', 'warn', 'error'] as const).map(
          (method) => vi.spyOn(console, method).mockImplementation(() => {}),
        );
        const model = construct();
        const turn = yield* model.prepareTurn(REQUEST);
        assert(turn.mode === 'foreground');
        expect(
          yield* Effect.flip(completedTurn(model.streamTurn(turn))),
        ).toMatchObject({
          kind: 'malformed-output',
        });
        for (const log of logs) expect(log).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'preserves grouped completed items, encrypted evidence and original tool IDs through a sparse terminal snapshot',
    () =>
      Effect.gen(function* () {
        const laterReasoning = {
          type: 'reasoning',
          id: 'rs_2',
          status: 'completed',
          summary: [],
          encrypted_content: 'enc_later',
        };
        const output = [...OUTPUT, laterReasoning];
        const frames = events(
          output,
          snapshot(
            [
              {
                type: REASONING.type,
                id: REASONING.id,
                summary: REASONING.summary,
                content: REASONING.content,
              },
              CALLS[0]!,
            ],
            {
              usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
            },
          ),
        );
        frames[1] = {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            ...REASONING,
            status: 'in_progress',
            summary: [],
            content: [],
            encrypted_content: 'enc_partial',
          },
        };
        frames.splice(4, 0, {
          type: 'response.output_text.delta',
          output_index: 1,
          item_id: 'msg_1',
          delta: 'I will check.',
        });
        // The ChatGPT backend's side-channel notice adds nothing to the turn.
        frames.splice(1, 0, {
          type: 'response.metadata',
          metadata: { openai_chatgpt_moderation_metadata: {} },
        });
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(response(frames))
          .mockResolvedValueOnce(response(events([MESSAGE])));
        const model = modelWith(fetch);
        const turn = yield* model.prepareTurn(REQUEST);
        assert(turn.mode === 'foreground');
        const collected = yield* Stream.runCollect(model.streamTurn(turn));
        expect(collected[0]).toMatchObject({
          kind: 'identified',
          providerResponseId: 'resp_1',
          returnedModel: 'returned-model',
        });
        expect(collected.slice(1, -1)).toEqual([
          { kind: 'delta', part: 'text', text: 'I will check.' },
        ]);
        const terminal = collected.at(-1);
        if (terminal?.kind !== 'completed')
          throw new Error('Missing completed response');
        expect(terminal.result).toMatchObject({
          finishReason: 'tool-calls',
          usage: { totalTokens: 15 },
          content: [
            {
              kind: 'reasoning',
              summary: [
                { kind: 'text', text: 'plan A' },
                { kind: 'text', text: 'plan B' },
              ],
              content: [{ kind: 'text', text: 'reported reasoning' }],
              evidence: { itemId: 'rs_1', encryptedContent: 'enc_complete' },
            },
            {
              kind: 'message',
              content: [
                { kind: 'text', text: 'I will check.' },
                { kind: 'text', text: 'Then compare.' },
              ],
              evidence: { itemId: 'msg_1', phase: 'commentary' },
            },
            {
              kind: 'local-call',
              providerCallId: 'call_1',
              argumentsText: '{"path":"a"}',
              evidence: { itemId: 'fc_1' },
            },
            {
              kind: 'local-call',
              providerCallId: 'call_2',
              argumentsText: '{"path":"b"}',
              evidence: { itemId: 'fc_2' },
            },
            {
              kind: 'reasoning',
              summary: [],
              evidence: { itemId: 'rs_2', encryptedContent: 'enc_later' },
            },
          ],
        });
        yield* model
          .prepareTurn({
            ...REQUEST,
            messages: [
              ...REQUEST.messages,
              {
                role: 'assistant',
                origin: terminal.result.requestedOrigin,
                content: terminal.result.content,
              },
              {
                role: 'tool',
                results: [
                  {
                    callOrdinal: 0,
                    status: 'success',
                    content: [{ kind: 'text', text: 'file text' }],
                  },
                  {
                    callOrdinal: 1,
                    status: 'error',
                    content: [{ kind: 'text', text: 'missing' }],
                  },
                ],
              },
            ],
          })
          .pipe(
            Effect.flatMap((turn) => {
              assert(turn.mode === 'foreground');
              return completedTurn(model.streamTurn(turn));
            }),
          );
        expect(
          JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).input,
        ).toEqual([
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'Compare two files.' }],
          },
          ...output,
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: 'file text',
          },
          {
            type: 'function_call_output',
            call_id: 'call_2',
            output: 'Error: missing',
          },
        ]);
      }),
  );
});
