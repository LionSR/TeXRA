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
  Stream,
} from 'effect';

// Local imports - canonical model contract
import {
  decodeModelConfiguration,
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
import { originOf, sameModelOrigin } from '../protocol.js';
import { ModelError, fillModelError, sdkModelError } from '../errors.js';
import { parseOutboundToolArguments, sdkStream } from './transport.js';
import {
  filesApiUploads,
  UploadedSchema,
  type UploadCache,
} from './uploadCache.js';
import { anthropicWire } from './anthropicMessagesStream.js';
import type { InputPart } from './parts.js';
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
  id: Schema.NonEmptyString,
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
    const mime = Schema.decodeUnknownResult(
      Schema.Literals(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    )(part.mimeType);
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
    kind: 'unsupported',
    message:
      'Anthropic supports materialized text, exact image MIME types and PDF bytes, without foreign image detail.',
  });
});

type AssistantPart = TurnResult['content'][number];
type AnthropicControls = Extract<
  ResolvedTurn,
  { protocol: 'anthropic-messages' }
>['controls'];

/**
 * One assistant part as the content blocks that replay it. Reasoning replays
 * only to the model that produced it (`ownReasoning`), and only with its
 * exact signed or redacted evidence.
 */
const assistantBlocks = Effect.fn('llm.anthropic.assistantBlocks')(function* (
  part: AssistantPart,
  ownReasoning: boolean,
): Effect.fn.Return<ContentBlockParam[], ModelError> {
  if (part.kind === 'message' && part.evidence === undefined) {
    if (part.content.some((child) => child.kind !== 'text'))
      return yield* new ModelError({
        kind: 'unsupported',
        message: 'Anthropic cannot replay foreign refusal content.',
      });
    return part.content.map((child) => ({ type: 'text', text: child.text }));
  }
  if (part.kind === 'local-call' && part.evidence === undefined)
    return [
      {
        type: 'tool_use',
        id: part.providerCallId,
        name: part.name,
        input: yield* parseOutboundToolArguments(part.argumentsText),
      },
    ];
  if (part.kind === 'reasoning' && ownReasoning) {
    if (
      part.evidence?.kind === 'anthropic-thinking-signature' &&
      part.content?.length === 1
    )
      return [
        {
          type: 'thinking',
          thinking: part.content[0].text,
          signature: part.evidence.signature,
        },
      ];
    if (part.evidence?.kind === 'anthropic-redacted-thinking')
      return [{ type: 'redacted_thinking', data: part.evidence.data }];
    return yield* new ModelError({
      kind: 'unsupported',
      message:
        'Anthropic reasoning requires exact signed or redacted provider evidence.',
    });
  }
  return yield* new ModelError({
    kind: 'unsupported',
    message:
      'Anthropic cannot replay foreign content evidence or missing call identities.',
  });
});

/**
 * The replayable history as Messages turns. `fileIdFor` names the live
 * upload this binding holds for some document bytes, or `null`.
 */
const lowerMessages = Effect.fn('llm.anthropic.lowerMessages')(function* (
  turnMessages: ResolvedTurn['messages'],
  origin: ModelOrigin,
  config: AnthropicMessagesConfiguration,
  fileIdFor: (base64: string) => string | null,
) {
  const lowerPart = (part: InputPart) => inputPart(part, fileIdFor);
  const messages: MessageParam[] = [];
  let calls: Extract<AssistantPart, { kind: 'local-call' }>[] = [];
  const history = replayableHistory(turnMessages, origin);
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
      calls = message.content.filter((part) => part.kind === 'local-call');
      const ownReasoning = sameModelOrigin(message.origin, origin);
      const blocks = yield* Effect.forEach(message.content, (part) =>
        assistantBlocks(part, ownReasoning),
      );
      messages.push({ role: 'assistant', content: blocks.flat() });
    }
  }
  return messages;
});

/** The canonical thinking control as the Messages `thinking` parameter. */
function wireThinking(
  thinking: AnthropicControls['thinking'],
): MessageCreateParamsStreaming['thinking'] {
  switch (thinking.mode) {
    case 'disabled':
      return { type: 'disabled' };
    case 'adaptive':
      return { type: 'adaptive', display: thinking.display };
    case 'enabled':
      return {
        type: 'enabled',
        display: thinking.display,
        budget_tokens: thinking.budgetTokens,
      };
  }
}

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
  const messages = yield* lowerMessages(
    turn.messages,
    origin,
    config,
    (base64) => uploads.fileIdFor(base64, nowMs),
  );
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
  const body: MessageCreateParamsStreaming = {
    model: turn.requestedModel,
    max_tokens: controls.maxOutputTokens,
    messages,
    stream: true,
    ...(turn.system === undefined ? {} : { system: turn.system }),
    ...(controls.effort === null
      ? {}
      : { output_config: { effort: controls.effort } }),
    stop_sequences: [...controls.stopSequences],
    thinking: wireThinking(controls.thinking),
    ...(controls.cache === 'disabled'
      ? {}
      : { cache_control: { type: 'ephemeral', ttl: controls.cache } }),
    ...(tools.length === 0
      ? {}
      : {
          tools,
          tool_choice: {
            type: 'auto',
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

/** Stable Messages protocol, without a transcript owner, uploads or SDK emitters. */
export function anthropicMessagesModel(
  configuration: AnthropicMessagesConfiguration,
  transport: { readonly apiKey: string; readonly fetch?: typeof fetch },
): Model {
  const config = decodeModelConfiguration(configuration);
  if (config.protocol !== 'anthropic-messages' || !transport.apiKey) {
    throw new ModelError({
      kind: 'invalid-request',
      message:
        'Anthropic Messages requires its selected configuration and an explicit API key.',
    });
  }
  // The SDK otherwise lets these ambient headers override selected credentials and protocol.
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
      fillModelError(sdkFailure(cause), { model: origin.requestedModel }),
    parseUploaded: (raw) => Schema.decodeUnknownResult(UploadedFileSchema)(raw),
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
    const prepared = Schema.decodeUnknownResult(ResolvedTurnSchema)({
      ...origin,
      mode: 'foreground',
      system: input.system,
      messages: input.messages,
      tools: input.tools ?? [],
      controls: {
        ...fitLimit(config.defaults, input.maxOutputTokens),
        parallelToolCalls: config.defaults.parallelToolCalls,
        toolChoice: input.toolChoice ?? 'auto',
        effort: config.defaults.effort,
        cache: config.defaults.cache,
        stopSequences: config.defaults.stopSequences,
      },
    });
    if (!Result.isSuccess(prepared))
      return yield* new ModelError({
        kind: 'invalid-request',
        message: 'Anthropic requires complete supported invocation controls.',
        cause: prepared.failure,
      });
    yield* invocationBody(prepared.success, origin, config, uploads);
    return prepared.success;
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
          fillModelError(error, { model: origin.requestedModel }),
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
