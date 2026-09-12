import type { ITool, IToolRegistry } from '@agent/core/tools/ToolTypes';
import type { ProcessServices } from '@platform/processRuntime';
import type { Scope } from 'effect';

import type { ToolCall } from './ToolCall';

/** Services supplied by the runtime to built-in tool implementations. */
export type ToolServices = ProcessServices | ToolCall | Scope.Scope;
export type RuntimeTool<E = unknown, R = ToolServices> = ITool<E, R>;
export type RuntimeToolRegistry = IToolRegistry<unknown, ToolServices>;
