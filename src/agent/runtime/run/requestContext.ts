/**
 * What the model saw, recorded (#13394): every model request is rebuilt
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
 * observation re-prepares the request it admitted from it, never from what
 * current code would render, and in development and CI the invoker checks,
 * before a request leaves the process, that the rows it just committed,
 * read back from the store, rebuild that turn exactly.
 */
import { Effect } from 'effect';
import stableStringify from 'safe-stable-stringify';
import { z } from 'zod';
import {
  JsonObjectSchema,
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
  type InvocationRef,
  type RunId,
} from '@shared/schemas';
import type { RunHistoryDraft, RunState } from '@shared/session/runStateFold';
import { sha256 } from '@tools/catalogEntries';
import { delegationSection } from '@tools/delegation/delegationAvailability';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { envFlag } from '@utils/system/envFlags';

import { rowAggregate } from '../loop/rows';
import type { AgentRunShape } from './AgentRun';

/**
 * The recorded context of one request: the turn the bound model prepared,
 * which is what the provider receives (the adapter owns normalization, such
 * as a Responses route trimming its instructions or filling required blank
 * ones), less its history and continuation, which the rows below its
 * attempt hold.
 */
const RecordedRequestSchema = z.strictObject({
  mode: z.enum(['foreground', 'background']),
  system: Sha256Schema.nullable(),
  tools: z.array(Sha256Schema),
  /** The resolved controls: tool choice, output limit, storage and every
   *  other parameter the binding (the attempt's `origin`) sent. */
  controls: JsonValueSchema,
  /** The resolved agent definition the run was launched with. */
  agent: Sha256Schema,
  /** Set when the run's continuation matched the binding yet the request
   *  omitted it: the retry after the vendor dropped the chained response. */
  fullTranscript: z.literal(true).optional(),
});

/** The continuation a request bound to `origin` chains on, as a spreadable
 *  field; empty when the origin differs or `omit` (the full-transcript retry). */
export const chainedContinuation = (
  state: RunState,
  origin: ModelOrigin,
  omit?: boolean,
) =>
  omit !== true &&
  state.continuation !== null &&
  sameModelOrigin(state.continuation.origin, origin)
    ? { continuation: state.continuation }
    : {};

/** The controls a re-prepared request restates, where the protocol has them. */
const RestatedControlsSchema = z.looseObject({
  toolChoice: z.union([
    z.literal('auto'),
    z.strictObject({ name: z.string().min(1) }),
  ]),
  maxOutputTokens: z.int().positive().nullish(),
  promptCacheKey: z.string().min(1).nullish(),
});

const DeclarationSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
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

/**
 * The rows of an attempt that sends `resolved`, the turn the bound model
 * prepared: the blobs the rows do not hold yet, then the `attempt` row, which
 * names the request's recorded context and the binding's origin.
 */
export function attemptRows(
  run: Pick<AgentRunShape, 'runId' | 'config' | 'persona' | 'task'>,
  state: RunState,
  invocation: InvocationRef,
  origin: ModelOrigin,
  resolved: ResolvedTurn,
): RunHistoryDraft[] {
  const agent = {
    agent: run.config.agent,
    persona: run.persona,
    task: run.task,
  };
  const request = {
    mode: resolved.mode,
    system: resolved.system === undefined ? null : sha256(resolved.system),
    tools: resolved.tools.map((tool) => sha256(tool)),
    controls: resolved.controls,
    agent: sha256(agent),
    ...(!('continuation' in resolved) &&
    'continuation' in chainedContinuation(state, origin)
      ? { fullTranscript: true as const }
      : {}),
  };
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
        request: sha256(request),
        origin,
        delivery: resolved.mode === 'background' ? 'background' : 'stream',
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
        : stored(state, state.offeredSystem, z.string()),
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
  schema: z.ZodType<T>,
): T => schema.parse(blob(state, digest));

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
  const open = state.openAttempt;
  if (open === null) throw new Error('no open attempt to rebuild');
  const recorded = RecordedRequestSchema.parse(blob(state, open.request));
  blob(state, recorded.agent);
  return {
    recorded,
    turn: {
      mode: recorded.mode,
      ...(recorded.system === null
        ? {}
        : { system: stored(state, recorded.system, z.string()) }),
      messages: state.messages,
      tools: recorded.tools.map((digest) =>
        DeclarationSchema.parse(blob(state, digest)),
      ),
      controls: recorded.controls,
      ...chainedContinuation(state, open.origin, recorded.fullTranscript),
    },
  };
}

/**
 * The request that prepares again to the turn the open attempt admitted:
 * its recorded content and controls, never what current code would render.
 */
export function recordedRequest(state: RunState): TurnRequest {
  const { controls, ...content } = recordedTurn(state).turn;
  const { toolChoice, maxOutputTokens, promptCacheKey } =
    RestatedControlsSchema.parse(controls);
  return {
    ...content,
    toolChoice,
    ...(maxOutputTokens == null ? {} : { maxOutputTokens }),
    ...(promptCacheKey == null ? {} : { cacheKey: promptCacheKey }),
  };
}

/** Why the rows at `state` do not rebuild `sent`, or null when they do. */
function mismatch(state: RunState, sent: ResolvedTurn): string | null {
  const { recorded, turn } = recordedTurn(state);
  // A tool-use request sends the declarations its step recorded
  // (invariant 7): no adapter rewrites them on the way out.
  if (
    state.offeredTools !== null &&
    stableStringify(recorded.tools) !==
      stableStringify(state.offeredTools.map(({ shown }) => shown))
  )
    return "the request does not send the tools its step's tools.offered row records";
  const sentFields: Record<string, unknown> = sent;
  const rebuilt: Record<string, unknown> = turn;
  const differ = [
    'mode',
    'system',
    'messages',
    'tools',
    'controls',
    'continuation',
  ].filter(
    (key) => stableStringify(rebuilt[key]) !== stableStringify(sentFields[key]),
  );
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
    let problem: string | null;
    try {
      problem = state === null ? 'the run has no rows' : mismatch(state, sent);
    } catch (error) {
      problem = toErrorMessage(error);
    }
    if (problem !== null)
      return yield* Effect.die(
        new Error(
          `Request context check failed for run ${run.runId}: ${problem}. The durable rows do not record what the model is about to be sent.`,
        ),
      );
  },
);
