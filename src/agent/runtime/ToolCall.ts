/** Capabilities scoped to one tool invocation, supplied by its host boundary. */
import { Context, Data, type Effect } from 'effect';

import type {
  FileInteractionState,
  WorkPlanState,
} from '@agent/core/state/AgentWorkspaceState';
import type { ScriptOp } from '@agent/codeSandbox/codeSandbox';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type {
  PermissionPayload,
  RequestDecision,
  ToolDefinition,
  ToolResultPayload,
} from '@shared/schemas';
import type {
  DatabaseNotOwner,
  DatabaseWriteFailed,
} from '@shared/session/database';
import type { RunLedgerRefused } from '@shared/session/runLedger';
import type { StepRoot } from '@utils/files/externalRoots';
import type { InvokeError } from './ModelInvoker';
import type { AgentRunShape } from './run/AgentRun';

/** A resumed script issued another call at `seq` than its rows recorded. */
export class ScriptDiverged extends Data.TaggedError('ScriptDiverged')<{
  readonly seq: number;
  readonly recorded: string;
  readonly issued: string;
}> {
  override get message(): string {
    return `The resumed script diverged at call ${this.seq}: it recorded ${this.recorded} and now issued ${this.issued}.`;
  }
}

/** The program a `script` call runs, as its call's arguments carry it. */
export interface ScriptSource {
  readonly source: string;
  readonly title: string | null;
}

/**
 * How a `script` call's guest reaches the run's tools: through the run
 * loop's per-call program, which commits each call's rows (`script.call`,
 * `tool.intent`, its card, `tool.result`) and on a resume hands back what
 * the rows already settled instead of running it again.
 */
export interface ScriptCalls {
  /** The tools the guest may call, as the step that offered the script
   *  pinned them: its offered tools, less `script`, each with its plugin. */
  readonly catalog: readonly {
    readonly definition: ToolDefinition;
    readonly plugin: string;
  }[];
  /** The tools of the catalog that are also script globals, taking their
   *  `positional` field first (`ITool.scriptGlobal`). */
  readonly globals: readonly {
    readonly tool: string;
    readonly positional: string;
  }[];
  /** Settles one issued call, at its `tool.result` commit: its result and
   *  the attachment bytes that commit captured. */
  readonly call: (
    op: ScriptOp,
    script: ScriptSource,
  ) => Effect.Effect<
    Pick<ToolResultPayload, 'result' | 'attachments'>,
    ScriptDiverged | InvokeError
  >;
  /**
   * Settles one call of the script's own host functions (`searchTools`,
   * `describeTool`) with `answer`, which reads nothing but {@link catalog}.
   * It is recorded as a call with no card or tool, so a resume hands the
   * recorded answer back as it hands back a tool's.
   */
  readonly answer: (
    op: ScriptOp,
    answer: () => ToolResultPayload['result'],
  ) => Effect.Effect<ToolResultPayload['result'], ScriptDiverged | InvokeError>;
  /** The sandbox delivered `seq`'s settlement to the guest. */
  readonly delivered: (seq: number) => Effect.Effect<void>;
}

/**
 * What a call a script issued knows of that script: what a person is shown
 * of it, and what the script's calls share for as long as it runs here.
 */
export interface ScriptScope extends ScriptSource {
  /** The `script` call that issued this one. */
  readonly callId: string;
  /** The calls the script has issued so far, this one included, in issue
   *  order, as their `script.call` rows record them. */
  readonly calls: Effect.Effect<
    readonly { readonly toolName: string; readonly input: unknown }[]
  >;
  /**
   * The value the script's calls share under `key`: the first call to ask
   * makes it, and every later one, concurrent or not, gets what that made
   * (its failure included). Held in memory for the script's run in this
   * process; what must outlive a restart is made from rows.
   */
  readonly shared: <A, E, R>(
    key: string,
    make: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

/**
 * The requests one tool call raises, opened through its run's loop. The first
 * request an attempt raises commits with the `tool.binding` that ties it to
 * the call, so a person's pending approval outlives the process that asked:
 * a resume re-enters the call, and the call re-enters that same request.
 */
export interface CallRequests {
  /** The id the call's next request opens under: the request a resumed call
   *  left standing, when its id has this prefix, else a fresh
   *  `<prefix>-<id>`. A request is staged under this id before it opens. */
  readonly nextId: (prefix: string) => string;
  /** Open the request (or re-enter the standing one) and wait for its
   *  decision, as `SessionHandle.openRequest` does. */
  readonly open: (
    payload: PermissionPayload,
    options?: { readonly onNeverCommitted?: Effect.Effect<void> },
  ) => Effect.Effect<
    RequestDecision,
    DatabaseNotOwner | DatabaseWriteFailed | RunLedgerRefused
  >;
}

/** A call made under a run has its requests; a standalone host invocation
 *  outside an agent run has neither. */
export type ToolCallShape = {
  /** The roots of the workspace the call works on: the run's session roots. */
  readonly roots: WorkspaceRoots;
  readonly toolCallId?: string;
  /** The response whose call this is; a script's calls are its script's.
   *  A provider's call ids are unique within one response only. */
  readonly responseId?: string;
  /** The intent attempt this execution of the call runs under: 1, then one
   *  more for each re-run a resume admitted. Absent outside a run. */
  readonly attempt?: number;
  readonly workingDirectory?: string;
  /** The read-only roots the step that offered the call admits: the skill
   *  directories it lists or its user activated. None outside a run. */
  readonly stepRoots?: readonly StepRoot[];
  /** The run's file-interaction record; absent outside an agent run. */
  readonly tracker?: FileInteractionState;
  readonly userInstruction?: string;
  readonly workPlanState?: WorkPlanState;
  readonly hooks?: {
    /** What the tool prints while it runs, for its card's transient output. */
    readonly onToolOutput?: (chunk: string) => void;
  };
  /** The calls a script may issue, built on the first `yield*`; absent
   *  outside a run's dispatch and for a call a script issued. */
  readonly scriptCalls?: Effect.Effect<ScriptCalls>;
  /** The script that issued this call; absent for a call a response issued. */
  readonly script?: ScriptScope;
} & (
  | {
      /**
       * What the run already answers for (its model, its delegation scope,
       * its current step, its approval-denial observer, its trace, its tool
       * policy, its scope) is read from here rather than copied onto the
       * call. A tool that starts something the run should stop at its end
       * registers that stop on the run's scope.
       */
      readonly run: Pick<
        AgentRunShape,
        | 'session'
        | 'runId'
        | 'toolPolicy'
        | 'config'
        | 'model'
        | 'logger'
        | 'delegationAgentScope'
        | 'steps'
        | 'scope'
      >;
      /** Where the call's requests open. */
      readonly requests: CallRequests;
    }
  | { readonly run: undefined; readonly requests?: undefined }
);

export class ToolCall extends Context.Service<ToolCall, ToolCallShape>()(
  '@texra/agent/ToolCall',
) {}
