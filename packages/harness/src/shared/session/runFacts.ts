/**
 * What a run answers and what it produced, folded from the rows that record
 * them: its input (system text, instruction, activated skills, memory
 * misses), the files its calls edited and how many ran, its structured
 * output, and where its turn policy stands (the final-tool nudge, the
 * finalized answer). `foldRunState` applies this after each row it folds,
 * so the loop reads these facts off the same state on the live path and on
 * resume.
 */
import {
  STRUCTURED_OUTPUT_TOOL_NAME,
  type JsonValue,
  type RunInput,
} from '@shared/schemas';

import type { RunHistoryRow } from './historyTurns';
import type { PendingResponse } from './inFlight';

/** What a run answers and produced, as its rows record it. */
export type RunFacts = {
  /** The latest value of each field an `append` or a fork's edit recorded;
   *  an instruction absent is the launch's. */
  readonly input: Omit<RunInput, 'instruction'> & {
    readonly instruction?: string;
  };
  /** The workspace files the run's calls edited, first edit first. */
  readonly edited: readonly string[];
  /** Settlements `executed` or `failed`: tool bodies and script host answers. */
  readonly toolCalls: number;
  /** The settled value of a `submit_output` call, whether the response or
   *  one of its scripts issued it, or of a script run's handed-down call. */
  readonly structured: { readonly value: JsonValue } | null;
  /** The turn whose final-tool nudge was appended, so it is asked once. */
  readonly finalToolTurn: number | null;
  /** The final-tool nudge stands unanswered: the next response is forced. */
  readonly forceFinalTool: boolean;
  /** The latest response's answer was finalized for display. */
  readonly answerFinalized: boolean;
};

/** A run's facts before any row. */
export const NO_FACTS: RunFacts = {
  input: {},
  edited: [],
  toolCalls: 0,
  structured: null,
  finalToolTurn: null,
  forceFinalTool: false,
  answerFinalized: false,
};

/** `input` with what a row recorded: each field it names replaces the
 *  last, and a `null` instruction returns to the launch's. */
function withInput(
  input: RunFacts['input'],
  recorded: RunInput | null | undefined,
): RunFacts['input'] {
  if (recorded == null) return input;
  const { instruction: was, ...kept } = input;
  const { instruction, system, activated, memoryMisses } = recorded;
  const next = instruction === undefined ? was : (instruction ?? undefined);
  return {
    ...kept,
    ...(system !== undefined && { system }),
    ...(activated !== undefined && { activated }),
    ...(memoryMisses !== undefined && { memoryMisses }),
    ...(next !== undefined && { instruction: next }),
  };
}

/**
 * `facts` after `row`, which the run's state has already folded: `pending`
 * is that state's pending response (a settled call's record is still in
 * it) and `turn` its turn.
 */
export function foldRunFacts<F extends RunFacts>(
  facts: F,
  row: RunHistoryRow,
  pending: PendingResponse | null,
  turn: number,
): F {
  switch (row.type) {
    case 'response.finalized':
      return { ...facts, answerFinalized: true };
    case 'context.edit':
      return { ...facts, input: withInput(facts.input, row.payload.input) };
    case 'model.message': {
      const p = row.payload;
      if (p.kind === 'response')
        return { ...facts, forceFinalTool: false, answerFinalized: false };
      if (p.kind !== 'append' || p.sourceResponse !== null) return facts;
      return {
        ...facts,
        input: withInput(facts.input, p.input),
        ...(p.reason === 'final-tool' && {
          finalToolTurn: turn,
          forceFinalTool: true,
        }),
      };
    }
    case 'tool.result':
      return afterResult(facts, row.payload, pending);
    default:
      return facts;
  }
}

/** `facts` after one settlement: the files it edited, whether it ran, and,
 *  when it is the run's submitted output, its value. */
function afterResult<F extends RunFacts>(
  facts: F,
  p: Extract<RunHistoryRow, { type: 'tool.result' }>['payload'],
  pending: PendingResponse | null,
): F {
  const ran = p.disposition === 'executed' || p.disposition === 'failed';
  const edits = p.result.status === 'executed' ? (p.result.edits ?? []) : [];
  const fresh = [
    ...new Set(edits.map(({ path }) => path).filter(Boolean)),
  ].filter((path) => !facts.edited.includes(path));
  const submits = isOutputCall(pending, p.callId);
  const value = p.result.status === 'executed' ? p.result.value : undefined;
  return {
    ...facts,
    edited: fresh.length === 0 ? facts.edited : [...facts.edited, ...fresh],
    toolCalls: facts.toolCalls + (ran ? 1 : 0),
    structured: submits && value !== undefined ? { value } : facts.structured,
  };
}

/** Whether `callId` submits the run's structured output: a `submit_output`
 *  call, the response's or one of its scripts' (a script's call names its
 *  tool on its `script.call`), or a script run's handed-down call, the one
 *  call of a response no model produced. */
function isOutputCall(
  pending: PendingResponse | null,
  callId: string,
): boolean {
  if (pending === null) return false;
  const own = pending.calls.find((call) => call.callId === callId);
  const tool = pending.records[callId]?.script?.toolName ?? own?.toolName;
  return (
    tool === STRUCTURED_OUTPUT_TOOL_NAME ||
    (own !== undefined && pending.assistant.origin === null)
  );
}
