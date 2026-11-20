/**
 * The tool contract: a tool (`ITool`), its registry, its guard, and what
 * its body reads of its own call (`ToolContext`: its id, where it works, how
 * it asks a person, the run it works for, where its transient output goes).
 * A tool is only ever called under a run: its call always carries the run
 * (`ToolRun`) and where its requests open (`CallRequests`).
 */

import { Context, type Effect, type Scope, type ScopedRef } from 'effect';

import type { BoundModel } from '@agent/runtime/modelAccess/ModelAccess';
import type { ToolPolicy } from '@agent/runtime/run/AgentRun';
import type {
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from '@agent/runtime/runtimePresentationEvents';
import type { AgentTrace } from '@agent/trace/AgentTrace';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type {
  AgentConfig,
  DispatchFacts,
  RequestPayload,
  DecisionOf,
  RunId,
  ToolDefinition,
  ToolResult,
} from '@shared/schemas';
import type { DatabaseAggregateClosed } from '@shared/session/database';
import type { DraftBlob } from '@shared/session/historyTurns';
import type { CellError } from '@shared/session/runHistory';
import type { StepRoot } from '@utils/files/externalRoots';

/**
 * The guard the run loop applies before a tool's body runs, declared on the
 * tool instead of called inside it: the paths the call writes and the command
 * it must get approved. The run loop is the one place either is checked,
 * so no tool body re-checks its own roots or asks for the
 * command's approval; a tool whose body asks its own question declares
 * `requiresApproval: 'inBody'` (below).
 */
export interface ToolGuard<T> {
  /**
   * The paths this call writes, read from its arguments. Each is resolved
   * against the call's workspace and working directory — which refuses a path
   * outside either — and refused when it lands in a read-only external root.
   */
  readonly writes?: (input: T) => readonly string[];
  /**
   * The command this call runs. Present: the loop puts it through the
   * session's command approval before the body runs.
   */
  readonly command?: {
    /** The command as the approval prompt shows it. */
    readonly text: (input: T) => string;
    /**
     * The standing grant that answers this tool's commands. `'bash'`: the
     * run's command grant ("approve all commands in this task"), which the
     * shell declares. Omitted: each call is asked about and only the
     * delegated-work grant covers it, so a tool whose prompt looks like a
     * command (an MCP tool, codex) never inherits shell permission.
     */
    readonly grant?: 'bash';
    /**
     * Where the approved command actually runs, when that is not the call's
     * own directory. Omitted: the call's working directory, else the
     * workspace, which is what a shell-shaped tool uses. `'unknown'`: the
     * executor cannot name one, so the prompt names none rather than a
     * directory the command may not run in (`send_to_terminal` reuses a
     * terminal whose shell has its own directory).
     */
    readonly cwd?: 'unknown';
  };
}

/**
 * Contract for tool implementations.
 * `defineTool` provides the canonical implementation with schema validation.
 * A tool fails with an `Error` (usually a `ToolError`) and the model reads its
 * message as the call's error; a throw is a defect, which `defineTool` turns
 * into a failed call and logs as a crash unless it is a `ToolError`.
 */
export interface ITool<E = Error, R = never> {
  readonly definition: ToolDefinition;
  /** The host capability (named by the plugin that serves it,
   *  `HostCapabilities`) the session's host must serve for this tool to be
   *  offered, read live each step: a window that attaches mid-run brings it. */
  readonly hostCapability?: string;
  /**
   * Where its calls run beside their siblings (omitted: `'barrier'`).
   * Declared on the tool, not the YAML-overridable definition, so an agent
   * config cannot move an arbitrary tool out of order.
   *
   * - `'parallel'`: side-effect-free AND approval-free, so calls of one
   *   response (or one script) run concurrently within the parallel window,
   *   and identical ones collapse onto one (`partitionDuplicateCalls`). A
   *   read-only tool that prompts for approval is not parallel: it needs an
   *   approval round-trip first, so it stays a barrier.
   * - `'barrier'`: waits for every call issued before it and holds back
   *   every call after it until it finishes.
   * - `'own'`: in a script, its calls neither wait for the calls issued
   *   before them nor block the ones after, and take no place in the
   *   parallel window: the tool bounds how many of its own calls run at
   *   once (a call that waits on a child run). A later barrier still waits
   *   for it; a response's call of it is a barrier.
   */
  readonly lane?: DispatchFacts['lane'];
  /**
   * The tool is also a global function of a script, taking its `positional`
   * field as the first argument and the rest as the second:
   * `agent(prompt, opts)` for `tools.agent({ prompt, ...opts })`.
   * `withScript`: a function of scripts alone (`self()`), offered whenever
   * the script tool is and never sent to the model as a tool of its own.
   */
  readonly scriptGlobal?: {
    readonly positional: string;
    readonly withScript?: true;
  };
  /**
   * Whether a call recorded as started, with no result, may run again on
   * resume without asking: `'safe'` only for a read-only or idempotent tool,
   * whose second run changes nothing the first did not. Omitted is
   * `'unsafe'`. Independent of `lane`, which is about concurrency.
   * The response row saves the declaration with each call, and a resume
   * re-runs a call only when that saved word and the current one both say
   * `'safe'`.
   */
  readonly replay?: DispatchFacts['replay'];
  /**
   * Whether a call needs a person's approval, and who asks. `true` (implied
   * by `guard.command`): the run loop, before the body runs. `'inBody'`: the
   * body's own request (an edit's review, a plan, a delegation proposal, a
   * question), which answers what the call's hooks
   * said. A run that cannot present a prompt is not offered such a tool
   * (`asksApproval`).
   */
  readonly requiresApproval?: true | 'inBody';
  /** The loop-side guard this tool declares; see {@link ToolGuard}. */
  readonly guard?: ToolGuard<never>;
  /**
   * A description rendered from the other tools the run declares, the
   * modules its scripts may import and the programs they may start, in
   * place of `definition.description`:
   * rendered at the step that freezes the run's system text and kept as
   * that step recorded it until a compaction opens the freeze again, so a
   * catalog change mid-run leaves its text, and the cached
   * prefix through it, as it was. The tool that has one is the script tool,
   * which reaches nothing but the run's other tools and its own agent: a
   * child is offered it, and its script-only functions, whatever its parent
   * was.
   */
  readonly describe?: (
    declared: readonly Pick<ITool, 'definition' | 'scriptGlobal' | 'lane'>[],
    /** The specifiers of the modules the step's scripts may import. */
    modules: readonly string[],
    /** The programs of the step's plugins, each with its one-line
     *  description. */
    programs: readonly {
      readonly name: string;
      readonly description: string;
    }[],
    /** The names of every tool the step offers, injected ones included:
     *  the description names a tool only when it is among them. */
    offered: readonly string[],
  ) => string;
  call(rawInput: unknown): Effect.Effect<ToolResult, E, R>;
}

/**
 * The requests one tool call raises, opened through its run's loop. Each
 * carries an id its attempt derives. A request still open when its run
 * stops is cancelled, and the resumed call asks again under a new id. One a
 * person answers while no process holds the run resumes the run, and the
 * call takes that answer when it asks the same thing again.
 */
export interface CallRequests {
  /** The id the call's next request opens under: the attempt's next
   *  derived id. A request is staged under this id before it opens. */
  readonly nextId: () => string;
  /** Open the request and wait for its decision. The returned payload is
   *  the request as it opened.
   *  `blobs` are the strings the payload names by address, stored with its
   *  row. `operation` is what a command (`bash`) asks permission for: the
   *  shell's (`'bash'`, which the run's command grant answers) or another
   *  tool's call (`'call'`, which only the delegated-work grant answers).
   *  An edit, a plan, a proposal or a plugin's trust asks about its own
   *  kind (`operationOf`); with the call's hooks, the operation decides who
   *  answers the request, and a request about none is a person's. */
  readonly open: <P extends RequestPayload>(
    payload: P,
    opening?: {
      readonly blobs?: readonly DraftBlob[];
      readonly operation?: 'bash' | 'call';
    },
  ) => Effect.Effect<
    {
      readonly payload: Extract<RequestPayload, { kind: P['kind'] }>;
      readonly decision: DecisionOf<P['kind']>;
    },
    DatabaseAggregateClosed | CellError
  >;
  /** Show the person something on the session's host (a file opened
   *  beside what they are looking at, a notice), answered by nothing. */
  readonly present: <K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
  ) => Effect.Effect<void>;
}

/**
 * Where a call works: the session's roots (its workspace folder, the
 * setting slots and its storage), the run's working directory, and the
 * read-only roots the call's step accepts (the skills it lists or its user
 * activated). A tool's paths resolve against it.
 * `workingDirectory` is already absolute or absent: the run decides it once
 * where it is launched (`buildAgentLaunchContext`).
 */
export interface ToolEnv {
  readonly roots: WorkspaceRoots;
  readonly workingDirectory?: string;
  readonly stepRoots?: readonly StepRoot[];
  /** The run the call works for. */
  readonly run: ToolRun;
}

/**
 * What a tool reads of the run its call works for, read from the run rather
 * than copied onto the call: exactly the fields the app's tools read. Its
 * id, policy, configuration (which holds its delegation scope), model,
 * scope (a tool that starts something the run should stop registers that
 * stop there) and trace (what a plugin's own stages nest under). Never its
 * session: a plugin reaches the session's runs through `ChildRuns`, and
 * shows the person something through its call's `requests.present`.
 * What only the harness's built-in tools read stays internal.
 */
export interface ToolRun {
  readonly runId: RunId;
  readonly toolPolicy: ToolPolicy;
  /** The parent this activation runs under (null for a root), and
   *  whether the parent's call awaits it: with the policy, what
   *  `noLaterTurn` reads. */
  readonly entry: {
    readonly parent: RunId | null;
    readonly awaited: boolean;
  };
  readonly config: AgentConfig;
  readonly model: ScopedRef.ScopedRef<BoundModel>;
  readonly scope: Scope.Scope;
  readonly logger: AgentTrace;
}

/** What every tool call knows of itself. */
export interface ToolContextShape {
  /** The call's id, as the model (or the host) issued it. */
  readonly callId: string;
  /** Where the call works. */
  readonly env: ToolEnv;
  /** Where the call's requests to a person open. */
  readonly requests: CallRequests;
  /** Transient output for the call's card while it runs, never a row. */
  readonly emit: (text: string) => void;
}

/** The tool call the running tool serves. */
export class ToolContext extends Context.Service<
  ToolContext,
  ToolContextShape
>()('@texra-ai/harness/agent/ToolContext') {}
