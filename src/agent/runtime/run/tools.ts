/**
 * The run's tools, as the package sees them and as the run history records them:
 * the uniform tool definitions of a `TurnRequest`, and the per-call dispatch
 * facts stamped on a `response` row so the fold and the resume rule need no
 * tool registry. Parallel-safe calls share a partition; every barrier is its
 * own; a call whose name and arguments repeat an earlier one in the same
 * window is a duplicate that never executes.
 */
import { Effect, Result } from 'effect';
import {
  JsonObjectSchema,
  type TurnRequest,
  type TurnResult,
} from '@texra-ai/llm';
import type { RuntimeToolRegistry as IToolRegistry } from '@agent/runtime/ToolServices';
import { partitionDuplicateCalls } from '@agent/core/tools/toolCallParsing';
import type { AgentTrace } from '@agent/trace';
import { safeParseJson } from '@common/parsing/safeParseJson';
import type { DispatchFacts, ToolDefinition } from '@shared/schemas';
import { isObject } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';

import { convertToolSchema } from './toolSchema';

type ToolDefinitions = NonNullable<TurnRequest['tools']>;

/** The package's uniform tool definitions for the run's resolved tool list. */
export function toolDefinitionsFor(
  definitions: readonly ToolDefinition[],
): ToolDefinitions {
  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description ?? '',
    parameters: JsonObjectSchema.parse(
      convertToolSchema(definition) ?? { type: 'object', properties: {} },
    ),
  }));
}

/** One local call of a completed turn. */
export interface LocalCall {
  readonly callId: string;
  readonly name: string;
  readonly argumentsText: string;
}

export function localCallsOf(turn: TurnResult): readonly LocalCall[] {
  if (turn.kind !== 'http') return [];
  return turn.content
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
 * The dispatch facts of one completed turn, stamped at append time. Every
 * call gets its card id here: a slow tool's card opens under it before the
 * call runs; a fast tool's opens and closes with its settlement.
 */
export function dispatchFactsFor(
  turn: TurnResult,
  /** The request's step's tools; undefined while no step is open. */
  registry: IToolRegistry | undefined,
  logger: AgentTrace,
  mintLogId: () => string,
): readonly DispatchFacts[] {
  const calls = localCallsOf(turn);
  const parsed = calls.map((call) => ({
    callId: call.callId,
    name: call.name,
    input: parseCallArguments(call, logger),
  }));
  const isParallelSafe = (call: { readonly name: string }) =>
    registry?.get(call.name)?.parallelSafe === true;
  const duplicates =
    parsed.length > 1 ? partitionDuplicateCalls(parsed, isParallelSafe) : null;
  if (duplicates !== null && duplicates.size > 0) {
    logger.debug(
      `Deduplicated ${duplicates.size} parallel tool call(s) with identical name and arguments`,
    );
  }
  let partition = -1;
  let previousSafe = false;
  return parsed.map((call, index) => {
    const parallelSafe = isParallelSafe(call);
    if (!(parallelSafe && previousSafe)) partition += 1;
    previousSafe = parallelSafe;
    const primaryIndex = duplicates?.get(call.callId);
    return {
      callId: call.callId,
      toolName: call.name,
      ordinal: index,
      parallelSafe,
      replay: registry?.get(call.name)?.replay ?? 'unsafe',
      partition,
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
  if (schema === undefined) return isObject(input);
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
