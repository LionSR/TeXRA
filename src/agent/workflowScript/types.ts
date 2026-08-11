import { z } from 'zod';

import {
  WorkflowCallIdentitySchema,
  type ExecutionId,
  type WorkflowCallIdentity,
  type WorkflowExecutionSnapshot,
  type StreamTabId,
} from '@shared/schemas';
import type { WorkflowScriptFiles } from '@shared/schemas/workflowScriptFiles';
import { normalizeStructuredOutputSchema } from '@tools/structuredOutput';
import { toErrorMessage } from '@utils/errors/errorMessage';

const WorkflowScriptPhaseTitleSchema = z
  .string()
  .trim()
  .min(1, 'Workflow phase title must not be blank.');

/** Normalize every executable phase-title input to the metadata schema form. */
export function normalizeWorkflowScriptPhaseTitle(title: string): string {
  return WorkflowScriptPhaseTitleSchema.parse(title);
}

const WorkflowScriptPhaseSchema = z.union([
  z.strictObject({ title: WorkflowScriptPhaseTitleSchema }),
  WorkflowScriptPhaseTitleSchema.transform((title) => ({ title })),
]);

/**
 * The `export const meta = {...}` block every workflow script must begin
 * with. Must be a pure object literal — parsed and validated before the
 * script body ever runs.
 */
export const WorkflowScriptMetaSchema = z
  .strictObject({
    name: z.string().min(1),
    description: z.string().min(1),
    phases: z.array(WorkflowScriptPhaseSchema).optional(),
    /**
     * Declarative task plan. When present, every agent() call references one
     * task by id; label and phase live here rather than being duplicated in
     * executable code.
     */
    tasks: z.array(WorkflowCallIdentitySchema).optional(),
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

/**
 * One string `agent()` option and the copy it rejects with. `content` fields
 * (`id`, `phase`, `model`) are trimmed and must carry text, `trimmed` fields
 * (`label`) may end up blank, and `verbatim` fields (`agentName`) are taken as
 * written — the three forms the journal key has always recorded.
 */
function agentOptionString(
  field: string,
  form: 'content' | 'trimmed' | 'verbatim',
): z.ZodString {
  const message = `agent() option "${field}" must be ${form === 'content' ? 'a non-empty string' : 'a string'}.`;
  const text = z.string({ error: message });
  if (form === 'verbatim') return text;
  return form === 'content' ? text.trim().min(1, message) : text.trim();
}

const AGENT_FILE_OPTIONS_ERROR =
  'agent() options "inputFiles", "contextFiles", and "mediaFiles" must be arrays of non-empty strings.';

/**
 * File option list. Deliberately NOT
 * {@link @shared/schemas/workflowScriptFiles.WorkflowScriptFilesSchema}: that
 * one prefaults the absent lists to `[]`, and a spurious empty list would
 * change the journal key of an otherwise identical call.
 */
const AgentCallFileListSchema = z
  .array(
    z
      .string({ error: AGENT_FILE_OPTIONS_ERROR })
      .trim()
      .min(1, AGENT_FILE_OPTIONS_ERROR),
    { error: AGENT_FILE_OPTIONS_ERROR },
  )
  .readonly();

/**
 * Plain JSON Schema object describing the structured result a call must
 * produce, normalized to the same canonical form the tool-use terminal tool is
 * built from. Its presence routes the call to a tool-use agent that finishes by
 * submitting a validated value, surfaced on the result's `.structured`.
 * Participates in the journal key, so resume stays correct.
 */
const AgentCallStructuredSchemaSchema = z
  .record(z.string(), z.unknown(), {
    error: 'agent() option "schema" must be a plain JSON Schema object.',
  })
  .transform((jsonSchema, context) => {
    try {
      return normalizeStructuredOutputSchema(jsonSchema).jsonSchema;
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: `agent() option "schema" is not a supported object-root JSON Schema: ${toErrorMessage(error)}`,
      });
      return z.NEVER;
    }
  });

/**
 * Every option the script-facing `agent()` primitive accepts. This shape is the
 * single source of truth: the allowed-field list in the rejection copy, the
 * per-field rules, and {@link WorkflowAgentCallOptions} all derive from it.
 */
const workflowAgentCallOptionShape = {
  /**
   * Stable logical call id and journal disambiguator. Dynamic calls use it as
   * their persisted progress id; when omitted they fall back to call order.
   */
  id: agentOptionString('id', 'content').optional(),
  /** Display label for progress UIs. */
  label: agentOptionString('label', 'trimmed').optional(),
  /** Progress group; defaults to the `phase()` active at call time. */
  phase: agentOptionString('phase', 'content').optional(),
  /** Named TeXRA agent to run; defaults to the host runner's choice. */
  agentName: agentOptionString('agentName', 'verbatim').optional(),
  /** Available model short name for this call; otherwise follows delegation policy. */
  model: agentOptionString('model', 'content').optional(),
  schema: AgentCallStructuredSchemaSchema.optional(),
  /** Workspace or run-storage files the workflow agent may rewrite. */
  inputFiles: AgentCallFileListSchema.optional(),
  /** Read-only supporting documents for the workflow agent. */
  contextFiles: AgentCallFileListSchema.optional(),
  /** Read-only visual or audio inputs for the workflow agent. */
  mediaFiles: AgentCallFileListSchema.optional(),
};

const WORKFLOW_AGENT_OPTION_FIELDS = Object.keys(workflowAgentCallOptionShape);

/**
 * Field rules plus the two cross-field rules that separate a structured
 * tool-use call from a file-editing workflow call. Reported as a flat issue
 * list so the guest sees one precise sentence; the union below only re-states
 * the outcome as a type.
 */
const WorkflowAgentCallOptionsInputSchema = z
  .strictObject(workflowAgentCallOptionShape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? `agent() option "${issue.keys[0]}" is not recognized. Allowed options: ${WORKFLOW_AGENT_OPTION_FIELDS.join(', ')}.`
        : 'agent() options must be a plain object.',
  })
  .superRefine((options, context) => {
    if (options.schema === undefined) return;
    if (
      options.inputFiles !== undefined ||
      options.contextFiles !== undefined ||
      options.mediaFiles !== undefined
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'agent() structured-output calls cannot use file options; inputFiles, contextFiles, and mediaFiles belong to workflow-agent calls.',
      });
    }
    if (options.agentName === undefined) {
      context.addIssue({
        code: 'custom',
        message:
          'agent() structured-output calls must name a tool-use agent with "agentName".',
      });
    }
  });

/** A script call to a tool-use agent that returns a structured value. */
const WorkflowStructuredAgentCallOptionsSchema = z.strictObject({
  ...workflowAgentCallOptionShape,
  /** Structured calls must name a tool-use agent explicitly. */
  agentName: z.string(),
  schema: z.record(z.string(), z.unknown()),
  inputFiles: z.never().optional(),
  contextFiles: z.never().optional(),
  mediaFiles: z.never().optional(),
});

/** A script call to a file-editing workflow agent. */
const WorkflowEditAgentCallOptionsSchema = z.strictObject({
  ...workflowAgentCallOptionShape,
  schema: z.never().optional(),
});

/**
 * Options accepted by the script-facing `agent()` primitive.
 *
 * The pipe target restates the validated result as the two mutually exclusive
 * call kinds so `options.schema !== undefined` narrows `agentName` to a string
 * at every consumer. The refinements above already decided which arm applies,
 * so it never rejects and never reaches the guest as an error.
 */
export const WorkflowAgentCallOptionsSchema =
  WorkflowAgentCallOptionsInputSchema.pipe(
    z.union([
      WorkflowStructuredAgentCallOptionsSchema,
      WorkflowEditAgentCallOptionsSchema,
    ]),
  );

export type WorkflowAgentCallOptions = z.infer<
  typeof WorkflowAgentCallOptionsSchema
>;

export interface WorkflowAgentInvocation {
  /** 0-based call sequence number; also the journal key position. */
  index: number;
  /** Stable logical call identity within the workflow execution snapshot. */
  progressId: WorkflowScriptProgressId;
  /** Stable hash of the prompt and normalized execution-affecting options. */
  key: string;
  /** Opaque host fingerprint already incorporated into `key`, when present. */
  dependencyFingerprint?: string;
  prompt: string;
  options: WorkflowAgentCallOptions;
  /**
   * Fires when the run is aborted (wall-clock timeout). Runners should
   * cancel the underlying agent execution so timed-out workflows stop
   * consuming model quota instead of finishing in the background.
   */
  signal: AbortSignal;
  /**
   * Optional host-side side channel: the runner reports whatever it has
   * resolved for the live attempt, in whatever combination it learns them.
   * Never journaled — none of it affects resume identity.
   */
  report?: (facts: WorkflowAttemptFacts) => void;
}

/**
 * Progress-only facts a host runner resolves for one live attempt. Every field
 * is independent: a runner reports the ones it has learned, and an omitted
 * field leaves the engine's current value in place.
 */
export interface WorkflowAttemptFacts {
  /**
   * The child model the runner resolved, so the engine can attach it to the
   * matching `agent:end` event for progress UIs.
   */
  readonly model?: string;
  /** The resolved agent the host selected. */
  readonly agent?: string;
  /** The physical child execution selected for this attempt. */
  readonly childExecutionId?: ExecutionId;
  /**
   * The live child stream, once the host has resolved its agent, model, and
   * execution identity. Progress renderers use it as the task card's
   * navigation target.
   */
  readonly childStreamId?: StreamTabId;
  /** Cost available on the child result. */
  readonly costUsd?: number;
  /**
   * Marks facts re-attached from a durably recovered result rather than
   * resolved for a live attempt. Recovered ids carry navigation metadata
   * only — the engine must not register them as skip/retry targets, since
   * the result they name is already authoritative.
   */
  readonly recovered?: true;
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
  /** Stable call hash including host-resolved dependency fingerprints. */
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

/** Identity used only to correlate one changing progress record in a run. */
export type WorkflowScriptProgressId = WorkflowCallIdentity['id'];

interface WorkflowScriptAgentEventBase extends WorkflowScriptPhaseContext {
  /**
   * Declarative task id, or a unique run-local id for an undeclared dynamic
   * call. Distinct from the optional journal disambiguator on agent options.
   */
  progressId: WorkflowScriptProgressId;
  index: number;
  label: string;
  childStreamId?: StreamTabId;
}

export type WorkflowScriptEvent =
  | {
      type: 'plan';
      tasks: readonly WorkflowCallIdentity[];
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
      type: 'agent:stream';
      childStreamId: StreamTabId;
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
      /**
       * Spend the execution snapshot has recorded for this call across every
       * physical attempt it made. The snapshot is the one owner of per-call
       * cost; this restates it on the event so a progress projection never
       * accumulates a second, divergent total.
       */
      costUsd?: number;
      /** Host-measured wall time of the agent() call (live calls only). */
      durationMs: number;
    })
  | (WorkflowScriptAgentEventBase & {
      type: 'agent:end';
      outcome: 'failed';
      error: string;
      /** Child model resolved by the runner, when resolution succeeded. */
      model?: string;
      /** Snapshot-recorded spend for this call, when an attempt reported any. */
      costUsd?: number;
      /** Host-measured wall time, when an agent attempt began. */
      durationMs?: number;
    })
  | (WorkflowScriptAgentEventBase & {
      type: 'agent:end';
      outcome: 'skipped';
      reason: 'user';
      /** Child model resolved before the user stopped the attempt, if known. */
      model?: string;
      /** Snapshot-recorded spend for the attempt the user stopped. */
      costUsd?: number;
      /** Host-measured wall time before the user stopped the attempt. */
      durationMs: number;
    });

/**
 * Guest-visible result of a call cancelled via `control(childExecutionId,
 * 'skip')`: a first-class sentinel distinct from a failed call's `null`, so a
 * script (or host) can tell "deliberately skipped" apart from "runner failed".
 * Skipped calls are never journaled, so a later resume re-runs them.
 */
export const WORKFLOW_SKIPPED_RESULT = '__WORKFLOW_SKIPPED__';

/**
 * What an interactive control request does to the attempt it targets: `skip`
 * resolves the call to {@link WORKFLOW_SKIPPED_RESULT} without journaling it,
 * `retry` discards the attempt and re-runs the call as a fresh one whose result
 * the call resolves with.
 */
export type WorkflowControlAction = 'skip' | 'retry';

/**
 * Per-call control handle for an in-flight run, handed to the host once via
 * {@link WorkflowScriptRunOptions.onControl}. It is keyed by the execution id
 * of the child the attempt actually runs under — the same identity the host
 * uses for focus and kill, reported by the runner through
 * {@link WorkflowAttemptFacts.childExecutionId} — and no-ops when that child is
 * not currently in flight. Control actions are control-plane only: they never
 * touch the journal, checkpoint, or per-call resume identity.
 */
export type WorkflowScriptControl = (
  childExecutionId: ExecutionId,
  action: WorkflowControlAction,
) => void;

export interface WorkflowScriptRunOptions {
  /** Full script source, starting with `export const meta = {...}`. */
  script: string;
  /** Exposed verbatim to the script as the global `args`. */
  args?: unknown;
  /** Exposed to the script as the immutable global `files` object. */
  files?: WorkflowScriptFiles;
  runAgent: WorkflowAgentRunner;
  /**
   * Host-owned fingerprint for external file dependencies referenced by one
   * agent() call. Required when the call carries file options: the engine
   * includes the opaque value in both journal and child execution identity.
   */
  fingerprintAgentDependencies?: (
    options: WorkflowAgentCallOptions,
  ) => Promise<string>;
  /** Parent cancellation signal; aborts guest execution and active agents. */
  signal?: AbortSignal;
  /** Max concurrently running agent() calls. Default 4. */
  concurrency?: number;
  /** Journal from a prior run; per-index key matches return cached results. */
  journal?: WorkflowJournalEntry[];
  /** Recovery snapshot from the prior attempt, re-published after reconciliation. */
  initialSnapshot?: WorkflowExecutionSnapshot;
  /**
   * Durable checkpoint hook for a successfully validated live call. The
   * engine awaits it before the result becomes visible to the script, so a
   * host restart cannot expose work whose journal entry was never persisted.
   */
  onJournalEntry?: (entry: WorkflowJournalEntry) => void | Promise<void>;
  /** Receives each canonical snapshot after the transition has been applied. */
  onSnapshot?: (snapshot: WorkflowExecutionSnapshot) => void | Promise<void>;
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
  /** The script body's return value. */
  result: unknown;
  /** Completed calls in index order, for resume. Failed calls are omitted. */
  journal: WorkflowJournalEntry[];
  /** Final canonical execution snapshot. */
  snapshot: WorkflowExecutionSnapshot;
}
