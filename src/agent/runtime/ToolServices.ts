import type { ITool, IToolRegistry } from '@agent/core/tools/ToolTypes';
import type { ProcessServices } from '@platform/processRuntime';
import type { Scope } from 'effect';

import type { Runs } from './runRegistry';
import type { ToolCall } from './ToolCall';

/** Services supplied by the runtime to built-in tool implementations: the
 *  process's, the `Runs` of the session the call works in, and the call's. */
export type ToolServices = ProcessServices | Runs | ToolCall | Scope.Scope;
export type RuntimeTool<E = unknown, R = ToolServices> = ITool<E, R>;
export type RuntimeToolRegistry = IToolRegistry<unknown, ToolServices>;
