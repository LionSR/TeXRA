/**
 * Core tool type definitions: ITool, IToolRegistry, MapToolRegistry.
 */

import type { ToolDefinition, ToolResult } from '@shared/schemas';
import type { Effect } from 'effect';

/** Product hosts that expose the shared agent-tool registry. */
export type ToolHost = 'cli' | 'desktop' | 'extension';

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
   * An Effect because the spelling can depend on settings the prompt must
   * show (a Codex sandbox mode, a Claude permission mode).
   */
  readonly bash?: (input: T) => Effect.Effect<string, Error, R>;
  /**
   * Where the approved command actually runs, when that is not the call's own
   * directory. Omitted: the call's working directory, else the workspace,
   * which is what a shell-shaped tool uses. `'workspace'`: the session
   * workspace whatever working directory the call was given (`wolfram` runs
   * its script there). `'unknown'`: the executor cannot name one, so the
   * prompt names none rather than a directory the command may not run in
   * (`send_to_terminal` reuses a terminal whose shell has its own directory).
   */
  readonly cwd?: 'workspace' | 'unknown';
}

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
  readonly unavailableHosts?: readonly ToolHost[];
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
  /** Execution behavior consumed by tool resolution and dispatch. */
  readonly requiresApproval?: boolean;
  /** Its card opens before the call runs; a fast tool's opens and closes
   *  with its settlement. */
  readonly slow?: boolean;
  /** The loop-side guard this tool declares; see {@link ToolGuard}. */
  readonly guard?: ToolGuard<never, R>;
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
