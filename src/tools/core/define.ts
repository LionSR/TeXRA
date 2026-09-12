import type { ToolServices } from '@agent/runtime/ToolServices';

import {
  defineTool as defineGenericTool,
  type DefineToolOptions,
  type DefinedToolClass,
} from './definition';

/** The shared builder, specialized to the services the runtime supplies. */
export const defineTool: <T, R = ToolServices>(
  definition: DefineToolOptions<T>,
) => DefinedToolClass<T, R> = defineGenericTool;
