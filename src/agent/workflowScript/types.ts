import { z } from 'zod';

const WorkflowScriptPhaseSchema = z.object({
  title: z.string().min(1),
  detail: z.string().optional(),
});

/**
 * The `export const meta = {...}` block every workflow script must begin
 * with. Must be a pure object literal — parsed and validated before the
 * script body ever runs.
 */
export const WorkflowScriptMetaSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  whenToUse: z.string().optional(),
  phases: z.array(WorkflowScriptPhaseSchema).optional(),
  /** Whole-run wall clock, bounded; an explicit run option still wins. */
  timeoutMs: z
    .int()
    .min(1_000)
    .max(60 * 60 * 1000)
    .optional(),
});

export type WorkflowScriptMeta = z.infer<typeof WorkflowScriptMetaSchema>;

/** Options accepted by the script-facing `agent()` primitive. */
export interface WorkflowAgentCallOptions {
  /** Stable identity when otherwise-identical calls occur more than once. */
  id?: string;
  /** Display label for progress UIs; defaults to a prompt excerpt. */
  label?: string;
  /** Progress group; defaults to the `phase()` active at call time. */
  phase?: string;
  /** Named TeXRA agent to run; defaults to the host runner's choice. */
  agentName?: string;
  /** Workspace or run-storage files bound as the child's input files. */
  inputFiles?: string[];
}

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

interface WorkflowScriptPhaseContext {
  phase?: string;
  /** Zero-based position in meta.phases, when phase is declared. */
  phaseIndex?: number;
  /** Number of phases declared in meta.phases. */
  phaseTotal?: number;
}

export type WorkflowScriptEvent =
  | {
      type: 'phase';
      title: string;
      /** Zero-based position in meta.phases, when the phase is declared. */
      index?: number;
      /** Number of phases declared in meta.phases. */
      total?: number;
    }
  | { type: 'log'; message: string }
  | (WorkflowScriptPhaseContext & {
      type: 'agent:start';
      index: number;
      label: string;
    })
  | (WorkflowScriptPhaseContext & {
      type: 'agent:end';
      index: number;
      label: string;
      cached: boolean;
      error?: string;
      /** Child model resolved by the runner (live calls only). */
      model?: string;
      /** Host-measured wall time of the agent() call (live calls only). */
      durationMs?: number;
    });

export interface WorkflowScriptRunOptions {
  /** Full script source, starting with `export const meta = {...}`. */
  script: string;
  /** Exposed verbatim to the script as the global `args`. */
  args?: unknown;
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
