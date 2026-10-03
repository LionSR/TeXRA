import type { ITool, IToolRegistry } from '@agent/core/tools/ToolTypes';
import type { ProcessServices } from '@platform/processRuntime';
import type { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import type { Scope } from 'effect';

import type { Runs } from './runRegistry';
import type { ToolCall } from './ToolCall';

/** Services supplied by the runtime to tool implementations: the process's,
 *  the `Runs` of the session the call works in, the rooted filesystems of
 *  that same session, and the call's. A plugin's tool may require its own
 *  plugin's services beside these (`definePlugin`). A tool takes
 *  `WorkspaceFs` from context instead of resolving a static against whichever
 *  roots its fiber happens to carry. */
export type ToolServices =
  ProcessServices | Runs | ToolCall | WorkspaceFs | StorageFs | Scope.Scope;
export type RuntimeTool<E = Error, R = ToolServices> = ITool<E, R>;
export type RuntimeToolRegistry = IToolRegistry<Error, ToolServices>;
