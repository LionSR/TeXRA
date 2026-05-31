/**
 * Core tool type definitions: ITool, IToolRegistry, MapToolRegistry.
 * Re-exports ToolResult types from @tools/result and ToolDefinition from @model.
 */

import type { ToolDefinition as ToolDefinitionType } from '@model/ToolDefinition';
import type { ToolResult as ToolResultType } from '@tools/result';

export type {
  ToolResult,
  ErrorDiagnostics,
  DiagnosticsPayload,
  ToolFileAttachment,
} from '@tools/result';
export { ToolError } from '@tools/result';

export type { ToolDefinition } from '@model/ToolDefinition';

/**
 * Contract for tool implementations.
 * BaseTool provides the canonical implementation with Zod validation.
 */
export interface ITool {
  readonly definition: ToolDefinitionType;
  call(rawInput: unknown): Promise<ToolResultType>;
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
