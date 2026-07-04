/**
 * Core tool type definitions: ITool, IToolRegistry, MapToolRegistry.
 */

import type { ToolDefinition } from '@model/ToolDefinition';
import type { ToolResult } from '@shared/schemas/toolResult';

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
   * True only for tools that are side-effect-free and approval-free, so
   * parallel calls in one model response may execute concurrently.
   * Declared on the tool (not the YAML-overridable definition) so agent
   * configs cannot mark arbitrary tools parallel-safe.
   */
  readonly parallelSafe?: boolean;
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
