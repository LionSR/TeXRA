/**
 * The run's tools, as the package sees them and as the ledger records them:
 * the uniform tool definitions of a `TurnRequest`, and the per-call dispatch
 * facts stamped on a `response` row so the fold and the resume rule need no
 * tool registry. Parallel-safe calls share a partition; every barrier is its
 * own; a call whose name and arguments repeat an earlier one in the same
 * window is a duplicate that never executes.
 */
import { Result } from 'effect';
import type { IToolRegistry } from '@agent/core/tools/ToolTypes';
import { partitionDuplicateCalls } from '@agent/core/flows/toolCallParsing';
import type { AgentTrace } from '@agent/trace';
import { safeParseJson } from '@common/parsing/safeParseJson';
import { JsonObjectSchema, type TurnRequest, type TurnResult } from '@llm/turn';
import type { DispatchFacts, ToolDefinition } from '@shared/schemas';

import { convertToolSchema } from './toolSchema';

export type ToolDefinitions = NonNullable<TurnRequest['tools']>;

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

/** One local call of a completed turn, with its ordinal in content order. */
export interface LocalCall {
  readonly callId: string;
  readonly name: string;
  readonly ordinal: number;
  readonly argumentsText: string;
}

export function localCallsOf(turn: TurnResult): readonly LocalCall[] {
  if (turn.kind !== 'http') return [];
  return turn.content
    .filter((part) => part.kind === 'local-call')
    .map((part, ordinal) => ({
      callId: part.providerCallId,
      name: part.name,
      ordinal,
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
 * The dispatch facts of one completed turn, stamped at append time. A
 * `logId` is minted here only for a slow tool, whose card opens before the
 * call runs; a fast tool's card opens and closes with its settlement.
 */
export function dispatchFactsFor(
  turn: TurnResult,
  registry: IToolRegistry,
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
    registry.get(call.name)?.parallelSafe === true;
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
    const tool = registry.get(call.name);
    const parallelSafe = tool?.parallelSafe === true;
    if (!(parallelSafe && previousSafe)) partition += 1;
    previousSafe = parallelSafe;
    const primaryIndex = duplicates?.get(call.callId);
    const stageId = logger.activeStageId() ?? null;
    return {
      callId: call.callId,
      toolName: call.name,
      ordinal: index,
      parallelSafe,
      partition,
      duplicateOf:
        primaryIndex === undefined ? null : parsed[primaryIndex].callId,
      logId:
        tool?.slow === true && tool.deferLogUntilApproval !== true
          ? mintLogId()
          : null,
      stageId,
    };
  });
}
