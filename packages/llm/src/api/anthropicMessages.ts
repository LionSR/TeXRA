// Node imports
import { Buffer } from 'node:buffer';

// Third-party imports
import Anthropic, {
  APIError,
  APIConnectionError,
  toFile,
} from '@anthropic-ai/sdk';
import { Clock, Effect, Stream } from 'effect';
import { z } from 'zod';

// Local imports - canonical model contract
import {
  ModelConfigurationSchema,
  FILE_UPLOAD_LIFETIME_SECONDS,
  ResolvedTurnSchema,
  type AnthropicMessagesConfiguration,
  type Model,
  type ResolvedTurn,
  type TurnResult,
} from '../turn.js';
import { assembleTurn } from './assembleTurn.js';
import { decodeTurnRequest, fitLimit } from './turnInput.js';
import { replayableHistory, systemUpdateText } from '../message.js';
import { JsonObjectSchema, originOf, sameModelOrigin } from '../protocol.js';
import { ModelError, enrichModelError, sdkModelError } from '../errors.js';
import { parseOutboundToolArguments, sdkStream } from './transport.js';
import { filesApiUploads, type UploadCache } from './uploadCache.js';
import type { PartEvent } from './parts.js';
import type { ModelOrigin } from '../protocol.js';
import type {
  ContentBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages';

const CountSchema = z.int().nonnegative();
/**
 * What a Files API upload must return before its id is cached. The SDK's
 * type is not a check on the JSON, so a missing or empty id, or an expiry
 * that is not an RFC 3339 time (null means the file does not expire), is a
 * malformed response: the upload counts as failed and the bytes are sent.
 */
const UploadedFileSchema = z
  .object({
    id: z.string().min(1),
    expires_at: z.iso.datetime({ offset: true }).nullish(),
  })
  .transform((file) => ({
    fileId: file.id,
    expiresAtMs: file.expires_at == null ? null : Date.parse(file.expires_at),
  }));
const RefusalSchema = z.strictObject({
  type: z.literal('refusal'),
  category: z
    .enum([
      'cyber',
      'bio',
      'frontier_llm',
      'reasoning_extraction',
      'general_harms',
    ])
    .nullable(),
  explanation: z.string().nullable(),
});
const UsageSchema = z.object({
  input_tokens: CountSchema.nullish(),
  output_tokens: CountSchema.nullish(),
  cache_creation_input_tokens: CountSchema.nullish(),
  cache_read_input_tokens: CountSchema.nullish(),
  cache_creation: z
    .object({
      ephemeral_5m_input_tokens: CountSchema.nullish(),
      ephemeral_1h_input_tokens: CountSchema.nullish(),
    })
    .nullish(),
  output_tokens_details: z
    .object({ thinking_tokens: CountSchema.nullish() })
    .nullish(),
  server_tool_use: z.record(z.string(), CountSchema).nullish(),
});
const StopSchema = z.object({
  stop_reason: z
    .enum([
      'end_turn',
      'max_tokens',
      'stop_sequence',
      'tool_use',
      'pause_turn',
      'refusal',
      'model_context_window_exceeded',
    ])
    .nullish(),
  stop_sequence: z.string().nullish(),
  stop_details: RefusalSchema.nullish(),
  container: z.unknown().optional(),
});
const BlockSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('text'),
    text: z.string(),
    citations: z.array(z.unknown()).nullish(),
  }),
  z.strictObject({
    type: z.literal('thinking'),
    thinking: z.string(),
    signature: z.string(),
  }),
  z.strictObject({ type: z.literal('redacted_thinking'), data: z.string() }),
  z.strictObject({
    type: z.literal('tool_use'),
    id: z.string().min(1),
    name: z.string().min(1),
    input: JsonObjectSchema,
    caller: z.strictObject({ type: z.literal('direct') }).optional(),
    toolset_name: z.string().nullable().optional(),
  }),
]);
// The SDK parses SSE JSON but does not validate its supported event/block fields.
const EventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message_start'),
    message: StopSchema.extend({
      id: z.string().min(1),
      model: z.string().min(1),
      type: z.literal('message'),
      role: z.literal('assistant'),
      content: z.array(z.unknown()).length(0),
      usage: UsageSchema,
    }),
  }),
  z.object({
    type: z.literal('message_delta'),
    delta: StopSchema,
    usage: UsageSchema,
  }),
  z.object({ type: z.literal('message_stop') }),
  z.object({
    type: z.literal('content_block_start'),
    index: z.int().nonnegative(),
    content_block: BlockSchema,
  }),
  z.object({
    type: z.literal('content_block_delta'),
    index: z.int().nonnegative(),
    delta: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('text_delta'), text: z.string() }),
      z.strictObject({
        type: z.literal('thinking_delta'),
        thinking: z.string(),
      }),
      z.strictObject({
        type: z.literal('signature_delta'),
        signature: z.string(),
      }),
      z.strictObject({
        type: z.literal('input_json_delta'),
        partial_json: z.string(),
      }),
    ]),
  }),
  z.object({
    type: z.literal('content_block_stop'),
    index: z.int().nonnegative(),
  }),
]);

function sdkFailure(cause: unknown): ModelError {
  return sdkModelError(
    cause,
    cause instanceof APIError && !(cause instanceof APIConnectionError)
      ? {
          status: cause.status,
          headers: cause.headers,
          requestId: cause.requestID,
        }
      : undefined,
    'The Anthropic transport failed.',
  );
}

const inputPart = Effect.fn('llm.anthropic.inputPart')(function* (
  part: Extract<
    ResolvedTurn['messages'][number],
    { role: 'user' }
  >['content'][number],
  /** The live file id this binding holds for some bytes, or `null`. */
  fileIdFor: (base64: string) => string | null,
) {
  if (part.kind === 'text') return { type: 'text', text: part.text } as const;
  if (part.kind === 'image' && part.detail === undefined) {
    const mime = z
      .enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
      .safeParse(part.mimeType);
    if (mime.success)
      return {
        type: 'image',
        source: { type: 'base64', media_type: mime.data, data: part.base64 },
      } as const;
  }
  if (part.kind === 'document' && part.mimeType === 'application/pdf') {
    // Only this binding's own live upload stands in for the bytes.
    const fileId = fileIdFor(part.base64);
    return fileId !== null
      ? ({
          type: 'document',
          source: { type: 'file', file_id: fileId },
        } as const)
      : ({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: part.base64,
          },
        } as const);
  }
  return yield* new ModelError({
    kind: 'unsupported',
    message:
      'Anthropic supports materialized text, exact image MIME types and PDF bytes, without foreign image detail.',
  });
});

const invocationBody = Effect.fn('llm.anthropic.invocationBody')(function* (
  turn: ResolvedTurn,
  origin: ModelOrigin,
  config: AnthropicMessagesConfiguration,
  uploads: UploadCache,
) {
  if (
    turn.protocol !== 'anthropic-messages' ||
    !sameModelOrigin(turn, origin)
  ) {
    return yield* new ModelError({
      kind: 'unsupported',
      message:
        'The prepared Anthropic invocation belongs to another model or deployment.',
    });
  }
  const controls = turn.controls;
  if (
    (!config.supportsTemperature && controls.temperature !== null) ||
    (controls.thinking.mode !== 'disabled' &&
      controls.temperature !== null &&
      controls.temperature !== 1) ||
    (controls.thinking.mode === 'enabled' &&
      controls.thinking.budgetTokens >= controls.maxOutputTokens)
  ) {
    return yield* new ModelError({
      kind: 'invalid-request',
      message:
        'Anthropic thinking requires an admitted temperature and a manual budget below the output limit.',
    });
  }
  const choice = controls.toolChoice;
  if (choice !== 'auto') {
    if (
      !config.supportsForcedToolChoice ||
      controls.thinking.mode === 'enabled'
    ) {
      return yield* new ModelError({
        kind: 'unsupported',
        message:
          'This selected Anthropic binding does not support forcing a tool with these thinking controls.',
      });
    }
    if (!turn.tools.some((tool) => tool.name === choice.name)) {
      return yield* new ModelError({
        kind: 'invalid-request',
        message: 'The selected Anthropic tool is absent from this invocation.',
      });
    }
  }
  const nowMs = yield* Clock.currentTimeMillis;
  const lowerPart = (part: Parameters<typeof inputPart>[0]) =>
    inputPart(part, (base64) => uploads.fileIdFor(base64, nowMs));
  const messages: MessageParam[] = [];
  let calls: Extract<TurnResult['content'][number], { kind: 'local-call' }>[] =
    [];
  const history = replayableHistory(turn.messages, origin);
  for (const [index, message] of history.entries()) {
    if (message.role === 'system') {
      // Native where the model takes it and the API admits it: after a user
      // turn, and last or before an assistant turn.
      const next = history[index + 1];
      messages.push(
        config.supportsSystemMessages &&
          messages.at(-1)?.role === 'user' &&
          (next === undefined || next.role === 'assistant')
          ? { role: 'system', content: message.text }
          : {
              role: 'user',
              content: [{ type: 'text', text: systemUpdateText(message.text) }],
            },
      );
    } else if (message.role === 'user') {
      messages.push({
        role: 'user',
        content: yield* Effect.forEach(message.content, lowerPart),
      });
    } else if (message.role === 'tool') {
      const content: ToolResultBlockParam[] = [];
      for (const result of message.results) {
        const call = calls[result.callOrdinal];
        if (call === undefined)
          return yield* new ModelError({
            kind: 'unsupported',
            message:
              'Anthropic tool results require their original provider call IDs.',
          });
        content.push({
          type: 'tool_result',
          tool_use_id: call.providerCallId,
          is_error: result.status === 'error',
          content: yield* Effect.forEach(result.content, lowerPart),
        });
      }
      messages.push({ role: 'user', content });
    } else {
      calls = [];
      const content: ContentBlockParam[] = [];
      for (const part of message.content) {
        if (part.kind === 'message' && part.evidence === undefined) {
          for (const child of part.content) {
            if (child.kind !== 'text')
              return yield* new ModelError({
                kind: 'unsupported',
                message: 'Anthropic cannot replay foreign refusal content.',
              });
            content.push({ type: 'text', text: child.text });
          }
        } else if (part.kind === 'local-call' && part.evidence === undefined) {
          calls.push(part);
          content.push({
            type: 'tool_use',
            id: part.providerCallId,
            name: part.name,
            input: yield* parseOutboundToolArguments(part.argumentsText),
          });
        } else if (
          part.kind === 'reasoning' &&
          sameModelOrigin(message.origin, origin)
        ) {
          if (
            part.evidence?.kind === 'anthropic-thinking-signature' &&
            part.content?.length === 1
          ) {
            content.push({
              type: 'thinking',
              thinking: part.content[0]!.text,
              signature: part.evidence.signature,
            });
          } else if (part.evidence?.kind === 'anthropic-redacted-thinking') {
            content.push({
              type: 'redacted_thinking',
              data: part.evidence.data,
            });
          } else
            return yield* new ModelError({
              kind: 'unsupported',
              message:
                'Anthropic reasoning requires exact signed or redacted provider evidence.',
            });
        } else
          return yield* new ModelError({
            kind: 'unsupported',
            message:
              'Anthropic cannot replay foreign content evidence or missing call identities.',
          });
      }
      messages.push({ role: 'assistant', content });
    }
  }
  const tools: NonNullable<MessageCreateParamsStreaming['tools']> = [];
  for (const tool of turn.tools) {
    if (tool.parameters.type !== 'object')
      return yield* new ModelError({
        kind: 'unsupported',
        message: 'Anthropic local tools require JSON object parameter schemas.',
      });
    tools.push({
      name: tool.name,
      description: tool.description,
      input_schema: { ...tool.parameters, type: 'object' },
    });
  }
  const thinking = controls.thinking;
  let wireThinking: MessageCreateParamsStreaming['thinking'];
  if (thinking.mode === 'disabled') wireThinking = { type: 'disabled' };
  else if (thinking.mode === 'adaptive')
    wireThinking = { type: 'adaptive', display: thinking.display };
  else
    wireThinking = {
      type: 'enabled',
      display: thinking.display,
      budget_tokens: thinking.budgetTokens,
    };
  const body: MessageCreateParamsStreaming = {
    model: turn.requestedModel,
    max_tokens: controls.maxOutputTokens,
    messages,
    stream: true,
    ...(turn.system === undefined ? {} : { system: turn.system }),
    ...(controls.temperature === null
      ? {}
      : { temperature: controls.temperature }),
    ...(controls.effort === null
      ? {}
      : { output_config: { effort: controls.effort } }),
    stop_sequences: [...controls.stopSequences],
    thinking: wireThinking,
    ...(controls.cache === 'disabled'
      ? {}
      : { cache_control: { type: 'ephemeral', ttl: controls.cache } }),
    ...(tools.length === 0
      ? {}
      : {
          tools,
          tool_choice: {
            ...(choice === 'auto'
              ? { type: 'auto' as const }
              : { type: 'tool' as const, name: choice.name }),
            disable_parallel_tool_use: !controls.parallelToolCalls,
          },
        }),
  };
  if (turn.system && body.cache_control) {
    body.system = [
      {
        type: 'text',
        text: turn.system,
        cache_control: body.cache_control,
      },
    ];
  }
  return body;
});

const FINISH = {
  end_turn: 'stop',
  max_tokens: 'length',
  stop_sequence: 'stop-sequence',
  tool_use: 'tool-calls',
  refusal: 'refusal',
  model_context_window_exceeded: 'context-window-exceeded',
} as const;

/** The canonical receipt of Anthropic's cumulative counters. */
function canonicalUsage(
  usage: z.infer<typeof UsageSchema>,
): NonNullable<TurnResult['usage']> {
  const uncached = usage.input_tokens ?? null;
  const cached = usage.cache_read_input_tokens ?? null;
  const creation = usage.cache_creation_input_tokens ?? null;
  const inputTokens =
    uncached !== null && cached !== null && creation !== null
      ? uncached + cached + creation
      : null;
  const outputTokens = usage.output_tokens ?? null;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: cached,
    totalTokens:
      inputTokens !== null && outputTokens !== null
        ? inputTokens + outputTokens
        : null,
    reasoningTokens: usage.output_tokens_details?.thinking_tokens ?? null,
    providerUsage: {
      kind: 'anthropic',
      uncachedInputTokens: uncached,
      cacheCreationTokens: creation,
      cacheCreation5mTokens:
        usage.cache_creation?.ephemeral_5m_input_tokens ?? null,
      cacheCreation1hTokens:
        usage.cache_creation?.ephemeral_1h_input_tokens ?? null,
    },
  };
}

/** The canonical part a content block opens. */
function blockPart(
  block: z.infer<typeof BlockSchema>,
): TurnResult['content'][number] {
  switch (block.type) {
    case 'text':
      return { kind: 'message', content: [{ kind: 'text', text: '' }] };
    case 'thinking':
      return {
        kind: 'reasoning',
        summary: [],
        content: [{ kind: 'text', text: '' }],
        evidence: block.signature
          ? { kind: 'anthropic-thinking-signature', signature: block.signature }
          : null,
      };
    case 'redacted_thinking':
      return {
        kind: 'reasoning',
        summary: [],
        evidence: { kind: 'anthropic-redacted-thinking', data: block.data },
      };
    case 'tool_use':
      // A start carries no arguments, so a call no delta extends is `{}`.
      return {
        kind: 'local-call',
        providerCallId: block.id,
        name: block.name,
        argumentsText: '{}',
      };
  }
}

/**
 * One response's Messages events as parts. The wire opens one block at a
 * time, in order; message_delta carries the stop and cumulative usage, and
 * message_stop settles them.
 */
function anthropicWire() {
  let started = false;
  let stopped = false;
  let next = 0;
  let open: { index: number; type: string; signed: boolean } | undefined;
  let stop: z.infer<typeof StopSchema> = {};
  let usage: z.infer<typeof UsageSchema> = {};
  const fail = (
    message: string,
    kind: ModelError['kind'] = 'malformed-output',
  ) => Effect.fail(new ModelError({ kind, message }));

  const parts = (raw: unknown): Effect.Effect<PartEvent[], ModelError> =>
    Effect.gen(function* () {
      const decoded = EventSchema.safeParse(raw);
      if (!decoded.success)
        return yield* new ModelError({
          kind: 'malformed-output',
          message:
            'Anthropic returned an unsupported or malformed stream event.',
          cause: decoded.error,
        });
      const event = decoded.data;
      if (event.type === 'message_start') {
        const message = event.message;
        if (
          started ||
          message.stop_reason != null ||
          message.stop_sequence != null ||
          message.stop_details != null ||
          message.container != null
        )
          return yield* fail('Anthropic returned an invalid initial message.');
        started = true;
        usage = message.usage;
        return [{ kind: 'identity', id: message.id, model: message.model }];
      }
      if (!started)
        return yield* fail(
          'Anthropic emitted content before message identity.',
        );
      if (event.type === 'message_delta') {
        if (open || event.delta.container != null)
          return yield* fail(
            'Anthropic returned unsettled content.',
            'unsupported',
          );
        stop = event.delta;
        // These counters are cumulative; null/omission means no update, never zero or addition.
        usage = {
          ...usage,
          ...Object.fromEntries(
            Object.entries(event.usage).filter(([, value]) => value != null),
          ),
        };
        return [];
      }
      if (event.type === 'message_stop') {
        const reason = stop.stop_reason;
        if (open || reason == null)
          return yield* fail(
            'Anthropic stopped without complete content and a terminal reason.',
          );
        if (reason === 'pause_turn')
          return yield* fail(
            'Anthropic paused hosted execution requires a separate supported continuation protocol.',
            'unsupported',
          );
        stopped = true;
        const refusal = stop.stop_details;
        return [
          { kind: 'usage', usage: canonicalUsage(usage) },
          {
            kind: 'finish',
            finish: {
              finishReason: FINISH[reason],
              ...(stop.stop_sequence == null
                ? {}
                : { stopSequence: stop.stop_sequence }),
              ...(refusal === undefined
                ? {}
                : {
                    refusalEvidence: refusal && {
                      kind: 'anthropic-refusal',
                      category: refusal.category,
                      explanation: refusal.explanation,
                    },
                  }),
            },
          },
        ];
      }
      if (stop.stop_reason != null)
        return yield* fail(
          'Anthropic emitted content after terminal message metadata.',
        );
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (open || event.index !== next)
          return yield* fail(
            'Anthropic content blocks are not complete and ordered.',
          );
        if (
          (block.type === 'text' && (block.citations?.length ?? 0) > 0) ||
          (block.type === 'tool_use' &&
            (block.toolset_name != null ||
              Object.keys(block.input).length !== 0))
        )
          return yield* fail(
            'Anthropic citations, toolsets and nonempty streamed argument placeholders are unsupported.',
            'unsupported',
          );
        open = {
          index: next++,
          type: block.type,
          signed: block.type === 'thinking' && block.signature.length > 0,
        };
        const initial =
          (block.type === 'text' && block.text) ||
          (block.type === 'thinking' && block.thinking);
        return [
          { kind: 'open', index: event.index, part: blockPart(block) },
          ...(initial
            ? [
                {
                  kind: 'append',
                  index: event.index,
                  channel: block.type === 'text' ? 'text' : 'reasoning',
                  text: initial,
                } as const,
              ]
            : []),
        ];
      }
      if (open?.index !== event.index)
        return yield* fail('Anthropic updated a block that is not open.');
      if (event.type === 'content_block_stop') {
        if (open.type === 'thinking' && !open.signed)
          return yield* fail('Anthropic thinking ended without its signature.');
        open = undefined;
        return [{ kind: 'close', index: event.index }];
      }
      const delta = event.delta;
      if (delta.type === 'signature_delta') {
        if (open.type !== 'thinking')
          return yield* fail('Anthropic emitted a mismatched content delta.');
        open.signed = true;
        return [
          {
            kind: 'evidence',
            index: event.index,
            evidence: {
              kind: 'anthropic-thinking-signature',
              signature: delta.signature,
            },
          },
        ];
      }
      if (delta.type === 'text_delta')
        return [
          {
            kind: 'append',
            index: open.index,
            channel: 'text',
            text: delta.text,
          },
        ];
      if (delta.type === 'thinking_delta')
        return [
          {
            kind: 'append',
            index: open.index,
            channel: 'reasoning',
            text: delta.thinking,
          },
        ];
      return [
        {
          kind: 'append',
          index: open.index,
          channel: 'arguments',
          text: delta.partial_json,
        },
      ];
    });
  return { parts, stopped: () => stopped };
}

/** Stable Messages protocol, without a transcript owner, uploads or SDK emitters. */
export function anthropicMessagesModel(
  configuration: AnthropicMessagesConfiguration,
  transport: { readonly apiKey: string; readonly fetch?: typeof fetch },
): Model {
  const config = ModelConfigurationSchema.parse(configuration);
  if (config.protocol !== 'anthropic-messages' || !transport.apiKey) {
    throw new ModelError({
      kind: 'invalid-request',
      message:
        'Anthropic Messages requires its selected configuration and an explicit API key.',
    });
  }
  // The pinned SDK otherwise lets these ambient headers override selected credentials and protocol.
  if (process.env.ANTHROPIC_CUSTOM_HEADERS) {
    throw new ModelError({
      kind: 'unsupported',
      message:
        'Anthropic Messages does not support ANTHROPIC_CUSTOM_HEADERS; the selected binding must determine its request headers.',
    });
  }
  const origin = originOf(config);
  const client = new Anthropic({
    apiKey: transport.apiKey,
    authToken: null,
    baseURL: config.deployment.endpoint,
    fetch: transport.fetch,
    maxRetries: 0,
    logLevel: 'off',
    timeout: 600_000,
  });
  const uploads = filesApiUploads({
    providerName: 'Anthropic',
    model: origin.requestedModel,
    failure: (cause) =>
      enrichModelError(sdkFailure(cause), { model: origin.requestedModel }),
    parseUploaded: (raw) => UploadedFileSchema.safeParse(raw),
    create: async (upload, signal) =>
      client.files.upload(
        {
          file: await toFile(
            Buffer.from(upload.base64, 'base64'),
            upload.filename,
            { type: upload.mimeType },
          ),
          expires_in_seconds: FILE_UPLOAD_LIFETIME_SECONDS,
        },
        { signal },
      ),
    remove: (fileId, signal) => client.files.delete(fileId, null, { signal }),
  });
  const prepareTurn: Model['prepareTurn'] = Effect.fn(
    'llm.anthropic.prepareTurn',
  )(function* (request) {
    const input = yield* decodeTurnRequest(
      request,
      'The canonical Anthropic input is invalid.',
    );
    if (
      input.mode === 'background' ||
      input.continuation !== undefined ||
      input.store !== undefined
    )
      return yield* new ModelError({
        kind: 'unsupported',
        message:
          'The selected Anthropic model does not support these authored controls.',
      });
    const prepared = ResolvedTurnSchema.safeParse({
      ...origin,
      mode: 'foreground',
      system: input.system,
      messages: input.messages,
      tools: input.tools ?? [],
      controls: {
        ...fitLimit(config.defaults, input.maxOutputTokens),
        temperature: config.defaults.temperature,
        parallelToolCalls: config.defaults.parallelToolCalls,
        toolChoice: input.toolChoice ?? 'auto',
        effort: config.defaults.effort,
        cache: config.defaults.cache,
        stopSequences: config.defaults.stopSequences,
      },
    });
    if (!prepared.success)
      return yield* new ModelError({
        kind: 'invalid-request',
        message: 'Anthropic requires complete supported invocation controls.',
        cause: prepared.error,
      });
    yield* invocationBody(prepared.data, origin, config, uploads);
    return prepared.data;
  });

  const streamTurn: Model['streamTurn'] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const body = yield* invocationBody(input, origin, config, uploads);
        const signal = yield* Effect.abortSignal;
        const source = yield* Effect.tryPromise({
          try: () => client.messages.create(body, { signal }),
          catch: sdkFailure,
        });
        const wire = anthropicWire();
        const chunks = yield* sdkStream(source, sdkFailure);
        return assembleTurn(
          chunks.pipe(
            Stream.mapEffect(wire.parts),
            // message_stop settles the response; HTTP EOF is not an additional condition.
            Stream.takeUntil(() => wire.stopped()),
          ),
          { origin, provider: 'Anthropic' },
        );
      }).pipe(
        Effect.mapError((error) =>
          enrichModelError(error, {
            model: error.model ?? origin.requestedModel,
          }),
        ),
      ),
    );
  return Object.freeze({
    prepareTurn,
    streamTurn,
    uploadFile: uploads.uploadFile,
    releaseUploads: uploads.releaseUploads,
  });
}
