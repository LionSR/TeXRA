/**
 * The run's tools, as the package sees them and as the run history records them:
 * the uniform tool definitions of a `TurnRequest`, and the per-call dispatch
 * facts stamped on a `response` row so the fold and the resume rule need no
 * tool registry. Contiguous parallel calls run together; every barrier
 * runs alone; a call whose name and arguments repeat an earlier one in the same
 * window is a duplicate that never executes.
 */
import { Effect, Predicate, Result } from 'effect';
import type { RuntimeToolRegistry as IToolRegistry } from '@agent/runtime/ToolServices';
import { partitionDuplicateCalls } from '@agent/core/tools/toolCallParsing';
import type { AgentTrace } from '@agent/trace';
import { safeParseJson } from '@common/parsing/safeParseJson';
import type { DispatchFacts } from '@shared/schemas';
import type { HistoryMessage } from '@shared/session/historyTurns';
import { ensureError } from '@utils/errors/errorMessage';

/** One local call of a pending response. */
export interface LocalCall {
  readonly callId: string;
  readonly name: string;
  readonly argumentsText: string;
}

/** The local-call parts of `content`, in order. */
export function localCallsOf(
  content: Extract<HistoryMessage, { readonly role: 'assistant' }>['content'],
): readonly LocalCall[] {
  return content
    .filter((part) => part.kind === 'local-call')
    .map((part) => ({
      callId: part.providerCallId,
      name: part.name,
      argumentsText: part.argumentsText,
    }));
}

/**
 * Parse a call's argument bytes on demand (D4). Empty bytes are the empty
 * object; bytes that are not JSON stay a string the tool's own schema will
 * refuse with a diagnostic, exactly as the handler path did.
 */
export function parseCallArguments(
  call: LocalCall,
  logger: Pick<AgentTrace, 'debug'>,
): unknown {
  if (call.argumentsText.trim() === '') return {};
  const parsed = safeParseJson(call.argumentsText);
  if (Result.isFailure(parsed)) {
    logger.debug(
      `Tool call ${call.callId}: Failed to parse input as JSON, using raw string`,
    );
    return call.argumentsText;
  }
  return parsed.success;
}

/**
 * The dispatch facts of one response's local calls (an editor turn's are its
 * host's to run, so it passes none), stamped at append time. Every
 * call gets its card id here: a slow tool's card opens under it before the
 * call runs; a fast tool's opens and closes with its settlement.
 */
export function dispatchFactsFor(
  calls: readonly LocalCall[],
  /** The request's step's tools; undefined while no step is open. */
  registry: IToolRegistry | undefined,
  logger: AgentTrace,
  mintLogId: () => string,
): readonly DispatchFacts[] {
  const parsed = calls.map((call) => ({
    callId: call.callId,
    name: call.name,
    input: parseCallArguments(call, logger),
  }));
  const laneOf = (call: { readonly name: string }) =>
    registry?.get(call.name)?.lane ?? 'barrier';
  const isParallel = (call: { readonly name: string }) =>
    laneOf(call) === 'parallel';
  const duplicates =
    parsed.length > 1 ? partitionDuplicateCalls(parsed, isParallel) : null;
  if (duplicates !== null && duplicates.size > 0) {
    logger.debug(
      `Deduplicated ${duplicates.size} parallel tool call(s) with identical name and arguments`,
    );
  }
  return parsed.map((call, index) => {
    const primaryIndex = duplicates?.get(call.callId);
    return {
      callId: call.callId,
      toolName: call.name,
      ordinal: index,
      lane: laneOf(call),
      replay: registry?.get(call.name)?.replay ?? 'unsafe',
      duplicateOf:
        primaryIndex === undefined ? null : parsed[primaryIndex].callId,
      logId: mintLogId(),
      stageId: null,
    };
  });
}

/** What the model reads for a call that may have run and left no result. */
export const SKIPPED_OUTCOME_UNKNOWN =
  'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.';
/** What the model reads for a call of a recovered response that never ran. */
export const SKIPPED_NOT_STARTED =
  'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.';

/**
 * Whether an unfinished call re-runs unasked: the replay word its response
 * row (or `script.call`) saved and its tool's current one both say `safe`, and the stored
 * arguments still validate against the tool's schema (an object, for a tool
 * that carries only JSON Schema).
 */
export const replayable = Effect.fn('toolUse.replayable')(function* (
  fact: Pick<DispatchFacts, 'toolName' | 'replay'>,
  registry: IToolRegistry,
  input: unknown,
  logger: Pick<AgentTrace, 'warn'>,
) {
  const tool = registry.get(fact.toolName);
  if (fact.replay !== 'safe' || tool?.replay !== 'safe') return false;
  const schema = tool.definition.zodSchema;
  if (schema === undefined) return Predicate.isObject(input);
  const parsed = yield* Effect.tryPromise({
    try: () => schema.safeParseAsync(input),
    catch: ensureError,
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn(
          `The stored arguments of ${fact.toolName} could not be checked; the call is asked about instead of re-run.`,
          { data: error },
        );
        return null;
      }),
    ),
  );
  return parsed?.success === true;
});
