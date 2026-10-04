// Node imports
import { isDeepStrictEqual } from 'node:util';

// Third-party imports
import { Effect, Stream } from 'effect';

// Local imports - canonical model contract
import { TurnResultSchema, type TurnEvent, type TurnResult } from '../turn.js';
import { ModelError, fillModelError } from '../errors.js';
import { parseInboundToolArguments } from './transport.js';
import {
  grown,
  keyOf,
  restates,
  sameIdentity,
  type HttpTurnResult,
  type Part,
  type PartEvent,
  type Slot,
} from './parts.js';

/** What one assembly is told before its first part. */
export interface AssemblyOptions {
  readonly origin: HttpTurnResult['requestedOrigin'];
  /** Names the provider in failures: "Anthropic", "The model". */
  readonly provider: string;
  /** Known before any event: a header, or the remote operation observed. */
  readonly responseId?: string;
  /**
   * The stream may begin mid-response (a resumed observation): progress on
   * a position it never saw open is shown, not kept, and the terminal
   * snapshot supplies what it missed.
   */
  readonly partial?: boolean;
  /** What the codec adds to a completed turn: its continuation anchor. */
  readonly finalize?: (
    result: HttpTurnResult,
  ) => Effect.Effect<TurnResult, ModelError>;
}

/** What the parts have established so far; one per response. */
interface Assembly {
  readonly options: AssemblyOptions;
  id: string | undefined;
  model: string | undefined;
  fingerprint: string | undefined;
  announced: boolean;
  usage: HttpTurnResult['usage'];
  finish: Extract<PartEvent, { kind: 'finish' }> | undefined;
  readonly slots: Map<number, Slot>;
}
type Of<K extends PartEvent['kind']> = Extract<PartEvent, { kind: K }>;
type Folded = Effect.Effect<readonly TurnEvent[], ModelError>;

const fail = (turn: Assembly, what: string) =>
  Effect.fail(
    new ModelError({
      kind: 'malformed-output',
      message: `${turn.options.provider} ${what}.`,
    }),
  );
const none: Folded = Effect.succeed([]);

/**
 * The id, model and fingerprint each fill once and never change. An empty
 * id or model is observed, so it cannot follow a real one, but identifies
 * nothing; only `null` means the event did not report the field.
 */
function identify(turn: Assembly, event: Of<'identity'>): Folded {
  const pairs = [
    [turn.id, event.id],
    [turn.model, event.model],
    [turn.fingerprint, event.fingerprint],
  ];
  if (
    pairs.some(
      ([known, seen]) => known != null && seen != null && known !== seen,
    )
  )
    return fail(turn, 'changed the response identity');
  turn.id ||= event.id || undefined;
  turn.model ||= event.model || undefined;
  turn.fingerprint ??= event.fingerprint;
  if (turn.announced || turn.id === undefined) return none;
  turn.announced = true;
  return Effect.succeed([
    {
      kind: 'identified',
      providerResponseId: turn.id,
      requestedOrigin: turn.options.origin,
      returnedModel: turn.model ?? null,
    },
  ]);
}

/** Content needs an identity, and only a close follows the finish. */
function admit(
  turn: Assembly,
  closing = false,
): Effect.Effect<void, ModelError> {
  if (turn.id === undefined)
    return fail(turn, 'emitted content before its identity');
  if (turn.finish !== undefined && !closing)
    return fail(turn, 'emitted content after its terminal result');
  return Effect.void;
}

function open(turn: Assembly, { index, part }: Of<'open'>): Folded {
  const slot = turn.slots.get(index);
  if (slot === undefined) {
    turn.slots.set(index, { part, closed: false, streamedArguments: false });
    return none;
  }
  const known = slot.part;
  if (slot.closed || known?.kind !== 'local-call' || part.kind !== 'local-call')
    return fail(turn, 'reopened an output position');
  const merged = (left: string, right: string) =>
    left === '' || right === '' || left === right ? left || right : undefined;
  const providerCallId = merged(known.providerCallId, part.providerCallId);
  const name = merged(known.name, part.name);
  if (providerCallId === undefined || name === undefined)
    return fail(turn, 'changed a local tool-call identity');
  slot.part = { ...known, providerCallId, name };
  return none;
}

function append(turn: Assembly, event: Of<'append'>): Folded {
  const { channel, text, item } = event;
  const delta: readonly TurnEvent[] =
    channel === 'arguments'
      ? []
      : [
          {
            kind: 'delta',
            part: channel === 'summary' ? 'reasoning' : channel,
            text,
          },
        ];
  const slot = turn.slots.get(event.index);
  if (slot === undefined && turn.options.partial && channel !== 'arguments')
    return Effect.succeed(delta);
  const part = slot && grown(slot, channel, text);
  if (!slot || !part || (item !== undefined && keyOf(part) !== item))
    return fail(turn, 'emitted progress outside an open output item');
  slot.part = part;
  return Effect.succeed(delta);
}

function evidence(turn: Assembly, event: Of<'evidence'>): Folded {
  const slot = turn.slots.get(event.index);
  const part = slot?.part;
  if (
    slot?.closed !== false ||
    part?.kind !== 'reasoning' ||
    (part.evidence != null && !isDeepStrictEqual(part.evidence, event.evidence))
  )
    return fail(turn, 'changed or misplaced reasoning evidence');
  slot.part = { ...part, evidence: event.evidence };
  return none;
}

/** A completed item names itself, so its close may open its position. */
function close(turn: Assembly, { index, content }: Of<'close'>): Folded {
  const slot =
    turn.slots.get(index) ??
    (content
      ? { part: content, closed: false, streamedArguments: false }
      : undefined);
  if (slot === undefined)
    return fail(turn, 'closed an output position that is not open');
  turn.slots.set(index, slot);
  const part = slot.part;
  // A repeated completion may restate its item, never change it.
  if (slot.closed)
    return content && part && restates(part, content)
      ? none
      : fail(turn, 'changed completed output content');
  if (content && part && !sameIdentity(part, content))
    return fail(turn, 'changed an output item identity');
  slot.part = content === undefined ? part : content;
  slot.closed = true;
  if (content !== undefined || part?.kind !== 'local-call') return none;
  return Effect.as(
    parseInboundToolArguments(part.argumentsText, turn.options.provider),
    [],
  );
}

function finish(turn: Assembly, event: Of<'finish'>): Folded {
  if (
    turn.finish !== undefined &&
    !isDeepStrictEqual(turn.finish.finish, event.finish)
  )
    return fail(turn, 'changed the finish reason');
  turn.finish = event;
  return none;
}

/** One part folded into the assembly, with the turn events it emits. */
function step(turn: Assembly, event: PartEvent): Folded {
  switch (event.kind) {
    case 'identity':
      return identify(turn, event);
    case 'open':
      return Effect.andThen(admit(turn), () => open(turn, event));
    case 'append':
      return Effect.andThen(admit(turn), () => append(turn, event));
    case 'evidence':
      return Effect.andThen(admit(turn), () => evidence(turn, event));
    case 'close':
      return Effect.andThen(admit(turn, true), () => close(turn, event));
    case 'usage':
      turn.usage = event.usage;
      return none;
    case 'finish':
      return finish(turn, event);
  }
}

/** The streamed position a snapshot item restates, in order and in agreement. */
function restated(
  turn: Assembly,
  streamed: readonly (readonly [number, Slot])[],
  item: Part,
  previous: number,
): Effect.Effect<readonly [number, Slot] | undefined, ModelError> {
  const match = streamed.find(
    ([, slot]) => slot.part && keyOf(slot.part) === keyOf(item),
  );
  if (match === undefined) return Effect.succeed(undefined);
  const [index, slot] = match;
  if (
    index <= previous ||
    !slot.part ||
    !sameIdentity(slot.part, item) ||
    (slot.closed && !restates(slot.part, item))
  )
    return fail(turn, 'returned a snapshot contradicting its output');
  if (!slot.closed) Object.assign(slot, { part: item, closed: true });
  return Effect.succeed(match);
}

/** The snapshot's items, each streamed one replaced by what streamed. */
const reconcile = Effect.fn('llm.reconcileSnapshot')(function* (
  turn: Assembly,
  streamed: readonly (readonly [number, Slot])[],
  snapshot: readonly Part[],
  streamCovers: boolean,
) {
  const content: (Part | null)[] = [];
  let previous = -1;
  let matched = 0;
  for (const item of snapshot) {
    const match = yield* restated(turn, streamed, item, previous);
    if (match === undefined && streamCovers)
      return yield* fail(turn, 'returned a snapshot beyond its output');
    content.push(match ? match[1].part : item);
    previous = match?.[0] ?? previous;
    matched += match ? 1 : 0;
  }
  if (!streamCovers && matched < streamed.length)
    return yield* fail(turn, 'returned a snapshot that omits its output');
  return content;
});

/**
 * The content a terminal snapshot settles. A stream that saw a whole
 * response covers it, and the snapshot may restate a subset of its items.
 * Otherwise (a resumed observation, or no item streamed) the snapshot covers
 * it, and every streamed item must be among its items. A matched pair keeps
 * its order and agrees; the streamed item is the one kept.
 */
const settle = Effect.fn('llm.settleTurn')(function* (
  turn: Assembly,
  snapshot: readonly Part[] | undefined,
) {
  const partial = turn.options.partial ?? false;
  const streamed = [...turn.slots].toSorted(([left], [right]) => left - right);
  if (!partial && streamed.some(([index], ordinal) => index !== ordinal))
    return yield* fail(turn, 'omitted an output position');
  const streamCovers =
    snapshot === undefined || (!partial && streamed.length > 0);
  const content = yield* reconcile(
    turn,
    streamed,
    snapshot ?? [],
    streamCovers,
  );
  if (streamed.some(([, slot]) => !slot.closed))
    return yield* fail(turn, 'left an output item unfinished');
  const parts = streamCovers ? streamed.map(([, slot]) => slot.part) : content;
  return parts.filter((part) => part !== null);
});
/** The completed turn, once the parts have ended. */
const complete = Effect.fn('llm.completeTurn')(function* (turn: Assembly) {
  if (turn.id === undefined || turn.finish === undefined)
    return yield* fail(turn, 'ended without an identified terminal result');
  const content = yield* settle(turn, turn.finish.snapshot);
  const calls = content.some((part) => part.kind === 'local-call');
  const reason = turn.finish.finish.finishReason;
  // A tool-call finish names calls, and a plain stop leaves none.
  if ((reason === 'tool-calls' && !calls) || (reason === 'stop' && calls))
    return yield* fail(turn, 'returned inconsistent tool calls and finish');
  const result = TurnResultSchema.safeParse({
    kind: 'http',
    providerResponseId: turn.id,
    requestedOrigin: turn.options.origin,
    returnedModel: turn.model ?? null,
    modelFingerprint: turn.fingerprint ?? null,
    content,
    ...turn.finish.finish,
    usage: turn.usage,
  });
  if (!result.success || result.data.providerResponseId === null)
    return yield* new ModelError({
      kind: 'malformed-output',
      message: `${turn.options.provider} returned inconsistent completed content.`,
      cause: result.success ? undefined : result.error,
    });
  return result.data;
});

/**
 * The fold every codec feeds, for one response. It owns the response
 * identity, the parts by position, delta emission, call argument assembly,
 * finish and tool-call agreement, terminal validation, and failures
 * enriched with the identity.
 */
export function turnAssembly(options: AssemblyOptions): {
  readonly step: (event: PartEvent) => Folded;
  readonly complete: Effect.Effect<HttpTurnResult, ModelError>;
  readonly enrich: (error: ModelError) => ModelError;
} {
  const turn: Assembly = {
    options,
    id: options.responseId,
    model: undefined,
    fingerprint: undefined,
    announced: false,
    usage: null,
    finish: undefined,
    slots: new Map(),
  };
  return {
    step: (event) => step(turn, event),
    complete: Effect.suspend(() => complete(turn)),
    enrich: (error) =>
      fillModelError(error, {
        responseId: turn.id,
        model: turn.model ?? options.origin.requestedModel,
      }),
  };
}

/** A stream of part batches as turn events, ending in the completed turn. */
export const assembleTurn = (
  batches: Stream.Stream<readonly PartEvent[], ModelError>,
  options: AssemblyOptions,
): Stream.Stream<TurnEvent, ModelError> =>
  Stream.suspend(() => {
    const turn = turnAssembly(options);
    return Stream.concat(
      batches.pipe(
        Stream.mapEffect((parts) => Effect.forEach(parts, turn.step)),
        Stream.flattenIterable,
        Stream.flattenIterable,
      ),
      Stream.fromEffect(
        Effect.flatMap(turn.complete, options.finalize ?? Effect.succeed).pipe(
          Effect.map((result): TurnEvent => ({ kind: 'completed', result })),
        ),
      ),
    ).pipe(Stream.mapError(turn.enrich));
  });
