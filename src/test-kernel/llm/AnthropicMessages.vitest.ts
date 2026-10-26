// Node imports
import assert from 'node:assert/strict';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { completedTurn, type TurnRequest } from '@texra-ai/llm';
import { anthropicMessagesModel } from '../../../packages/llm/src/api/anthropicMessages.js';
import type { AnthropicMessagesConfiguration } from '../../../packages/llm/src/turn.js';

const CONFIG: AnthropicMessagesConfiguration = {
  protocol: 'anthropic-messages',
  requestedModel: 'selected-claude',
  deployment: {
    endpoint: 'https://synthetic.invalid',
    credentialScope: 'account-a',
  },
  supportsTemperature: true,
  supportsForcedToolChoice: true,
  supportsSystemMessages: false,
  defaults: {
    maxOutputTokens: 8192,
    temperature: 1,
    parallelToolCalls: false,
    thinking: { mode: 'adaptive', display: 'summarized' },
    effort: 'high',
    cache: '5m',
    stopSequences: [],
  },
};
const REQUEST: TurnRequest = {
  system: 'Exact system\n',
  messages: [
    {
      role: 'user',
      content: [
        { kind: 'text', text: 'Read these exact bytes.' },
        { kind: 'image', mimeType: 'image/png', base64: '' },
        { kind: 'document', mimeType: 'application/pdf', base64: 'AA==' },
      ],
    },
  ],
  tools: ['search', 'fetch'].map((name) => ({
    name,
    description: name,
    parameters: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    },
  })),
};

function initial() {
  return {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'returned-claude',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      container: null,
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_creation: {
          ephemeral_5m_input_tokens: 11,
          ephemeral_1h_input_tokens: 19,
        },
      },
    },
  };
}
function terminal(reason = 'end_turn', extra: Record<string, unknown> = {}) {
  return [
    {
      type: 'message_delta',
      delta: {
        stop_reason: reason,
        stop_sequence: null,
        stop_details: null,
        ...extra,
      },
      usage: {
        input_tokens: 12,
        output_tokens: 11,
        output_tokens_details: { thinking_tokens: 6 },
      },
    },
    { type: 'message_stop' },
  ];
}
function signedEvents(): Array<Record<string, unknown>> {
  return [
    initial(),
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: '  returned thinking\n' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'signature-a' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'signature_delta', signature: 'signature-empty' },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'redacted_thinking', data: 'opaque-redacted' },
    },
    { type: 'content_block_stop', index: 2 },
    {
      type: 'content_block_start',
      index: 3,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 3,
      delta: { type: 'text_delta', text: '  calling tools\n' },
    },
    { type: 'content_block_stop', index: 3 },
    ...['search', 'fetch'].flatMap((name, ordinal) => [
      {
        type: 'content_block_start',
        index: ordinal + 4,
        content_block: {
          type: 'tool_use',
          id: `call_${ordinal}`,
          name,
          input: {},
          caller: { type: 'direct' },
        },
      },
      {
        type: 'content_block_delta',
        index: ordinal + 4,
        delta: { type: 'input_json_delta', partial_json: '{"q":' },
      },
      {
        type: 'content_block_delta',
        index: ordinal + 4,
        delta: { type: 'input_json_delta', partial_json: '"x"}' },
      },
      { type: 'content_block_stop', index: ordinal + 4 },
    ]),
    ...terminal('tool_use'),
  ];
}
function response(events: Array<Record<string, unknown>>): Response {
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

describe('canonical Anthropic Messages protocol', () => {
  const fetchModel = vi.fn<typeof fetch>();
  const model = (configuration = CONFIG) =>
    anthropicMessagesModel(configuration, {
      apiKey: 'selected-key',
      fetch: fetchModel,
    });
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', '');
    fetchModel.mockReset();
    fetchModel.mockImplementation(async () => response(signedEvents()));
  });
  afterEach(() => vi.unstubAllEnvs());

  it.effect(
    "sends no switched-from model's thinking and no empty assistant turn",
    () =>
      Effect.gen(function* () {
        fetchModel.mockImplementation(async () => response(signedEvents()));
        const bound = model();
        // An earlier Claude model's turn that ended while thinking: once its
        // thinking is left out, the turn has nothing left to send.
        const turn = yield* bound.prepareTurn({
          messages: [
            { role: 'user', content: [{ kind: 'text', text: 'first' }] },
            {
              role: 'assistant',
              origin: {
                protocol: 'anthropic-messages',
                codecVersion: 1,
                requestedModel: 'earlier-claude',
                deployment: CONFIG.deployment,
              },
              content: [
                {
                  kind: 'reasoning',
                  summary: [],
                  content: [{ kind: 'text', text: 'thinking' }],
                  evidence: {
                    kind: 'anthropic-thinking-signature',
                    signature: 'sig',
                  },
                },
              ],
            },
            { role: 'user', content: [{ kind: 'text', text: 'second' }] },
          ],
        });
        assert(turn.mode === 'foreground');
        yield* completedTurn(bound.streamTurn(turn));
        expect(
          JSON.parse(fetchModel.mock.calls[0]![1]!.body as string).messages,
        ).toEqual([
          {
            role: 'user',
            content: [
              { type: 'text', text: 'first' },
              { type: 'text', text: 'second' },
            ],
          },
        ]);
      }),
  );

  it.effect(
    'round-trips signed and redacted blocks with two ordered local settlements and exact materialized media',
    () =>
      Effect.gen(function* () {
        vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'ambient-bearer');
        vi.stubEnv('ANTHROPIC_BASE_URL', 'https://ambient.invalid');
        const configured = model();
        const prepared = yield* configured.prepareTurn({
          ...REQUEST,
          toolChoice: { name: 'search' },
        });
        assert(prepared.mode === 'foreground');
        expect(fetchModel).not.toHaveBeenCalled();
        const events = yield* Stream.runCollect(
          configured.streamTurn(prepared),
        );
        expect(events[0]).toMatchObject({
          kind: 'identified',
          providerResponseId: 'msg_1',
          returnedModel: 'returned-claude',
        });
        expect(
          events.filter((event) => event.kind === 'identified'),
        ).toHaveLength(1);
        expect(
          events.flatMap((event) =>
            event.kind === 'delta' ? [[event.part, event.text]] : [],
          ),
        ).toEqual([
          ['reasoning', '  returned thinking\n'],
          ['text', '  calling tools\n'],
        ]);
        const completed = events.at(-1);
        assert(completed?.kind === 'completed');
        const result = completed.result;
        expect(result.content).toEqual([
          {
            kind: 'reasoning',
            summary: [],
            content: [{ kind: 'text', text: '  returned thinking\n' }],
            evidence: {
              kind: 'anthropic-thinking-signature',
              signature: 'signature-a',
            },
          },
          {
            kind: 'reasoning',
            summary: [],
            content: [{ kind: 'text', text: '' }],
            evidence: {
              kind: 'anthropic-thinking-signature',
              signature: 'signature-empty',
            },
          },
          {
            kind: 'reasoning',
            summary: [],
            evidence: {
              kind: 'anthropic-redacted-thinking',
              data: 'opaque-redacted',
            },
          },
          {
            kind: 'message',
            content: [{ kind: 'text', text: '  calling tools\n' }],
          },
          {
            kind: 'local-call',
            providerCallId: 'call_0',
            name: 'search',
            // The exact concatenation of both input_json_delta fragments.
            argumentsText: '{"q":"x"}',
          },
          {
            kind: 'local-call',
            providerCallId: 'call_1',
            name: 'fetch',
            argumentsText: '{"q":"x"}',
          },
        ]);
        expect(result.usage).toEqual({
          inputTokens: 62,
          outputTokens: 11,
          totalTokens: 73,
          cachedInputTokens: 20,
          reasoningTokens: 6,
          providerUsage: {
            kind: 'anthropic',
            uncachedInputTokens: 12,
            cacheCreationTokens: 30,
            cacheCreation5mTokens: 11,
            cacheCreation1hTokens: 19,
          },
        });
        const first = JSON.parse(fetchModel.mock.calls[0][1]!.body as string);
        const headers = new Headers(fetchModel.mock.calls[0][1]!.headers);
        expect(String(fetchModel.mock.calls[0][0])).toBe(
          'https://synthetic.invalid/v1/messages',
        );
        expect(headers.get('x-api-key')).toBe('selected-key');
        expect(headers.has('authorization')).toBe(false);
        expect(first).toMatchObject({
          model: 'selected-claude',
          system: [
            {
              type: 'text',
              text: REQUEST.system,
              cache_control: { type: 'ephemeral', ttl: '5m' },
            },
          ],
          stream: true,
          temperature: 1,
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: 'high' },
          cache_control: { type: 'ephemeral', ttl: '5m' },
          tool_choice: {
            type: 'tool',
            name: 'search',
            disable_parallel_tool_use: true,
          },
        });
        const next = yield* configured.prepareTurn(
          JSON.parse(
            JSON.stringify({
              ...REQUEST,
              messages: [
                ...REQUEST.messages,
                {
                  role: 'assistant',
                  origin: result.requestedOrigin,
                  content: result.content,
                },
                {
                  role: 'tool',
                  results: [
                    {
                      callOrdinal: 0,
                      status: 'success',
                      content: [
                        { kind: 'text', text: 'ok' },
                        { kind: 'image', mimeType: 'image/png', base64: '' },
                      ],
                    },
                    {
                      callOrdinal: 1,
                      status: 'error',
                      content: [
                        {
                          kind: 'document',
                          mimeType: 'application/pdf',
                          base64: 'AA==',
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
          ),
        );
        assert(next.mode === 'foreground');
        fetchModel.mockImplementationOnce(async () =>
          response([initial(), ...terminal()]),
        );
        yield* completedTurn(configured.streamTurn(next));
        const sent = JSON.parse(fetchModel.mock.calls[1][1]!.body as string);
        expect(sent.system).toEqual(first.system);
        expect(sent.cache_control).toEqual(first.cache_control);
        for (const body of [first, sent]) {
          expect(body).not.toHaveProperty('inference_geo');
          expect(body).not.toHaveProperty('service_tier');
        }
        expect(sent.messages.slice(1)).toEqual([
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: '  returned thinking\n',
                signature: 'signature-a',
              },
              { type: 'thinking', thinking: '', signature: 'signature-empty' },
              { type: 'redacted_thinking', data: 'opaque-redacted' },
              { type: 'text', text: '  calling tools\n' },
              {
                type: 'tool_use',
                id: 'call_0',
                name: 'search',
                input: { q: 'x' },
              },
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'fetch',
                input: { q: 'x' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_0',
                is_error: false,
                content: [
                  { type: 'text', text: 'ok' },
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: 'image/png',
                      data: '',
                    },
                  },
                ],
              },
              {
                type: 'tool_result',
                tool_use_id: 'call_1',
                is_error: true,
                content: [
                  {
                    type: 'document',
                    source: {
                      type: 'base64',
                      media_type: 'application/pdf',
                      data: 'AA==',
                    },
                  },
                ],
              },
            ],
          },
        ]);
      }),
  );

  it('rejects ambient custom headers before they override the selected credentials', () => {
    vi.stubEnv(
      'ANTHROPIC_CUSTOM_HEADERS',
      'X-Api-Key: another-key\nanthropic-version: another-version',
    );
    expect(() => model()).toThrow(
      expect.objectContaining({ _tag: 'ModelError', kind: 'unsupported' }),
    );
    expect(fetchModel).not.toHaveBeenCalled();
  });
});
