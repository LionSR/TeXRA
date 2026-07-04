import { createSemaphore } from '@utils/core/semaphore';

import { journalKey } from './journal';
import { parseWorkflowScript } from './parseScript';
import { runScriptInSandbox } from './sandbox';
import type {
  WorkflowAgentCallOptions,
  WorkflowJournalEntry,
  WorkflowScriptEvent,
  WorkflowScriptRunOptions,
  WorkflowScriptRunResult,
} from './types';

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_AGENT_CALLS = 200;
const MAX_FANOUT = 512;
const LABEL_EXCERPT_LENGTH = 48;

/**
 * Runs a workflow script: deterministic JS orchestration over host-executed
 * agents. The script's control flow (loops, fan-out, joins, reduction) runs
 * as plain code with zero model round-trips between steps; every agent()
 * call is bounded by one shared concurrency semaphore and journaled for
 * resume (same call index + same prompt/options → cached result).
 */
export async function runWorkflowScript(
  options: WorkflowScriptRunOptions,
): Promise<WorkflowScriptRunResult> {
  const { runAgent, onEvent } = options;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAgentCalls = options.maxAgentCalls ?? DEFAULT_MAX_AGENT_CALLS;

  const { meta, body } = parseWorkflowScript(options.script);
  const priorEntries = new Map<number, WorkflowJournalEntry>(
    (options.journal ?? []).map((entry) => [entry.index, entry]),
  );
  const journal = new Map<number, WorkflowJournalEntry>();
  const semaphore = createSemaphore(concurrency);
  let callCounter = 0;
  let currentPhase: string | undefined;

  const emit = (event: WorkflowScriptEvent) => onEvent?.(event);

  async function agentPrimitive(
    prompt: unknown,
    rawOptions?: unknown,
  ): Promise<unknown> {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error(
        'agent(prompt, options?) requires a non-empty string prompt.',
      );
    }
    const callOptions = normalizeAgentOptions(rawOptions, currentPhase);
    const index = callCounter;
    callCounter += 1;
    if (callCounter > maxAgentCalls) {
      throw new Error(
        `Workflow exceeded the ${maxAgentCalls} agent-call cap (runaway-loop backstop).`,
      );
    }

    const label =
      callOptions.label ??
      prompt.slice(0, LABEL_EXCERPT_LENGTH).replaceAll(/\s+/g, ' ').trim();
    const key = journalKey(prompt, callOptions);

    const prior = priorEntries.get(index);
    if (prior && prior.key === key) {
      journal.set(index, prior);
      emit({ type: 'agent:end', index, label, cached: true });
      return prior.result;
    }

    emit({ type: 'agent:start', index, label, phase: callOptions.phase });
    try {
      const result = await semaphore.run(() =>
        runAgent({ index, prompt, options: callOptions }),
      );
      journal.set(index, { index, key, result });
      emit({ type: 'agent:end', index, label, cached: false });
      return result;
    } catch (error) {
      // A failed agent resolves to null (callers filter with .filter(Boolean))
      // and is deliberately NOT journaled, so a resume retries it.
      emit({
        type: 'agent:end',
        index,
        label,
        cached: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async function parallelPrimitive(thunks: unknown): Promise<unknown[]> {
    if (!Array.isArray(thunks)) {
      throw new Error(
        'parallel(thunks) requires an array of zero-arg functions.',
      );
    }
    if (thunks.length > MAX_FANOUT) {
      throw new Error(`parallel() accepts at most ${MAX_FANOUT} items.`);
    }
    return Promise.all(
      thunks.map(async (thunk, i) => {
        if (typeof thunk !== 'function') {
          throw new Error(`parallel(): item ${i} is not a function.`);
        }
        try {
          return await thunk();
        } catch {
          return null;
        }
      }),
    );
  }

  async function pipelinePrimitive(
    items: unknown,
    ...stages: unknown[]
  ): Promise<unknown[]> {
    if (!Array.isArray(items)) {
      throw new Error('pipeline(items, ...stages) requires an items array.');
    }
    if (items.length > MAX_FANOUT) {
      throw new Error(`pipeline() accepts at most ${MAX_FANOUT} items.`);
    }
    if (stages.length === 0 || stages.some((s) => typeof s !== 'function')) {
      throw new Error('pipeline() requires at least one stage function.');
    }
    const stageFns = stages as Array<
      (prev: unknown, item: unknown, index: number) => unknown
    >;
    // No barrier between stages: each item advances through its own chain
    // independently, so wall-clock is the slowest single-item chain.
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stageFns) {
          try {
            value = await stage(value, item, index);
          } catch {
            return null;
          }
        }
        return value;
      }),
    );
  }

  function concatPrimitive(
    parts: unknown,
    concatOptions?: { separator?: unknown },
  ): string {
    if (!Array.isArray(parts)) {
      throw new Error('concat(parts, options?) requires an array.');
    }
    const separator =
      concatOptions?.separator === undefined
        ? '\n\n'
        : String(concatOptions.separator);
    // Zero-token fan-in: drops failed (null) stage results, joins the rest.
    return parts
      .filter((part) => part !== null && part !== undefined && part !== '')
      .map(String)
      .join(separator);
  }

  const globals: Record<string, unknown> = {
    agent: agentPrimitive,
    parallel: parallelPrimitive,
    pipeline: pipelinePrimitive,
    concat: concatPrimitive,
    log: (message: unknown) => emit({ type: 'log', message: String(message) }),
    phase: (title: unknown) => {
      currentPhase = String(title);
      emit({ type: 'phase', title: currentPhase });
    },
    args:
      options.args === undefined ? undefined : structuredClone(options.args),
  };

  const result = await runScriptInSandbox(body, globals, {
    timeoutMs,
    filename: `${meta.name}.workflow.js`,
  });

  return {
    meta,
    result,
    journal: [...journal.values()].sort((a, b) => a.index - b.index),
    agentCalls: callCounter,
  };
}

function normalizeAgentOptions(
  raw: unknown,
  currentPhase: string | undefined,
): WorkflowAgentCallOptions {
  if (raw === undefined || raw === null) {
    return currentPhase === undefined ? {} : { phase: currentPhase };
  }
  if (typeof raw !== 'object') {
    throw new Error('agent() options must be an object.');
  }
  const source = raw as Record<string, unknown>;
  const options: WorkflowAgentCallOptions = {};
  for (const field of ['label', 'phase', 'agentName'] as const) {
    const value = source[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      throw new Error(`agent() option "${field}" must be a string.`);
    }
    options[field] = value;
  }
  if (source.schema !== undefined) {
    // JSON round-trip: strips cross-realm prototypes and guarantees the
    // schema is journal-key stable (throws on functions/cycles).
    options.schema = JSON.parse(JSON.stringify(source.schema)) as unknown;
  }
  if (source.inputFiles !== undefined) {
    if (
      !Array.isArray(source.inputFiles) ||
      source.inputFiles.some((file) => typeof file !== 'string')
    ) {
      throw new Error(
        'agent() option "inputFiles" must be an array of strings.',
      );
    }
    options.inputFiles = [...(source.inputFiles as string[])];
  }
  options.phase ??= currentPhase;
  return options;
}
