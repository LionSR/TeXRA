import type { ToolServices } from '@agent/runtime/ToolServices';

import {
  defineTool as defineGenericTool,
  type ConcreteToolClass,
  type DefineToolOptions,
  type DefinedToolClass,
  type ToolExecute,
} from './definition';

/**
 * The shared builder, specialized to the services the runtime supplies.
 *
 * Written as an overloaded call signature rather than a single arrow type so
 * the concrete/abstract split survives the specialization: a definition
 * carrying `execute` yields a `new`-able class, one without stays abstract.
 */
interface DefineTool {
  <T, R = ToolServices>(
    definition: DefineToolOptions<T, R> & { execute: ToolExecute<T, R> },
  ): ConcreteToolClass<T, R>;
  <T, R = ToolServices>(
    definition: DefineToolOptions<T, R>,
  ): DefinedToolClass<T, R>;
}

export const defineTool: DefineTool = defineGenericTool;
