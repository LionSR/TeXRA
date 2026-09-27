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
 * `recordedRequest` is the one reading of that record: a resumed background
 * observation re-prepares the request it admitted from it, never from what
 * current code would render, and in development and CI the invoker checks,
 * before a request leaves the process, that the rows it just committed,
 * read back from the store, rebuild that request exactly.
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
} from '@texra-ai/llm/turn';

import {
  JsonValueSchema,
  Sha256Schema,
  type InvocationRef,
  type RunId,
} from '@shared/schemas';
import type { RunLedgerDraft, RunState } from '@shared/session/runStateFold';
import { sha256 } from '@tools/catalogEntries';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { envFlag } from '@utils/system/envFlags';

import { rowAggregate } from '../loop/rows';
import type { AgentRunShape } from './AgentRun';

/** The recorded context of one request: everything it sends but its
 *  history and continuation, which the rows below its attempt hold. */
const RecordedRequestSchema = z.strictObject({
  mode: z.enum(['foreground', 'background']),
  system: Sha256Schema.nullable(),
  tools: z.array(Sha256Schema).nullable(),
  toolChoice: z
    .union([z.literal('auto'), z.strictObject({ name: z.string().min(1) })])
    .nullable(),
  maxOutputTokens: z.int().positive().nullable(),
  store: z.boolean().nullable(),
  /** The resolved agent definition the run was launched with. */
  agent: Sha256Schema,
  /** The controls the bound model resolved the request to: what the
   *  binding (the attempt's `origin`) sent beside it. */
  controls: JsonValueSchema,
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
): RunLedgerDraft[] {
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
 * The rows of an attempt that sends `sent`, as the bound model resolved it:
 * the blobs the rows do not hold yet, then the `attempt` row, which names
 * the request's recorded context and the binding's origin.
 */
export function attemptRows(
  run: Pick<AgentRunShape, 'runId' | 'config' | 'setting' | 'prompt'>,
  state: RunState,
  invocation: InvocationRef,
  origin: ModelOrigin,
  sent: TurnRequest,
  resolved: ResolvedTurn,
): RunLedgerDraft[] {
  const agent = {
    agent: run.config.agent,
    setting: run.setting,
    prompt: run.prompt,
  };
  const request = {
    mode: sent.mode ?? 'foreground',
    system: sent.system === undefined ? null : sha256(sent.system),
    tools: sent.tools?.map((tool) => sha256(tool)) ?? null,
    toolChoice: sent.toolChoice ?? null,
    maxOutputTokens: sent.maxOutputTokens ?? null,
    store: sent.store ?? null,
    agent: sha256(agent),
    controls: resolved.controls,
  };
  return [
    ...blobRows(run.runId, state, [
      ...(sent.system === undefined ? [] : [sent.system]),
      ...(sent.tools ?? []),
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

/** A stored text, such as the base system text a snapshot names. */
export const storedText = (state: RunState, digest: string): string =>
  z.string().parse(blob(state, digest));

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
 * The request the open attempt at `state` sent, rebuilt from the rows and
 * their blobs alone: its recorded context, the history the rows fold to, and
 * the continuation it carried when the binding it recorded still matched.
 * Throws on a record that cannot rebuild it.
 */
export function recordedRequest(state: RunState): TurnRequest {
  const open = state.openAttempt;
  if (open === null) throw new Error('no open attempt to rebuild');
  const recorded = RecordedRequestSchema.parse(blob(state, open.request));
  blob(state, recorded.agent);
  return {
    mode: recorded.mode,
    ...(recorded.system === null
      ? {}
      : { system: storedText(state, recorded.system) }),
    messages: state.messages,
    ...(recorded.tools === null
      ? {}
      : {
          tools: recorded.tools.map((digest) =>
            DeclarationSchema.parse(blob(state, digest)),
          ),
        }),
    ...(recorded.toolChoice === null
      ? {}
      : { toolChoice: recorded.toolChoice }),
    ...(recorded.maxOutputTokens === null
      ? {}
      : { maxOutputTokens: recorded.maxOutputTokens }),
    ...(recorded.store === null ? {} : { store: recorded.store }),
    ...(state.continuation !== null &&
    sameModelOrigin(state.continuation.origin, open.origin)
      ? { continuation: state.continuation }
      : {}),
  };
}

/** Why the rows at `state` do not rebuild `sent`, or null when they do. */
function mismatch(state: RunState, sent: TurnRequest): string | null {
  const open = state.openAttempt;
  if (open === null) return 'the rows hold no open attempt';
  const recorded = RecordedRequestSchema.parse(blob(state, open.request));
  // A tool-use request sends what its step recorded (invariant 7).
  if (
    state.offeredTools !== null &&
    (stableStringify(recorded.tools) !==
      stableStringify(state.offeredTools.map(({ shown }) => shown)) ||
      recorded.system !== state.offeredSystem)
  )
    return "the request does not send what its step's tools.offered row records";
  const rebuilt = recordedRequest(state);
  const keys = new Set([...Object.keys(rebuilt), ...Object.keys(sent)]);
  const differ = [...keys].filter(
    (key) =>
      stableStringify(rebuilt[key as keyof TurnRequest]) !==
      stableStringify(sent[key as keyof TurnRequest]),
  );
  return differ.length === 0
    ? null
    : `the rebuilt request differs in ${differ.join(', ')}`;
}

/**
 * Development and CI (`TEXRA_INTERNAL_VALIDATE_REQUEST_CONTEXT`, or under
 * Vitest): read the run back from the store and die, before the request is
 * sent, unless its rows rebuild `sent` exactly.
 */
export const checkRecordedRequest = Effect.fn('requestContext.check')(
  function* (run: Pick<AgentRunShape, 'runId' | 'session'>, sent: TurnRequest) {
    const on =
      (yield* envFlag('TEXRA_INTERNAL_VALIDATE_REQUEST_CONTEXT')) ||
      (yield* envFlag('VITEST'));
    if (!on) return;
    const state = yield* Effect.orDie(run.session.ledger.load(run.runId));
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
