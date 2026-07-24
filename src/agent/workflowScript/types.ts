import { z } from 'zod';

import type { WorkflowScriptFiles } from '@shared/schemas/workflowScriptFiles';

const WorkflowScriptPhaseSchema = z.object({
  title: z.string().trim().min(1),
  detail: z.string().optional(),
});

const WorkflowScriptTaskSchema = z.strictObject({
  /** Stable identity referenced by agent(..., { id }). */
  id: z.string().trim().min(1),
  /** Human-readable task name shown on progress surfaces. */
  label: z.string().trim().min(1),
  /** Optional declared phase; must name one of meta.phases when present. */
  phase: z.string().trim().min(1).optional(),
});

export type WorkflowScriptTask = z.infer<typeof WorkflowScriptTaskSchema>;

/**
 * The `export const meta = {...}` block every workflow script must begin
 * with. Must be a pure object literal — parsed and validated before the
 * script body ever runs.
 */
export const WorkflowScriptMetaSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    whenToUse: z.string().optional(),
    phases: z.array(WorkflowScriptPhaseSchema).optional(),
    /**
     * Declarative task plan. When present, every agent() call references one
     * task by id; label and phase live here rather than being duplicated in
     * executable code.
     */
    tasks: z.array(WorkflowScriptTaskSchema).optional(),
    /** Whole-run wall clock, bounded; an explicit run option still wins. */
    timeoutMs: z
      .int()
      .min(1_000)
      .max(60 * 60 * 1000)
      .optional(),
  })
  .superRefine((meta, context) => {
    const phaseTitles = new Set<string>();
    for (const [index, phase] of (meta.phases ?? []).entries()) {
      if (phaseTitles.has(phase.title)) {
        context.addIssue({
          code: 'custom',
          path: ['phases', index, 'title'],
          message: `Duplicate phase title "${phase.title}".`,
        });
      }
      phaseTitles.add(phase.title);
    }

    const taskIds = new Set<string>();
    for (const [index, task] of (meta.tasks ?? []).entries()) {
      if (taskIds.has(task.id)) {
        context.addIssue({
          code: 'custom',
          path: ['tasks', index, 'id'],
          message: `Duplicate task id "${task.id}".`,
        });
      }
      taskIds.add(task.id);
      if (task.phase !== undefined && !phaseTitles.has(task.phase)) {
        context.addIssue({
          code: 'custom',
          path: ['tasks', index, 'phase'],
          message: `Task phase "${task.phase}" is not declared in meta.phases.`,
        });
      }
    }
  });

export type WorkflowScriptMeta = z.infer<typeof WorkflowScriptMetaSchema>;

interface WorkflowAgentCallBaseOptions {
  /** Stable identity when otherwise-identical calls occur more than once. */
  id?: string;
  /** Display label for progress UIs; defaults to a prompt excerpt. */
  label?: string;
  /** Progress group; defaults to the `phase()` active at call time. */
  phase?: string;
  /** Available model short name for this call; otherwise follows delegation policy. */
  model?: string;
}

interface WorkflowAgentFileOptions {
  /** Workspace or run-storage files the workflow agent may rewrite. */
  inputFiles?: WorkflowScriptFiles['inputFiles'];
  /** Read-only supporting documents for the workflow agent. */
  contextFiles?: WorkflowScriptFiles['contextFiles'];
  /** Read-only visual or audio inputs for the workflow agent. */
  mediaFiles?: WorkflowScriptFiles['mediaFiles'];
}

/** A script call to a file-editing workflow agent. */
interface WorkflowEditAgentCallOptions
  extends WorkflowAgentCallBaseOptions, WorkflowAgentFileOptions {
  /** Named TeXRA agent to run; defaults to the host runner's choice. */
  agentName?: string;
  schema?: never;
}

/** A script call to a tool-use agent that returns a structured value. */
interface WorkflowStructuredAgentCallOptions extends WorkflowAgentCallBaseOptions {
  /** Structured calls must name a tool-use agent explicitly. */
  agentName: string;
  inputFiles?: never;
  contextFiles?: never;
  mediaFiles?: never;
  /**
   * Plain JSON Schema object describing the structured result the call must
   * produce. Its presence routes the call to a tool-use agent that finishes by
   * submitting a validated value, surfaced on the result's `.structured`.
   * Participates in the journal key, so resume stays correct.
   */
  schema: Record<string, unknown>;
}

/** Options accepted by the script-facing `agent()` primitive. */
export type WorkflowAgentCallOptions =
  WorkflowEditAgentCallOptions | WorkflowStructuredAgentCallOptions;

export interface WorkflowAgentInvocation {
  /** 0-based call sequence number; also the journal key position. */
  index: number;
  /** Stable hash of the prompt and normalized call options. */
  key: string;
  prompt: string;
  options: WorkflowAgentCallOptions;
  /**
   * Fires when the run is aborted (wall-clock timeout). Runners should
   * cancel the underlying agent execution so timed-out workflows stop
   * consuming model quota instead of finishing in the background.
   */
  signal: AbortSignal;
  /**
   * Optional host-side side channel: the runner reports the child model it
   * resolved so the engine can attach it to the matching `agent:end` event
   * for progress UIs. Never journaled — it does not affect resume identity.
   */
  reportModel?: (model: string) => void;
}

/**
 * Host-provided executor for one `agent()` call. Tests use a fake; a
 * production host wires this to the in-band subagent execution path so the
 * engine receives the typed AgentFinalResult envelope, never the XML
 * follow-up delivery string.
 */
export type WorkflowAgentRunner = (
  invocation: WorkflowAgentInvocation,
) => Promise<unknown>;

/** One completed agent() call, cached for resume. */
export interface WorkflowJournalEntry {
  index: number;
  /** Stable hash of (prompt, options); mismatch forces a live re-run. */
  key: string;
  result: unknown;
}

export interface WorkflowScriptPhaseContext {
  phase?: string;
  /** Zero-based position in meta.phases, when phase is declared. */
  phaseIndex?: number;
  /** Number of phases declared in meta.phases. */
  phaseTotal?: number;
}

interface WorkflowScriptAgentEventBase extends WorkflowScriptPhaseContext {
  /** Declarative task id, or a run-local id for an undeclared dynamic call. */
  taskId: string;
  index: number;
  label: string;
}

export type WorkflowScriptEvent =
  | {
      type: 'plan';
      tasks: readonly WorkflowScriptTask[];
    }
  | {
      type: 'phase';
      title: string;
      /** Zero-based position in meta.phases, when the phase is declared. */
      index?: number;
      /** Number of phases declared in meta.phases. */
      total?: number;
    }
  | { type: 'log'; message: string }
  | (WorkflowScriptAgentEventBase & {
      type: 'agent:start';
    })
  | (WorkflowScriptAgentEventBase & {
      type: 'agent:end';
      outcome: 'cached';
    })
  | (WorkflowScriptAgentEventBase & {
      type: 'agent:end';
      outcome: 'completed';
      /** Child model resolved by the runner (live calls only). */
      model?: string;
      /** Host-measured wall time of the agent() call (live calls only). */
      durationMs: number;
    })
  | (WorkflowScriptAgentEventBase & {
      type: 'agent:end';
      outcome: 'failed';
      error: string;
      /** Child model resolved by the runner, when resolution succeeded. */
      model?: string;
      /** Host-measured wall time, when an agent attempt began. */
      durationMs?: number;
    })
  | (WorkflowScriptAgentEventBase & {
      type: 'agent:end';
      outcome: 'skipped';
    });

/**
 * Guest-visible result of a call cancelled via `control.skip(index)`: a
 * first-class sentinel distinct from a failed call's `null`, so a script (or
 * host) can tell "deliberately skipped" apart from "runner failed". Skipped
 * calls are never journaled, so a later resume re-runs them.
 */
export const WORKFLOW_SKIPPED_RESULT = '__WORKFLOW_SKIPPED__';

/**
 * Per-call control handle for an in-flight run, handed to the host once via
 * {@link WorkflowScriptRunOptions.onControl}. Control actions are control-plane
 * only: they never touch the journal, checkpoint, or per-call resume identity.
 */
export interface WorkflowScriptControl {
  /**
   * Cancel a single in-flight `agent()` call as a deliberate skip. The call
   * resolves to {@link WORKFLOW_SKIPPED_RESULT} and is not journaled. No-op if
   * the call at `index` is not currently in flight.
   */
  skip(index: number): void;
  /**
   * Cancel and re-run a single in-flight `agent()` call as a fresh attempt;
   * the call resolves with the new attempt's result. No-op if the call at
   * `index` is not currently in flight.
   */
  retry(index: number): void;
}

export interface WorkflowScriptRunOptions {
  /** Full script source, starting with `export const meta = {...}`. */
  script: string;
  /** Exposed verbatim to the script as the global `args`. */
  args?: unknown;
  /** Exposed to the script as the immutable global `files` object. */
  files?: WorkflowScriptFiles;
  runAgent: WorkflowAgentRunner;
  /** Parent cancellation signal; aborts guest execution and active agents. */
  signal?: AbortSignal;
  /** Max concurrently running agent() calls. Default 4. */
  concurrency?: number;
  /** Journal from a prior run; per-index key matches return cached results. */
  journal?: WorkflowJournalEntry[];
  /**
   * Durable checkpoint hook for a successfully validated live call. The
   * engine awaits it before the result becomes visible to the script, so a
   * host restart cannot expose work whose journal entry was never persisted.
   */
  onJournalEntry?: (entry: WorkflowJournalEntry) => void | Promise<void>;
  onEvent?: (event: WorkflowScriptEvent) => void;
  /**
   * Handed the per-call control handle once, synchronously, before the script
   * body runs, so a host can wire interactive skip/retry to in-flight calls.
   */
  onControl?: (control: WorkflowScriptControl) => void;
  /** Wall-clock cap for the whole script. Default 10 minutes. */
  timeoutMs?: number;
  /** Lifetime agent() call cap (runaway-loop backstop). Default 200. */
  maxAgentCalls?: number;
}

export interface WorkflowScriptRunResult {
  meta: WorkflowScriptMeta;
  /** The script body's return value. */
  result: unknown;
  /** Completed calls in index order, for resume. Failed calls are omitted. */
  journal: WorkflowJournalEntry[];
  /** Total agent() calls issued (cached and live). */
  agentCalls: number;
}
