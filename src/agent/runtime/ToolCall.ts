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
  /** Settles one issued call, at its `tool.result` commit. */
  readonly call: (
    op: ScriptOp,
  ) => Effect.Effect<ToolResultPayload['result'], ScriptDiverged | InvokeError>;
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

export interface ToolCallShape {
  /** The roots of the workspace the call works on: the run's session roots. */
  readonly roots: WorkspaceRoots;
  readonly toolCallId?: string;
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
  /** The calls a script may issue; absent outside a run's dispatch and for
   *  a call a script issued. */
  readonly scriptCalls?: ScriptCalls;
  /** Where the call's requests open: present exactly when {@link run} is. */
  readonly requests?: CallRequests;
  /**
   * Absent for a standalone host invocation outside an agent run. What the run
   * already answers for (its model, its delegation scope, its current step,
   * its approval-denial observer, its trace, its tool policy, its scope) is read from here rather
   * than copied onto the call. A tool that starts something the run should
   * stop at its end registers that stop on the run's scope.
   */
  readonly run:
    | Pick<
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
      >
    | undefined;
}

export class ToolCall extends Context.Service<ToolCall, ToolCallShape>()(
  '@texra/agent/ToolCall',
) {}
