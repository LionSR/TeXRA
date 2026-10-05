/**
 * The tool contract: a tool (`ITool`), its registry, its guard, and what
 * its body reads of its own call (`ToolContext`: its id, where it works, how
 * it asks a person, where its transient output goes). What the harness's
 * built-in tools read of a call made under a run is `@agent/runtime/RunCall`.
 */

import { Context, type Effect } from 'effect';

import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type {
  PermissionPayload,
  RequestDecision,
  ToolDefinition,
  ToolResult,
} from '@shared/schemas';
import type {
  DatabaseNotOwner,
  DatabaseWriteFailed,
} from '@shared/session/database';
import type { RunHistoryRefused } from '@shared/session/runHistory';
import type { SettingHost } from '@shared/state/stateSettings';
import type { StepRoot } from '@utils/files/externalRoots';

/**
 * The guard the run loop applies before a tool's body runs, declared on the
 * tool instead of called inside it: the paths the call writes and the command
 * it must get approved. `agent/runtime/loop/toolGuard.ts` is the one place
 * either is asked for, so no tool body opens its own approval prompt or
 * re-checks its own roots.
 */
export interface ToolGuard<T, R = never> {
  /**
   * The paths this call writes, read from its arguments. Each is resolved
   * against the call's workspace and working directory — which refuses a path
   * outside either — and refused when it lands in a read-only external root.
   */
  readonly writes?: (input: T) => readonly string[];
  /**
   * The command this call runs, spelled as the approval prompt shows it. The
   * loop puts it through the session's bash approval before the body runs.
   * Only the `bash` tool's commands take the run's command grant; any other
   * tool's call is asked about per call.
   * An Effect because the spelling can depend on settings the prompt must
   * show (a Codex sandbox mode, a Claude permission mode).
   */
  readonly bash?: (input: T) => Effect.Effect<string, Error, R>;
  /**
   * Where the approved command actually runs, when that is not the call's own
   * directory. Omitted: the call's working directory, else the workspace,
   * which is what a shell-shaped tool uses. `'unknown'`: the executor cannot name one, so the
   * prompt names none rather than a directory the command may not run in
   * (`send_to_terminal` reuses a terminal whose shell has its own directory).
   */
  readonly cwd?: 'unknown';
}

/** A host capability a tool needs: `diagnostics` is a file's diagnostics
 *  from the host's editor. */
export type HostToolCapability = 'diagnostics';

/**
 * Contract for tool implementations.
 * `defineTool` provides the canonical implementation with Zod validation. Expected
 * tool failures are returned as literal `{ status: 'error', error: ... }`
 * ToolResult values; unexpected/programmer failures should throw and let
 * `defineTool` convert them at the boundary.
 */
export interface ITool<E = Error, R = never> {
  readonly definition: ToolDefinition;
  /** Hosts this tool is statically excluded from; an omitted host supports it. */
  readonly unavailableHosts?: readonly SettingHost[];
  /** What the session's host must serve for this tool to be offered, read
   *  live each step: a window that attaches mid-run brings it. */
  readonly hostCapability?: HostToolCapability;
  /**
   * True only for tools that are side-effect-free AND approval-free, so
   * parallel calls in one model response may execute concurrently.
   * Declared on the tool (not the YAML-overridable definition) so agent
   * configs cannot mark arbitrary tools parallel-safe.
   *
   * The two properties are coupled on purpose and both are load-bearing in
   * `partitionDuplicateCalls`: every non-parallel-safe call acts as an
   * ordering barrier that clears the read-dedup segment. A read-only tool
   * that requires user approval is therefore NOT parallel-safe — it cannot
   * run concurrently with siblings in the same batch (it needs an approval
   * round-trip first), so it must stay a barrier. Only set this when a call
   * both mutates nothing and never prompts for approval.
   */
  readonly parallelSafe?: boolean;
  /**
   * In a script, its calls neither wait for the calls issued before them
   * nor block the ones after, and take no place in the parallel window: the
   * tool bounds how many of its own calls run at once. For a call that
   * waits on long-running work it does not perform itself (a child run). A
   * later barrier still waits for it.
   */
  readonly ownsConcurrency?: boolean;
  /**
   * The tool is also a global function of a script, taking its `positional`
   * field as the first argument and the rest as the second:
   * `agent(prompt, opts)` for `tools.agent({ prompt, ...opts })`.
   */
  readonly scriptGlobal?: { readonly positional: string };
  /**
   * Whether a call recorded as started, with no result, may run again on
   * resume without asking: `'safe'` only for a read-only or idempotent tool,
   * whose second run changes nothing the first did not. Omitted is
   * `'unsafe'`. Independent of `parallelSafe`, which is about concurrency.
   * The response row saves the declaration with each call, and a resume
   * re-runs a call only when that saved word and the current one both say
   * `'safe'` (`toolUseDispatch.ts`).
   */
  readonly replay?: 'safe' | 'unsafe';
  /**
   * Whether a call needs a person's approval, and who asks for it. `true`:
   * the run loop asks before the body runs, spelling the call as `guard.bash`
   * does when the guard names one and as the tool's name and arguments
   * otherwise, so a tool cannot declare approval and run unasked.
   * `'inBody'`: the body opens its own request (a file-edit review, a plan, a
   * question, a delegation proposal, an external inquiry) and the loop does
   * not ask again. Either
   * way, a run that cannot present a prompt is not offered the tool.
   */
  readonly requiresApproval?: boolean | 'inBody';
  /** Its card opens before the call runs; a fast tool's opens and closes
   *  with its settlement. */
  readonly slow?: boolean;
  /** The loop-side guard this tool declares; see {@link ToolGuard}. */
  readonly guard?: ToolGuard<never, R>;
  /**
   * A description rendered from the other tools the run declares, in place
   * of `definition.description`: rendered at the step that freezes the
   * run's system text and kept as that step recorded it until a compaction
   * opens the freeze again (`step.ts`), so a catalog change mid-run leaves
   * its text, and the cached prefix through it, as it was.
   */
  readonly describe?: (
    declared: readonly Pick<ITool, 'definition' | 'scriptGlobal'>[],
  ) => string;
  call(rawInput: unknown): Effect.Effect<ToolResult, E, R>;
}

/** Tool lookup abstraction — supports dependency injection and mock tools. */
export interface IToolRegistry<E = Error, R = never> {
  get(name: string): ITool<E, R> | undefined;
  has(name: string): boolean;
}

/** Map- or Record-backed IToolRegistry. */
export class MapToolRegistry<E = Error, R = never> implements IToolRegistry<
  E,
  R
> {
  private readonly tools: Map<string, ITool<E, R>>;

  constructor(tools: Map<string, ITool<E, R>> | Record<string, ITool<E, R>>) {
    this.tools = tools instanceof Map ? tools : new Map(Object.entries(tools));
  }

  get(name: string): ITool<E, R> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
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
    DatabaseNotOwner | DatabaseWriteFailed | RunHistoryRefused
  >;
}

/**
 * Where a call works: the session's roots (its workspace folder, the
 * setting slots and its storage), the run's working directory, and the
 * read-only roots the call's step admits (the skills it lists or its user
 * activated). A tool path resolves against it (`@common/files/pathResolution`).
 * `workingDirectory` is already absolute or absent: the run decides it once
 * where it is launched (`assembleAgentLaunchContext`).
 */
export interface ToolEnv {
  readonly roots: WorkspaceRoots;
  readonly workingDirectory?: string;
  readonly stepRoots?: readonly StepRoot[];
}

/** What every tool call knows of itself. */
export interface ToolContextShape {
  /** The call's id, as the model (or the host) issued it. */
  readonly callId: string;
  /** Where the call works. */
  readonly env: ToolEnv;
  /** Where the call's requests to a person open; absent for a standalone
   *  host invocation outside an agent run, which has nobody to ask. */
  readonly requests?: CallRequests;
  /** Transient output for the call's card while it runs, never a row. */
  readonly emit: (text: string) => void;
}

/** The tool call the running tool serves. */
export class ToolContext extends Context.Service<
  ToolContext,
  ToolContextShape
>()('@texra/agent/ToolContext') {}
