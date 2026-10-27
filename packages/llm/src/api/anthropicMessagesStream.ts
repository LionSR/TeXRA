/**
 * One Anthropic Messages response stream decoded into canonical parts. Each
 * event family has its own step over the record of what the response has
 * established so far: message_start names it, content blocks open, grow and
 * close one at a time in order, message_delta carries the stop and the
 * cumulative usage, and message_stop settles them.
 * `anthropicMessagesWire.ts` holds the event shapes these steps read.
 */
// Third-party imports
import { Effect } from 'effect';

// Local imports - canonical model contract
import { ModelError } from '../errors.js';
import { decodeWireOrFail, wireFail as fail } from './transport.js';
import {
  BlockSchema,
  EventSchema,
  StopSchema,
  UsageSchema,
} from './anthropicMessagesWire.js';
import type { TurnResult } from '../turn.js';
import type { Part, PartEvent } from './parts.js';

const FINISH = {
  end_turn: 'stop',
  max_tokens: 'length',
  stop_sequence: 'stop-sequence',
  tool_use: 'tool-calls',
  refusal: 'refusal',
  model_context_window_exceeded: 'context-window-exceeded',
} as const;

/** The sum of counts that were all reported, or `null` when one was not. */
function reportedSum(...counts: readonly (number | null)[]): number | null {
  let total = 0;
  for (const count of counts) {
    if (count === null) return null;
    total += count;
  }
  return total;
}

/** The canonical receipt of Anthropic's cumulative counters. */
function canonicalUsage(
  usage: typeof UsageSchema.Type,
): NonNullable<TurnResult['usage']> {
  const uncached = usage.input_tokens ?? null;
  const cached = usage.cache_read_input_tokens ?? null;
  const creation = usage.cache_creation_input_tokens ?? null;
  const inputTokens = reportedSum(uncached, cached, creation);
  const outputTokens = usage.output_tokens ?? null;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: cached,
    totalTokens: reportedSum(inputTokens, outputTokens),
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
function blockPart(block: typeof BlockSchema.Type): Part {
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

/** What one response's Messages events have established so far. */
interface WireState {
  /** Whether message_start named the response. */
  started: boolean;
  /** Whether message_stop ended it. */
  stopped: boolean;
  /** The index the next content block must open at. */
  next: number;
  /** The one open block: its index, its type and, for thinking, whether it is signed. */
  open:
    | { readonly index: number; readonly type: string; signed: boolean }
    | undefined;
  /** The stop facts the last message_delta carried. */
  stop: typeof StopSchema.Type;
  /** The cumulative usage reported so far. */
  usage: typeof UsageSchema.Type;
}

type WireEvent = typeof EventSchema.Type;
type EventOf<T extends WireEvent['type']> = Extract<WireEvent, { type: T }>;

function messageStart(
  state: WireState,
  message: EventOf<'message_start'>['message'],
): Effect.Effect<PartEvent[], ModelError> {
  if (
    state.started ||
    message.stop_reason != null ||
    message.stop_sequence != null ||
    message.stop_details != null ||
    message.container != null
  )
    return fail('Anthropic returned an invalid initial message.');
  state.started = true;
  state.usage = message.usage;
  return Effect.succeed([
    { kind: 'identity', id: message.id, model: message.model },
  ]);
}

function messageDelta(
  state: WireState,
  event: EventOf<'message_delta'>,
): Effect.Effect<PartEvent[], ModelError> {
  if (state.open || event.delta.container != null)
    return fail('Anthropic returned unsettled content.', 'unsupported');
  state.stop = event.delta;
  // These counters are cumulative; null/omission means no update, never zero or addition.
  state.usage = {
    ...state.usage,
    ...Object.fromEntries(
      Object.entries(event.usage).filter(([, value]) => value != null),
    ),
  };
  return Effect.succeed([]);
}

function messageStop(state: WireState): Effect.Effect<PartEvent[], ModelError> {
  const { stop } = state;
  const reason = stop.stop_reason;
  if (state.open || reason == null)
    return fail(
      'Anthropic stopped without complete content and a terminal reason.',
    );
  if (reason === 'pause_turn')
    return fail(
      'Anthropic paused hosted execution requires a separate supported continuation protocol.',
      'unsupported',
    );
  state.stopped = true;
  const refusal = stop.stop_details;
  return Effect.succeed([
    { kind: 'usage', usage: canonicalUsage(state.usage) },
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
  ]);
}

function blockStart(
  state: WireState,
  event: EventOf<'content_block_start'>,
): Effect.Effect<PartEvent[], ModelError> {
  const block = event.content_block;
  if (state.open || event.index !== state.next)
    return fail('Anthropic content blocks are not complete and ordered.');
  if (
    (block.type === 'text' && (block.citations?.length ?? 0) > 0) ||
    (block.type === 'tool_use' &&
      (block.toolset_name != null || Object.keys(block.input).length !== 0))
  )
    return fail(
      'Anthropic citations, toolsets and nonempty streamed argument placeholders are unsupported.',
      'unsupported',
    );
  state.open = {
    index: state.next++,
    type: block.type,
    signed: block.type === 'thinking' && block.signature.length > 0,
  };
  const { index } = event;
  const opened: PartEvent[] = [{ kind: 'open', index, part: blockPart(block) }];
  // A start may already carry the block's first text.
  if (block.type === 'text' && block.text)
    opened.push({ kind: 'append', index, channel: 'text', text: block.text });
  if (block.type === 'thinking' && block.thinking)
    opened.push({
      kind: 'append',
      index,
      channel: 'reasoning',
      text: block.thinking,
    });
  return Effect.succeed(opened);
}

/** A delta or stop for the open block. */
function blockUpdate(
  state: WireState,
  event: EventOf<'content_block_delta' | 'content_block_stop'>,
): Effect.Effect<PartEvent[], ModelError> {
  const open = state.open;
  if (open?.index !== event.index)
    return fail('Anthropic updated a block that is not open.');
  if (event.type === 'content_block_stop') {
    if (open.type === 'thinking' && !open.signed)
      return fail('Anthropic thinking ended without its signature.');
    state.open = undefined;
    return Effect.succeed([{ kind: 'close', index: event.index }]);
  }
  const append = (
    channel: Extract<PartEvent, { kind: 'append' }>['channel'],
    text: string,
  ): Effect.Effect<PartEvent[]> =>
    Effect.succeed([{ kind: 'append', index: open.index, channel, text }]);
  const delta = event.delta;
  switch (delta.type) {
    case 'signature_delta':
      if (open.type !== 'thinking')
        return fail('Anthropic emitted a mismatched content delta.');
      open.signed = true;
      return Effect.succeed([
        {
          kind: 'evidence',
          index: event.index,
          evidence: {
            kind: 'anthropic-thinking-signature',
            signature: delta.signature,
          },
        },
      ]);
    case 'text_delta':
      return append('text', delta.text);
    case 'thinking_delta':
      return append('reasoning', delta.thinking);
    case 'input_json_delta':
      return append('arguments', delta.partial_json);
  }
}

/**
 * One response's Messages events as parts. The wire opens one block at a
 * time, in order; message_delta carries the stop and cumulative usage, and
 * message_stop settles them. `stopped` reports whether message_stop arrived.
 */
export function anthropicWire(): {
  readonly parts: (raw: unknown) => Effect.Effect<PartEvent[], ModelError>;
  readonly stopped: () => boolean;
} {
  const state: WireState = {
    started: false,
    stopped: false,
    next: 0,
    open: undefined,
    stop: {},
    usage: {},
  };
  const parts = (raw: unknown): Effect.Effect<PartEvent[], ModelError> =>
    Effect.gen(function* () {
      const event = yield* decodeWireOrFail(
        EventSchema,
        'Anthropic returned an unsupported or malformed stream event.',
        raw,
      );
      if (event.type === 'message_start')
        return yield* messageStart(state, event.message);
      if (!state.started)
        return yield* fail(
          'Anthropic emitted content before message identity.',
        );
      if (event.type === 'message_delta')
        return yield* messageDelta(state, event);
      if (event.type === 'message_stop') return yield* messageStop(state);
      if (state.stop.stop_reason != null)
        return yield* fail(
          'Anthropic emitted content after terminal message metadata.',
        );
      if (event.type === 'content_block_start')
        return yield* blockStart(state, event);
      return yield* blockUpdate(state, event);
    });
  return { parts, stopped: () => state.stopped };
}
