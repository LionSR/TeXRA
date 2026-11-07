// Node imports
import { Buffer } from 'node:buffer';

// Third-party imports
import Anthropic, {
  APIError,
  APIConnectionError,
  toFile,
} from '@anthropic-ai/sdk';
import {
  Clock,
  DateTime,
  Effect,
  Result,
  Schema,
  SchemaGetter,
  type Scope,
  Stream,
} from 'effect';

// Local imports - canonical model contract
import {
  FILE_UPLOAD_LIFETIME_SECONDS,
  type AnthropicMessagesConfiguration,
  type Model,
  type ResolvedTurn,
  type TurnResult,
} from '../turn.js';
import { assembleTurn } from './assembleTurn.js';
import { boundTurn, fitLimit, resolveTurn } from './turnInput.js';
import { replayableHistory, systemUpdateText } from '../message.js';
import { originOf, sameModelOrigin } from '../protocol.js';
import { ModelError, fillModelError, sdkModelError } from '../errors.js';
import {
  decodeWireOrFail,
  parseOutboundToolArguments,
  sdkStream,
  wireFail as fail,
} from './transport.js';
import {
  filesApiUploads,
  UploadedSchema,
  type UploadCache,
} from './uploadCache.js';
import {
  BlockSchema,
  EventSchema,
  StopSchema,
  UsageSchema,
} from './anthropicMessagesWire.js';
import { messageThreads, type SdkSource } from './anthropicThreads.js';
import {
  ImageMimeTypeSchema,
  type InputPart,
  type PartEvent,
} from './parts.js';
import type { ModelOrigin } from '../protocol.js';
import type {
  ContentBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages';

/**
 * What a Files API upload must return before its id is cached. The SDK's
 * type is not a check on the JSON, so a missing or empty id, or an expiry
 * that is not an RFC 3339 time (null means the file does not expire), is a
 * malformed response: the upload counts as failed and the bytes are sent.
 */
const UploadedFileSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  expires_at: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
}).pipe(
  Schema.decodeTo(UploadedSchema, {
    decode: SchemaGetter.transform((file) => ({
      fileId: file.id,
      expiresAtMs:
        file.expires_at == null
          ? null
          : DateTime.toEpochMillis(file.expires_at),
    })),
    encode: SchemaGetter.forbidden(() => 'decode-only'),
  }),
);
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
  part: InputPart,
  /** The live file id this binding holds for some bytes, or `null`. */
  fileIdFor: (base64: string) => string | null,
) {
  if (part.kind === 'text') return { type: 'text', text: part.text } as const;
  if (part.kind === 'image' && part.detail === undefined) {
    const mime = Schema.decodeUnknownResult(ImageMimeTypeSchema)(part.mimeType);
    if (Result.isSuccess(mime))
      return {
        type: 'image',
        source: { type: 'base64', media_type: mime.success, data: part.base64 },
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
    kind: 'invalid-request',
    message:
      'Anthropic supports materialized text, exact image MIME types and PDF bytes, without foreign image detail.',
  });
});

const invocationBody = Effect.fn('llm.anthropic.invocationBody')(function* (
  input: ResolvedTurn,
  origin: ModelOrigin & { readonly protocol: 'anthropic-messages' },
  config: AnthropicMessagesConfiguration,
  uploads: UploadCache,
) {
  const turn = yield* boundTurn(input, origin, 'foreground');
  const controls = turn.controls;
  if (
    controls.thinking.mode === 'enabled' &&
    controls.thinking.budgetTokens >= controls.maxOutputTokens
  ) {
    return yield* new ModelError({
      kind: 'invalid-request',
      message:
        'Anthropic manual thinking requires a budget below the output limit.',
    });
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
        content.push({
          type: 'tool_result',
          // The canonical grammar guarantees adjacent, complete ordinals.
          tool_use_id: calls[result.callOrdinal].providerCallId,
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
                kind: 'invalid-request',
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
          const onlyContent =
            part.content?.length === 1 ? part.content.at(0) : undefined;
          if (
            part.evidence?.kind === 'anthropic-thinking-signature' &&
            onlyContent !== undefined
          ) {
            content.push({
              type: 'thinking',
              thinking: onlyContent.text,
              signature: part.evidence.signature,
            });
          } else if (part.evidence?.kind === 'anthropic-redacted-thinking') {
            content.push({
              type: 'redacted_thinking',
              data: part.evidence.data,
            });
          } else
            return yield* new ModelError({
              kind: 'invalid-request',
              message:
                'Anthropic reasoning requires exact signed or redacted provider evidence.',
            });
        } else
          return yield* new ModelError({
            kind: 'invalid-request',
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
        kind: 'invalid-request',
        message: `Tool "${tool.name}": Anthropic local tools require JSON object parameter schemas.`,
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
    ...(controls.effort === null
      ? {}
      : { output_config: { effort: controls.effort } }),
    thinking: wireThinking,
    ...(controls.cache === 'disabled'
      ? {}
      : { cache_control: { type: 'ephemeral', ttl: controls.cache } }),
    ...(tools.length === 0
      ? {}
      : {
          tools,
          tool_choice: { type: 'auto' },
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
  tool_use: 'tool-calls',
  refusal: 'refusal',
} as const;

/** The canonical receipt of Anthropic's cumulative counters. */
function canonicalUsage(
  usage: typeof UsageSchema.Type,
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
    cacheWriteTokens: creation,
    totalTokens:
      inputTokens !== null && outputTokens !== null
        ? inputTokens + outputTokens
        : null,
    reasoningTokens: usage.output_tokens_details?.thinking_tokens ?? null,
    toolUsePromptTokens: null,
    providerUsage: {
      kind: 'anthropic',
      uncachedInputTokens: uncached,
      cacheCreation5mTokens:
        usage.cache_creation?.ephemeral_5m_input_tokens ?? null,
      cacheCreation1hTokens:
        usage.cache_creation?.ephemeral_1h_input_tokens ?? null,
    },
  };
}

/** The canonical part a content block opens. */
function blockPart(
  block: typeof BlockSchema.Type,
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
 * One response's Messages events as parts: message_start carries the
 * identity, message_delta the stop and cumulative usage, and message_stop
 * finishes them. Where each block lands is the assembly's to refuse (a gap,
 * a reopened position, progress outside an open block, a block left open
 * at the finish); the order blocks arrive in is not checked, since the
 * content is keyed by index. This keeps only what the Messages framing
 * alone knows, that a thinking block ends signed.
 */
function anthropicWire() {
  let started = false;
  let stopped = false;
  /** Thinking blocks opened and not yet signed, by index. */
  const unsigned = new Set<number>();
  let stop: typeof StopSchema.Type = {};
  let usage: typeof UsageSchema.Type = {};

  const parts = Effect.fnUntraced(function* (
    raw: unknown,
  ): Effect.fn.Return<PartEvent[], ModelError> {
    const event = yield* decodeWireOrFail(
      EventSchema,
      'Anthropic returned an unsupported or malformed stream event.',
      raw,
    );
    if (event.type === 'message_start') {
      const message = event.message;
      if (
        started ||
        message.stop_reason != null ||
        message.stop_details != null ||
        message.container != null
      )
        return yield* fail('Anthropic returned an invalid initial message.');
      started = true;
      usage = message.usage;
      return [{ kind: 'identity', id: message.id, model: message.model }];
    }
    if (!started)
      return yield* fail('Anthropic emitted content before message identity.');
    if (event.type === 'message_delta') {
      if (event.delta.container != null)
        return yield* fail(
          'Anthropic returned unsettled content.',
          'invalid-request',
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
      if (reason == null)
        return yield* fail(
          'Anthropic stopped without complete content and a terminal reason.',
        );
      if (reason === 'pause_turn')
        return yield* fail(
          'Anthropic paused hosted execution requires a separate supported continuation protocol.',
          'invalid-request',
        );
      // The one overflow every protocol reports the same way: the error
      // the other providers raise as an HTTP failure. Anthropic billed the
      // input it read before stopping, so the failure carries its usage.
      if (reason === 'model_context_window_exceeded')
        return yield* new ModelError({
          kind: 'context-overflow',
          message:
            "Anthropic stopped: the request exceeds the model's context window.",
          usage: canonicalUsage(usage),
        });
      stopped = true;
      const refusal = stop.stop_details;
      return [
        { kind: 'usage', usage: canonicalUsage(usage) },
        {
          kind: 'finish',
          finish: {
            finishReason: FINISH[reason],
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
      if (
        (block.type === 'text' && (block.citations?.length ?? 0) > 0) ||
        (block.type === 'tool_use' &&
          (block.toolset_name != null || Object.keys(block.input).length !== 0))
      )
        return yield* fail(
          'Anthropic citations, toolsets and nonempty streamed argument placeholders are unsupported.',
          'invalid-request',
        );
      if (block.type === 'thinking' && block.signature.length === 0)
        unsigned.add(event.index);
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
    const { index } = event;
    if (event.type === 'content_block_stop') {
      if (unsigned.has(index))
        return yield* fail('Anthropic thinking ended without its signature.');
      return [{ kind: 'close', index }];
    }
    const delta = event.delta;
    if (delta.type === 'signature_delta') {
      unsigned.delete(index);
      return [
        {
          kind: 'evidence',
          index,
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
          index,
          channel: 'text',
          text: delta.text,
        },
      ];
    if (delta.type === 'thinking_delta')
      return [
        {
          kind: 'append',
          index,
          channel: 'reasoning',
          text: delta.thinking,
        },
      ];
    return [
      {
        kind: 'append',
        index,
        channel: 'arguments',
        text: delta.partial_json,
      },
    ];
  });
  return { parts, stopped: () => stopped };
}

/** Stable Messages protocol, without a transcript owner or SDK emitters;
 *  its uploads live in the caller's scope. */
export const anthropicMessagesModel = Effect.fn('llm.anthropicMessages.model')(
  function* (
    config: AnthropicMessagesConfiguration,
    transport: { readonly apiKey: string; readonly fetch?: typeof fetch },
  ): Effect.fn.Return<Model, ModelError, Scope.Scope> {
    if (!transport.apiKey) {
      return yield* new ModelError({
        kind: 'invalid-request',
        message: 'Anthropic Messages requires an explicit API key.',
      });
    }
    // The SDK otherwise lets these ambient headers override selected credentials and protocol.
    if (process.env.ANTHROPIC_CUSTOM_HEADERS) {
      return yield* new ModelError({
        kind: 'invalid-request',
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
    const uploads = yield* filesApiUploads({
      providerName: 'Anthropic',
      model: origin.requestedModel,
      request: (call) =>
        Effect.tryPromise({
          try: (signal) => call(signal, {}),
          catch: (cause) =>
            fillModelError(sdkFailure(cause), { model: origin.requestedModel }),
        }),
      parseUploaded: (raw) =>
        Schema.decodeUnknownResult(UploadedFileSchema)(raw),
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
    const prepareTurn: Model['prepareTurn'] = (request) =>
      resolveTurn(
        request,
        origin,
        undefined,
        (input) =>
          Effect.succeed({
            controls: {
              ...fitLimit(config.defaults, input.maxOutputTokens),
              effort: config.defaults.effort,
              cache: config.defaults.cache,
            },
          }),
        (turn) => invocationBody(turn, origin, config, uploads),
      );

    const threads = messageThreads({
      endpoint: config.deployment.endpoint,
      open: (body) =>
        Effect.flatMap(Effect.abortSignal, (signal) =>
          Effect.tryPromise({
            try: (): PromiseLike<SdkSource> =>
              body.thread === undefined
                ? client.messages.create(body, { signal })
                : client.beta.messages.create(body, { signal }),
            catch: sdkFailure,
          }),
        ),
      lower: (turn) => invocationBody(turn, origin, config, uploads),
    });
    const streamTurn: Model['streamTurn'] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const body = yield* invocationBody(input, origin, config, uploads);
          const { source, finalize } = yield* threads.send(input, body);
          const wire = anthropicWire();
          const chunks = yield* sdkStream(source, sdkFailure);
          return assembleTurn(
            chunks.pipe(
              Stream.mapEffect(wire.parts),
              // message_stop finishes the response; HTTP EOF is not an additional condition.
              Stream.takeUntil(() => wire.stopped()),
            ),
            { origin, provider: 'Anthropic', finalize },
          );
        }).pipe(
          Effect.mapError((error) =>
            fillModelError(error, { model: origin.requestedModel }),
          ),
        ),
      );
    return Object.freeze({
      prepareTurn,
      streamTurn,
      uploadFile: uploads.uploadFile,
    });
  },
);
