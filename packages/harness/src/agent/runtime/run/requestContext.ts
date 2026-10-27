/**
 * What the model saw, recorded: every model request is rebuilt
 * from the run's durable rows alone. The content a request carries besides
 * its history (each tool declaration, the system text, the resolved agent
 * definition) is stored once per run as a `context.blob` row under the
 * sha256 of its canonical JSON; a step's `tools.offered` row names its
 * declarations and system text by address, and an `attempt` row names the
 * request's recorded context, itself a blob, so a long conversation adds one
 * address per request, not a copy of what it sends.
 *
 * What is recorded is the turn the bound model prepared, the provider's own
 * input, so no adapter normalization falls between the record and the wire.
 * `recordedTurn` is the one reading of that record: a resumed background
 * observation rebuilds the turn it admitted from it, never from what
 * current code would render, and in development and CI the invoker checks,
 * before a request leaves the process, that the rows it just committed,
 * read back from the store, rebuild that turn exactly.
 */
import { Effect, Result, Schema } from 'effect';
import stableStringify from 'safe-stable-stringify';
import {
  JsonObjectSchema,
  ResolvedTurnSchema,
  sameModelOrigin,
  type ModelOrigin,
  type ResolvedTurn,
  type TurnRequest,
} from '@texra-ai/llm';

import { contextUpdate } from '@agent/prompt/PromptBuilder';
import {
  JsonValueSchema,
  RunContextSchema,
  Sha256Schema,
  type RunContext,
  type InvocationPurpose,
  type InvocationRef,
  type RunId,
} from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';
import type { RunHistoryDraft, RunState } from '@shared/session/runState';
import { delegationSection } from '@tools/delegation/delegationAvailability';
import { sha256 } from '@utils/core/idHash';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { envFlag } from '@utils/system/envFlags';

import { rowAggregate } from '../loop/rows';
import { addressedMessages, providerMessages } from '../storedTurn';
import type { AgentRunShape } from './AgentRun';

/**
 * The recorded context of one request: the turn the bound model prepared,
 * which is what the provider receives (the adapter owns normalization, such
 * as a Responses route trimming its instructions or filling required blank
 * ones), less its history and continuation, which the rows below its
 * attempt hold.
 */
const RecordedRequestSchema = Schema.Struct({
  mode: Schema.Literals(['foreground', 'background']),
  system: Schema.NullOr(Sha256Schema),
  tools: Schema.Array(Sha256Schema),
  /** The resolved controls: tool choice, output limit, storage and every
   *  other parameter the binding (the attempt's `origin`) sent. */
  controls: JsonValueSchema,
  /** The resolved agent definition the run was launched with. */
  agent: Sha256Schema,
});

/** The continuation a request bound to `origin` chains on, as a spreadable
 *  field; empty when the origin differs or the run holds none (a failed
 *  attempt whose chained response the vendor dropped retires it). */
export const chainedContinuation = (state: RunState, origin: ModelOrigin) =>
  state.continuation !== null &&
  sameModelOrigin(state.continuation.origin, origin)
    ? { continuation: state.continuation }
    : {};

const DeclarationSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.String,
  parameters: JsonObjectSchema,
});

/** The `context.blob` rows for the values `state` does not hold yet, each
 *  once, keyed by the sha256 of its canonical JSON. */
export function blobRows(
  runId: RunId,
  state: RunState,
  values: readonly unknown[],
): RunHistoryDraft[] {
  const stored = new Set(Object.keys(state.contents));
  return values.flatMap((value) => {
    const digest = sha256(value);
    if (stored.has(digest)) return [];
    stored.add(digest);
    return [
      {
        type: 'context.blob',
        aggregateId: rowAggregate(runId),
        payload: { digest, value: JSON.parse(stableStringify(value) ?? '') },
      },
    ];
  });
}

/** The recorded context of a request that sends `resolved`, and the
 *  resolved agent definition it names. */
function recorded(
  run: Pick<AgentRunShape, 'config' | 'persona'>,
  resolved: ResolvedTurn,
) {
  const agent = {
    agent: run.config.agent,
    persona: run.persona,
  };
  const request = {
    mode: resolved.mode,
    system: resolved.system === undefined ? null : sha256(resolved.system),
    tools: resolved.tools.map((tool) => sha256(tool)),
    controls: resolved.controls,
    agent: sha256(agent),
  };
  return { agent, request };
}

/** The address of the recorded context of a request that sends `resolved`:
 *  what its `attempt` row names. */
export const attemptRequest = (
  run: Pick<AgentRunShape, 'config' | 'persona'>,
  resolved: ResolvedTurn,
): string => sha256(recorded(run, resolved).request);

/**
 * The rows of an attempt that sends `resolved`, the turn the bound model
 * prepared: the blobs the rows do not hold yet, then the `attempt` row, which
 * names the request's recorded context and the binding's origin.
 */
export function attemptRows(
  run: Pick<AgentRunShape, 'runId' | 'config' | 'persona'>,
  state: RunState,
  invocation: InvocationRef,
  purpose: InvocationPurpose,
  origin: ModelOrigin,
  resolved: ResolvedTurn,
): RunHistoryDraft[] {
  const { agent, request } = recorded(run, resolved);
  return [
    ...blobRows(run.runId, state, [
      ...(resolved.system === undefined ? [] : [resolved.system]),
      ...resolved.tools,
      agent,
      request,
    ]),
    {
      type: 'model.message',
      aggregateId: rowAggregate(run.runId),
      payload: {
        kind: 'attempt',
        invocation,
        purpose,
        request: sha256(request),
        origin,
      },
    },
  ];
}

/**
 * The run's context at a step that renders `context` over the `base` text:
 * the system text its requests send, its sections and delegation targets
 * frozen by the run's first step and the first after a compaction so the
 * cached prefix (tools, system, history) holds, and the system message that
 * tells the model what changed since ('' for nothing).
 */
export function contextAt(
  state: RunState,
  base: string | undefined,
  context: RunContext,
): { readonly system: string | undefined; readonly update: string } {
  if (state.offeredContext === null)
    return {
      system:
        base &&
        [
          base,
          ...Object.values(context.sections),
          ...(context.delegation
            ? [delegationSection(context.delegation)]
            : []),
        ].join('\n'),
      update: '',
    };
  return {
    system:
      state.offeredSystem === null
        ? undefined
        : stored(state, state.offeredSystem, Schema.String),
    update: contextUpdate(
      stored(state, state.offeredContext, RunContextSchema),
      context,
    ),
  };
}

/** A stored value, such as the base system text or the skill catalog a
 *  snapshot names. */
export const stored = <T>(
  state: RunState,
  digest: string,
  schema: Schema.Codec<T>,
): T => Schema.decodeUnknownSync(schema)(blob(state, digest));

/** One stored blob, verified against its address: a blob that is missing
 *  or does not hash to its digest is a corrupt record. */
function blob(state: RunState, digest: string): unknown {
  const value = state.contents[digest];
  if (value === undefined)
    throw new Error(`The run's rows hold no context blob ${digest}`);
  if (sha256(value) !== digest)
    throw new Error(`The context blob ${digest} does not hash to its address`);
  return value;
}

/**
 * What the open attempt at `state` sent, rebuilt from the rows and their
 * blobs alone: its recorded context, the history the rows fold to, and the
 * continuation it carried when the binding it recorded still matched.
 * Throws on a record that cannot rebuild it.
 */
function recordedTurn(state: RunState) {
  const open = state.invocation?.current.sent;
  if (open == null) throw new Error('no sent attempt to rebuild');
  const recorded = Schema.decodeUnknownSync(RecordedRequestSchema)(
    blob(state, open.request),
  );
  blob(state, recorded.agent);
  return {
    recorded,
    origin: open.origin,
    turn: {
      mode: recorded.mode,
      ...(recorded.system === null
        ? {}
        : { system: stored(state, recorded.system, Schema.String) }),
      messages: state.messages,
      tools: recorded.tools.map((digest) =>
        Schema.decodeUnknownSync(DeclarationSchema)(blob(state, digest)),
      ),
      controls: recorded.controls,
      ...chainedContinuation(state, open.origin),
    },
  };
}

/** The session log's blob read: how a request's media addresses resolve. */
type ReadBlobs = (
  digests: readonly string[],
) => Effect.Effect<ReadonlyMap<string, string>, DatabaseReadFailed>;

/** What an invocation sends besides the history. */
export interface InvokeRequest {
  readonly system: string | undefined;
  /** The tools this turn advertises; a text-only persona advertises none. */
  readonly tools: TurnRequest['tools'];
  readonly toolChoice: TurnRequest['toolChoice'];
}

/**
 * The background turn the open attempt admitted, rebuilt from its rows on
 * the binding origin it recorded, never prepared again: what current code or
 * settings would render plays no part, so the observed completion anchors
 * the next round exactly as a live submission does. Dies on a record that
 * cannot rebuild one.
 */
export const admittedTurn = (
  state: RunState,
  blobs: ReadBlobs,
): Effect.Effect<
  Extract<ResolvedTurn, { mode: 'background' }>,
  DatabaseReadFailed
> =>
  Effect.map(providerMessages(state.messages, blobs), (messages) => {
    const { origin, turn } = recordedTurn(state);
    const admitted = Schema.decodeUnknownSync(ResolvedTurnSchema)({
      ...origin,
      ...turn,
      messages,
      ...(origin.protocol === 'openai-responses'
        ? { transport: { kind: 'http' } }
        : {}),
    });
    if (admitted.mode !== 'background')
      throw new Error('the open attempt admitted no background turn');
    return admitted;
  });

/** Why the rows at `state` do not rebuild `sent`, or null when they do. */
function mismatch(state: RunState, sent: ResolvedTurn): string | null {
  const { recorded, turn } = recordedTurn(state);
  // A tool-use request sends the declarations its step recorded as sent
  // (invariant 7): no adapter rewrites them on the way out.
  if (
    state.offeredTools !== null &&
    stableStringify(recorded.tools) !==
      stableStringify(
        state.offeredTools.flatMap(({ shown, sent }) => (sent ? [shown] : [])),
      )
  )
    return "the request does not send the tools its step's tools.offered row records";
  // Indexing `sent` rejects a key some `ResolvedTurn` variant lacks at compile
  // time; `continuation` exists on the Responses and Google variants only.
  const continuationOf = (t: object) =>
    'continuation' in t ? t.continuation : undefined;
  // The rows hold media by address; the sent turn holds the bytes those
  // addresses resolved to, so they are compared as addresses again.
  const sentTurn = {
    ...sent,
    messages: addressedMessages(sent.messages).messages,
  };
  const differ: string[] = (
    ['mode', 'system', 'messages', 'tools', 'controls'] as const
  ).filter(
    (key) => stableStringify(turn[key]) !== stableStringify(sentTurn[key]),
  );
  if (
    stableStringify(continuationOf(turn)) !==
    stableStringify(continuationOf(sent))
  )
    differ.push('continuation');
  return differ.length === 0
    ? null
    : `the rebuilt request differs in ${differ.join(', ')}`;
}

/**
 * Development and CI (`TEXRA_INTERNAL_VALIDATE_REQUEST_CONTEXT`, or under
 * Vitest): read the run back from the store and die, before the prepared
 * turn `sent` goes to the provider, unless its rows rebuild it exactly.
 */
export const checkRecordedRequest = Effect.fn('requestContext.check')(
  function* (
    run: Pick<AgentRunShape, 'runId' | 'session'>,
    sent: ResolvedTurn,
  ) {
    const on =
      (yield* envFlag('TEXRA_INTERNAL_VALIDATE_REQUEST_CONTEXT')) ||
      (yield* envFlag('VITEST'));
    if (!on) return;
    const state = yield* Effect.orDie(run.session.runHistory.load(run.runId));
    const problem = Result.merge(
      Result.try({
        try: () =>
          state === null ? 'the run has no rows' : mismatch(state, sent),
        catch: toErrorMessage,
      }),
    );
    if (problem !== null)
      return yield* Effect.die(
        new Error(
          `Request context check failed for run ${run.runId}: ${problem}. The durable rows do not record what the model is about to be sent.`,
        ),
      );
  },
);
