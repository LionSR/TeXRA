import { createHash } from 'node:crypto';

import stableStringify from 'fast-json-stable-stringify';
import { isNonEmptyString, createSemaphore } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { parseWorkflowScript } from './parseScript';
import { runScriptInSandbox } from './sandbox';
import type {
  WorkflowAgentCallOptions,
  WorkflowJournalEntry,
  WorkflowScriptEvent,
  WorkflowScriptRunOptions,
  WorkflowScriptRunResult,
} from './types';

/**
 * Stable identity for one agent() call: same prompt + options → same key,
 * regardless of object key insertion order. Used for resume: a prior
 * journal entry at the same call index with a matching key replays its
 * cached result instead of re-running the agent. sha256 (truncated) so a
 * key collision — which would replay the wrong cached result — is not a
 * practical concern.
 */
function journalKey(prompt: string, options: WorkflowAgentCallOptions): string {
  return createHash('sha256')
    .update(stableStringify({ options, prompt }))
    .digest('hex')
    .slice(0, 16);
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_AGENT_CALLS = 200;
const MAX_FANOUT = 512;
const DRAIN_GRACE_MS = 5_000;
const LABEL_EXCERPT_LENGTH = 48;

/**
 * Fan-out primitives, defined INSIDE the sandbox realm (trusted prelude,
 * compiled by the host, run before the script body). They must not live
 * host-side: parallel/pipeline/concat consume script-created arrays,
 * thunks, and promises, and any host code that calls a method on a
 * sandbox array (`thunks.map(hostCb)`) or awaits a sandbox thenable hands
 * the script a host-realm function whose .constructor is the host's
 * ungated Function constructor. Realm-side, every callback and resolve
 * function a script can capture is realm-local and codegen-gated.
 *
 * agent() and log() are the bridged globals installed before this prelude
 * runs; concurrency, journaling, and the call cap all stay host-side in
 * agentPrimitive.
 */
const ORCHESTRATION_PRELUDE = `
'use strict';
(() => {
  const MAX_FANOUT = ${MAX_FANOUT};
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, {
      value,
      writable: false,
      configurable: false,
    });
  // The run-stop backstop (call cap, timeout abort) must propagate out of
  // fan-out instead of degrading into a null slot; matched by name because
  // the host error arrives as a realm-local copy.
  const isRunAbort = (error) =>
    error !== null &&
    typeof error === 'object' &&
    error.name === 'WorkflowRunAbortError';
  const errorText = (error) =>
    error !== null && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : String(error);

  define('parallel', async function parallel(thunks) {
    if (!Array.isArray(thunks)) {
      throw new Error(
        'parallel(thunks) requires an array of zero-arg functions.',
      );
    }
    if (thunks.length > MAX_FANOUT) {
      throw new Error('parallel() accepts at most ' + MAX_FANOUT + ' items.');
    }
    return Promise.all(
      thunks.map(async (thunk, i) => {
        if (typeof thunk !== 'function') {
          throw new Error('parallel(): item ' + i + ' is not a function.');
        }
        try {
          return await thunk();
        } catch (error) {
          if (isRunAbort(error)) throw error;
          // agent() failures already resolve to null with their own event;
          // anything caught here is a bug in the script's own JS — surface
          // it so a null slot is debuggable.
          log('parallel(): item ' + i + ' threw: ' + errorText(error));
          return null;
        }
      }),
    );
  });

  define('pipeline', async function pipeline(items, ...stages) {
    if (!Array.isArray(items)) {
      throw new Error('pipeline(items, ...stages) requires an items array.');
    }
    if (items.length > MAX_FANOUT) {
      throw new Error('pipeline() accepts at most ' + MAX_FANOUT + ' items.');
    }
    if (stages.length === 0 || stages.some((s) => typeof s !== 'function')) {
      throw new Error('pipeline() requires at least one stage function.');
    }
    // No barrier between stages: each item advances through its own chain
    // independently, so wall-clock is the slowest single-item chain. Note
    // for resume: agent() calls in stages beyond the first get journal
    // indices in completion order, which varies run-to-run — the journal's
    // per-index key check keeps replay safe, at the cost of cache hits.
    return Promise.all(
      items.map(async (item, index) => {
        // The first stage receives (item, item, index): prev is seeded with
        // the item itself, not undefined.
        let value = item;
        for (const stage of stages) {
          try {
            value = await stage(value, item, index);
          } catch (error) {
            if (isRunAbort(error)) throw error;
            log('pipeline(): item ' + index + ' threw: ' + errorText(error));
            return null;
          }
        }
        return value;
      }),
    );
  });

  define('concat', function concat(parts, options) {
    if (!Array.isArray(parts)) {
      throw new Error('concat(parts, options?) requires an array.');
    }
    const separatorRaw =
      options !== null && typeof options === 'object'
        ? options.separator
        : undefined;
    const separator = separatorRaw === undefined ? '\\n\\n' : String(separatorRaw);
    // Zero-token fan-in: drops failed (null) stage results, joins the rest.
    return parts
      .filter((part) => part !== null && part !== undefined && part !== '')
      .map(String)
      .join(separator);
  });
})();
`;

/**
 * Thrown when the whole run must stop (agent-call cap exceeded, wall-clock
 * timeout abort). The realm-side parallel()/pipeline() rethrow it by name
 * instead of converting it to a null slot, so the backstops apply inside
 * fan-out primitives too. Detected by name, not instanceof — the error
 * crosses the sandbox realm boundary as a realm-local copy carrying only
 * name/message.
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
 * On wall-clock timeout the sandbox preempts guest execution, fires the run's
 * AbortSignal (passed to every runAgent invocation), and refuses new calls.
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
  ): Promise<string | undefined> {
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
      let payload: string | undefined;
      let normalizedResult: unknown;
      try {
        payload = serializeBridgeValue(prior.result, 'Cached agent() result');
        normalizedResult = deserializeBridgeValue(payload);
      } catch (error) {
        emit({
          type: 'agent:end',
          index,
          label,
          cached: true,
          error: toErrorMessage(error),
        });
        throw error;
      }
      journal.set(index, { ...prior, result: normalizedResult });
      emit({ type: 'agent:end', index, label, cached: true });
      return payload;
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
    let result: unknown;
    try {
      result = await semaphore.run(() => {
        // Re-check after waiting for a slot: a timeout/cap abort while this
        // call was queued must not launch fresh model work.
        if (runAbort.signal.aborted) {
          throw new WorkflowRunAbortError(
            'Workflow run aborted while this agent() call was queued.',
          );
        }
        return runAgent({
          index,
          prompt,
          options: callOptions,
          signal: runAbort.signal,
        });
      });
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
      return 'null';
    }

    let payload: string | undefined;
    let normalizedResult: unknown;
    try {
      // Validate before journaling. Resume storage must never contain a value
      // that the sandbox boundary cannot reproduce.
      payload = serializeBridgeValue(result, 'agent() result');
      normalizedResult = deserializeBridgeValue(payload);
    } catch (error) {
      emit({
        type: 'agent:end',
        index,
        label,
        cached: false,
        error: toErrorMessage(error),
      });
      throw error;
    }
    journal.set(index, { index, key, result: normalizedResult });
    emit({ type: 'agent:end', index, label, cached: false });
    return payload;
  }

  const argsJson = serializeBridgeValue(options.args, 'Workflow args');

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
              return await invocation;
            } finally {
              pendingAgentCalls.delete(invocation);
            }
          },
        },
        syncFns: {
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
        argsJson,
        realmPreludes: [ORCHESTRATION_PRELUDE],
      },
      {
        timeoutMs,
        filename: `${meta.name}.workflow.js`,
        onTimeout: () => runAbort.abort(),
      },
    );
  } finally {
    // Abort unconditionally once the sandbox returns. This stops in-flight
    // work the script abandoned and makes agentPrimitive reject any late call.
    runAbort.abort();
    if (pendingAgentCalls.size > 0) {
      // The script finished (or threw) with agent() calls still in flight
      // that it never awaited: wait for settlement so the returned journal
      // is final and nothing runs on after the workflow. The drain is
      // bounded — a runner that ignores the abort must not extend the run
      // past its timeout by more than the grace period; stragglers beyond
      // it are orphaned (their journal entries may be lost, which resume
      // treats as a retry).
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
    journal: [...journal.values()].toSorted((a, b) => a.index - b.index),
    agentCalls: callCounter,
  };
}

function serializeBridgeValue(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  let payload: string | undefined;
  try {
    payload = JSON.stringify(value);
  } catch (error) {
    throw new Error(
      `${label} must be JSON-serializable: ${toErrorMessage(error)}`,
    );
  }
  if (payload === undefined) {
    throw new Error(
      `${label} must be JSON-serializable; functions and symbols are not supported.`,
    );
  }
  return payload;
}

function deserializeBridgeValue(payload: string | undefined): unknown {
  return payload === undefined ? undefined : JSON.parse(payload);
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
  // Arguments crossed the bridge as JSON text (see sandbox.ts marshalArgs),
  // so `raw` is already plain, accessor-free host data; the clone here is a
  // cheap defensive copy that also keeps this function safe if it is ever
  // called with a value that did not come through the bridge.
  const source = structuredClone(raw ?? {}) as Record<string, unknown>;
  const options: WorkflowAgentCallOptions = {};
  for (const field of ['label', 'phase', 'agentName'] as const) {
    const value = source[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      throw new Error(`agent() option "${field}" must be a string.`);
    }
    options[field] = value;
  }
  for (const field of ['schema', 'outputSchema'] as const) {
    if (!Object.hasOwn(source, field)) continue;
    throw new Error(
      `agent() option "${field}" is unsupported. Pass structured data between stages through a JSON output file.`,
    );
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
