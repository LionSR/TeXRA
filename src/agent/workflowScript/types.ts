import { z } from 'zod';

import {
  WorkflowCallIdentitySchema,
  type RunId,
  type WorkflowCallIdentity,
  type WorkflowControlAction,
  type WorkflowRunSnapshot,
  type WorkflowScriptFiles,
} from '@shared/schemas';
import { normalizeStructuredOutputSchema } from '@tools/structuredOutput';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { Effect, Scope } from 'effect';

/** One title form for `meta.phases` entries and runtime `phase()` calls. */
export const WorkflowScriptPhaseTitleSchema = z
  .string()
  .trim()
  .min(1, 'Workflow phase title must not be blank.');

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
  /** 0-based call sequence number: ordering only, never identity. */
  index: number;
  /** Stable logical call identity within the workflow run snapshot. */
  progressId: WorkflowScriptProgressId;
  /** Stable hash of the prompt and normalized run-affecting options. */
  key: string;
  prompt: string;
  options: WorkflowAgentCallOptions;
  /**
   * Fires when the run is aborted (wall-clock timeout). Runners should
   * cancel the underlying agent run so timed-out workflows stop
   * consuming model quota instead of finishing in the background.
   */
  signal: AbortSignal;
  /**
   * Host-side side channel: the runner reports whatever it has
   * resolved for the live attempt, in whatever combination it learns them.
   * Never journaled — none of it affects resume identity.
   */
  report: (facts: WorkflowAttemptFacts) => void;
}

/**
 * Progress-only facts a host runner resolves for one live attempt. Every field
 * is independent: a runner reports the ones it has learned, and an omitted
 * field leaves the engine's current value in place.
 */
export interface WorkflowAttemptFacts {
  /**
   * The child model the runner resolved, stamped onto the call and its
   * latest attempt in the run snapshot for progress UIs.
   */
  readonly model?: string;
  /** The resolved agent the host selected. */
  readonly agent?: string;
  /** The physical child run selected for this attempt: the task card's
   *  navigation target once the host has resolved it. */
  readonly childRunId?: RunId;
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
 * production host wires this to the in-band subagent run path so the
 * engine receives the typed `RunEnd`, never the XML follow-up delivery
 * string. The journal records that result; the script sees
 * {@link WorkflowScriptRunOptions.toScriptValue} of it.
 *
 * The engine, not the runner, owns the call's `Scope`: whatever a runner holds
 * to keep the child it inspected from being resumed under it is released only
 * after this call's journal entry has committed, since until then the result
 * the parent is persisting is one another host could still invalidate.
 */
type WorkflowAgentRunner<R = never> = (
  invocation: WorkflowAgentInvocation,
) => Effect.Effect<unknown, Error, R | Scope.Scope>;

/**
 * One completed agent() call, cached for resume. Identity is `key` alone;
 * `index` records the last invocation position that matched the entry. It is
 * rewritten when a resumed run replays the entry at a new position and need
 * not be unique in a stale recovery journal.
 */
export interface WorkflowJournalEntry {
  index: number;
  /** Stable call hash including host-resolved dependency fingerprints. */
  key: string;
  result: unknown;
}

/** Identity used only to correlate one changing progress record in a run. */
type WorkflowScriptProgressId = WorkflowCallIdentity['id'];

/**
 * The facts the canonical run snapshot cannot carry. Everything else a
 * progress projection needs — plan, phases, per-call status, stream identity,
 * model, cost, timing, errors — lives on {@link WorkflowRunSnapshot}
 * and arrives through {@link WorkflowScriptRunOptions.onTransition}; the
 * event stream no longer restates it (that dual-stamping is exactly the sync
 * tax A7 retired). `log` remains an event because a script's `log()` line is
 * transient activity, not run state.
 */
export type WorkflowScriptEvent = { type: 'log'; message: string };

/**
 * Guest-visible result of a call cancelled via `control(childRunId,
 * 'skip')`: a first-class sentinel distinct from a failed call's `null`, so a
 * script (or host) can tell "deliberately skipped" apart from "runner failed".
 * Skipped calls are never journaled, so a later resume re-runs them.
 */
export const WORKFLOW_SKIPPED_RESULT = '__WORKFLOW_SKIPPED__';

/**
 * Per-call control handle for an in-flight run, handed to the host once via
 * {@link WorkflowScriptRunOptions.onControl}. It is keyed by the run id
 * of the child the attempt actually runs under — the same identity the host
 * uses for focus and kill, reported by the runner through
 * {@link WorkflowAttemptFacts.childRunId} — and answers whether that
 * child was in flight: true when the action took, false when the id belongs
 * to no live attempt of this run, so a host can tell a settled call from an
 * acted one. Control actions are control-plane only: they never touch the
 * journal, checkpoint, or per-call resume identity.
 */
export type WorkflowScriptControl = (
  childRunId: RunId,
  action: WorkflowControlAction,
) => boolean;

export interface WorkflowScriptRunOptions<R = never> {
  /** Full script source, starting with `export const meta = {...}`. */
  script: string;
  /** Exposed verbatim to the script as the global `args`. */
  args?: unknown;
  /** Exposed to the script as the immutable global `files` object. */
  files?: WorkflowScriptFiles;
  runAgent: WorkflowAgentRunner<R>;
  /**
   * Host projection from a runner result (live, or replayed from the journal)
   * to the value `agent()` resolves to in the script. The journal keeps the
   * runner's own result, so resume and cost accounting read one shape while
   * the script sees the host's documented envelope. Omitted: the script sees
   * the runner result unchanged.
   */
  toScriptValue?: (result: unknown) => unknown;
  /**
   * Host-owned fingerprint for external file dependencies referenced by one
   * agent() call. Required when the call carries file options: the engine
   * includes the opaque value in both journal and child run identity.
   */
  fingerprintAgentDependencies?: (
    options: WorkflowAgentCallOptions,
  ) => Effect.Effect<string, Error, R>;
  /** Parent cancellation signal; aborts guest run and active agents. */
  signal?: AbortSignal;
  /** Max concurrently running agent() calls. The host passes the session's
   *  child-run budget; 4 is the library fallback. */
  concurrency?: number;
  /** Journal from a prior run; matching keys replay regardless of call position. */
  journal?: WorkflowJournalEntry[];
  /** Recovery snapshot from the prior attempt, re-published after reconciliation. */
  initialSnapshot?: WorkflowRunSnapshot;
  /**
   * Durable checkpoint hook for a successfully validated live call. The
   * engine awaits it before the result becomes visible to the script, so a
   * host restart cannot expose work whose journal entry was never persisted.
   */
  onJournalEntry?: (
    entry: WorkflowJournalEntry,
  ) => Effect.Effect<void, Error, R>;
  /**
   * Durable checkpoint hook for an interactive retry: the child the user
   * superseded, awaited before the engine asks the runner for its
   * replacement. A retried child can already have started work, which every
   * recovery rule otherwise refuses to repeat, so the authorization has to
   * outlive this process for the runner's probe to advance past it.
   */
  onSupersededAttempt?: (superseded: {
    readonly key: string;
    readonly childRunId: RunId;
  }) => Effect.Effect<void, Error, R>;
  /**
   * Synchronous observer for every validated result this invocation consumes,
   * whether replayed or live. It fires after the call reaches its terminal
   * cached/completed status and before the result becomes visible to the
   * script; an onTransition throw during that status prevents both this
   * callback and consumption. A live entry is already durably committed by
   * onJournalEntry when this observer fires.
   */
  onJournalEntryConsumed?: (entry: WorkflowJournalEntry) => void;
  /**
   * Durable-persistence hook: receives an isolated copy of the canonical
   * snapshot after a transition, with writes coalesced under backpressure —
   * intermediate states may be skipped, the latest always lands.
   */
  onSnapshot?: (snapshot: WorkflowRunSnapshot) => Effect.Effect<void, Error, R>;
  /**
   * Synchronous per-transition observer for live projections: fires on every
   * state transition, never coalesced, with the LIVE snapshot reference —
   * read it synchronously and never retain it (clone if you must). A throw
   * propagates into the engine and aborts the run, so consumers guard their
   * own folds.
   */
  onTransition?: (snapshot: WorkflowRunSnapshot) => void;
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
  /** Final canonical run snapshot. */
  snapshot: WorkflowRunSnapshot;
}
