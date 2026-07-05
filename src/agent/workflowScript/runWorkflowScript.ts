import { toErrorMessage } from '@common/errors';
import { isNonEmptyString } from '@utils/core';
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
const DRAIN_GRACE_MS = 5_000;
const LABEL_EXCERPT_LENGTH = 48;

/**
 * Thrown when the whole run must stop (agent-call cap exceeded, wall-clock
 * timeout abort). parallel()/pipeline() rethrow it instead of converting it
 * to a null slot, so the backstops apply inside fan-out primitives too.
 * Detected by name, not instanceof — the error crosses the sandbox realm
 * boundary as a realm-local copy carrying only name/message.
 */
export class WorkflowRunAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowRunAbortError';
  }
}

function isWorkflowAbort(error: unknown): boolean {
  // Name check, not instanceof: abort errors re-enter host code as
  // realm-local Error copies whose prototype chain is the sandbox's.
  return (
    error instanceof WorkflowRunAbortError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'WorkflowRunAbortError')
  );
}

/**
 * Runs a workflow script: deterministic JS orchestration over host-executed
 * agents. The script's control flow (loops, fan-out, joins, reduction) runs
 * as plain code with zero model round-trips between steps; every agent()
 * call is bounded by one shared concurrency semaphore and journaled for
 * resume (same call index + same prompt/options → cached result).
 *
 * On wall-clock timeout the run's AbortSignal (passed to every runAgent
 * invocation) fires and new agent() calls are refused; the orphaned script
 * continuation can then only run pure JS to completion.
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
  const runAbort = new AbortController();
  // Journal replays are free: only live runAgent executions count against
  // the runaway-loop cap, so a resume can replay past the cap and finish
  // the remaining work.
  let liveCallCounter = 0;
  // agent() invocations the script may have abandoned without awaiting
  // (e.g. `const p = agent('x'); return 'done'`). Drained on completion so
  // no runner keeps consuming quota or emitting events after the run ends.
  const pendingAgentCalls = new Set<Promise<unknown>>();
  let callCounter = 0;
  let currentPhase: string | undefined;

  const emit = (event: WorkflowScriptEvent) => onEvent?.(event);

  async function agentPrimitive(
    prompt: unknown,
    rawOptions?: unknown,
  ): Promise<unknown> {
    if (runAbort.signal.aborted) {
      throw new WorkflowRunAbortError(
        'Workflow run aborted (timeout or call cap); no new agent() calls may start.',
      );
    }
    if (!isNonEmptyString(prompt)) {
      throw new Error(
        'agent(prompt, options?) requires a non-empty string prompt.',
      );
    }
    const callOptions = normalizeAgentOptions(rawOptions, currentPhase);
    const index = callCounter;
    callCounter += 1;

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

    liveCallCounter += 1;
    if (liveCallCounter > maxAgentCalls) {
      // Abort first so in-flight sibling agents stop consuming quota — the
      // backstop must cancel the fan-out, not just fail this one call.
      runAbort.abort();
      throw new WorkflowRunAbortError(
        `Workflow exceeded the ${maxAgentCalls} live agent-call cap (runaway-loop backstop; journal replays are free).`,
      );
    }

    emit({ type: 'agent:start', index, label, phase: callOptions.phase });
    try {
      const result = await semaphore.run(() =>
        runAgent({
          index,
          prompt,
          options: callOptions,
          signal: runAbort.signal,
        }),
      );
      journal.set(index, { index, key, result });
      emit({ type: 'agent:end', index, label, cached: false });
      return result;
    } catch (error) {
      // A runner may surface the run abort (it holds runAbort.signal);
      // that must stop the workflow, not degrade into a null agent result.
      if (isWorkflowAbort(error)) throw error;
      // A failed agent resolves to null (callers filter with .filter(Boolean))
      // and is deliberately NOT journaled, so a resume retries it.
      emit({
        type: 'agent:end',
        index,
        label,
        cached: false,
        error: toErrorMessage(error),
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
        } catch (error) {
          if (isWorkflowAbort(error)) throw error;
          // agent() failures already resolve to null with their own event;
          // anything caught here is a bug in the script's own JS — surface
          // it so a null slot is debuggable.
          emit({
            type: 'log',
            message: `parallel(): item ${i} threw: ${toErrorMessage(error)}`,
          });
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
    // independently, so wall-clock is the slowest single-item chain. Note
    // for resume: agent() calls in stages beyond the first get journal
    // indices in completion order, which varies run-to-run — the journal's
    // per-index key check keeps replay safe, at the cost of cache hits.
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stageFns) {
          try {
            value = await stage(value, item, index);
          } catch (error) {
            if (isWorkflowAbort(error)) throw error;
            emit({
              type: 'log',
              message: `pipeline(): item ${index} threw: ${toErrorMessage(error)}`,
            });
            return null;
          }
        }
        return value;
      }),
    );
  }

  function concatPrimitive(parts: unknown, concatOptions?: unknown): string {
    if (!Array.isArray(parts)) {
      throw new Error('concat(parts, options?) requires an array.');
    }
    const separatorRaw =
      concatOptions && typeof concatOptions === 'object'
        ? (concatOptions as { separator?: unknown }).separator
        : undefined;
    const separator =
      separatorRaw === undefined ? '\n\n' : String(separatorRaw);
    // Zero-token fan-in: drops failed (null) stage results, joins the rest.
    return parts
      .filter((part) => part !== null && part !== undefined && part !== '')
      .map(String)
      .join(separator);
  }

  // JSON payloads for the sandbox bridge: results are revived inside the
  // realm with the sandbox's own JSON.parse, so scripts never hold
  // host-realm objects (see sandbox.ts). Non-JSON-safe values degrade the
  // way JSON always does; agent results are JSON-safe by contract.
  const toPayload = (value: unknown): string | undefined =>
    value === undefined ? undefined : (JSON.stringify(value) ?? 'null');

  let result: unknown;
  try {
    result = await runScriptInSandbox(
      body,
      {
        asyncFns: {
          agent: async (args) => {
            const invocation = agentPrimitive(args[0], args[1]);
            pendingAgentCalls.add(invocation);
            try {
              return toPayload(await invocation);
            } finally {
              pendingAgentCalls.delete(invocation);
            }
          },
          parallel: async (args) => toPayload(await parallelPrimitive(args[0])),
          pipeline: async (args) =>
            toPayload(await pipelinePrimitive(args[0], ...args.slice(1))),
        },
        syncFns: {
          concat: (args) => concatPrimitive(args[0], args[1]),
          log: (args) => {
            emit({ type: 'log', message: String(args[0]) });
            return undefined;
          },
          phase: (args) => {
            currentPhase = String(args[0]);
            emit({ type: 'phase', title: currentPhase });
            return undefined;
          },
        },
        argsJson:
          options.args === undefined ? undefined : JSON.stringify(options.args),
      },
      {
        timeoutMs,
        filename: `${meta.name}.workflow.js`,
        onTimeout: () => runAbort.abort(),
      },
    );
  } finally {
    if (pendingAgentCalls.size > 0) {
      // The script finished (or threw) with agent() calls still in flight
      // that it never awaited: cancel them and wait for settlement so the
      // returned journal is final and nothing runs on after the workflow.
      // The drain is bounded — a runner that ignores the abort must not
      // extend the run past its timeout by more than the grace period;
      // stragglers beyond it are orphaned (their journal entries may be
      // lost, which resume treats as a retry).
      runAbort.abort();
      let graceTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...pendingAgentCalls]),
          new Promise<void>((resolve) => {
            graceTimer = setTimeout(resolve, DRAIN_GRACE_MS);
          }),
        ]);
      } finally {
        if (graceTimer) clearTimeout(graceTimer);
      }
    }
  }

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
  if (
    (raw !== undefined && raw !== null && typeof raw !== 'object') ||
    Array.isArray(raw)
  ) {
    throw new Error('agent() options must be a plain object.');
  }
  // Normalize to plain JSON data in one pass before any field reads:
  // sandbox-defined accessors then fire exactly once, here, instead of on
  // every host-side property access, and the retained options carry no
  // live realm objects. (Non-terminating accessors fall under the
  // documented preemption gate, like all post-await CPU-bound code.)
  const source = JSON.parse(JSON.stringify(raw ?? {})) as Record<
    string,
    unknown
  >;
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
    // Already plain data via the normalization above; journal-key stable.
    options.schema = source.schema;
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
