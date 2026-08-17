/**
 * Core tool type definitions: ITool, IToolRegistry, MapToolRegistry.
 */

import type { ToolDefinition, ToolResult } from '@shared/schemas';

/**
 * Contract for tool implementations.
 * BaseTool provides the canonical implementation with Zod validation. Expected
 * tool failures are returned as literal `{ status: 'error', error: ... }`
 * ToolResult values; unexpected/programmer failures should throw and let
 * BaseTool convert them at the boundary.
 */
export interface ITool {
  readonly definition: ToolDefinition;
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
  readonly slow?: boolean;
  readonly deferLogUntilApproval?: boolean;
  readonly streamsOutput?: boolean;
  call(rawInput: unknown): Promise<ToolResult>;
}

/** Tool lookup abstraction — supports dependency injection and mock tools. */
export interface IToolRegistry {
  get(name: string): ITool | undefined;
  has(name: string): boolean;
}

/** Map- or Record-backed IToolRegistry. */
export class MapToolRegistry implements IToolRegistry {
  private readonly tools: Map<string, ITool>;

  constructor(tools: Map<string, ITool> | Record<string, ITool>) {
    this.tools = tools instanceof Map ? tools : new Map(Object.entries(tools));
  }

  get(name: string): ITool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}
