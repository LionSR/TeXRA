import type { ToolServices } from '@agent/runtime/ToolServices';

import {
  defineTool as defineGenericTool,
  type DefinedTool,
  type DefineToolOptions,
} from './definition';

/** The shared builder, specialized to the services the runtime supplies. */
export const defineTool: <T, R = ToolServices>(
  definition: DefineToolOptions<T, R>,
) => DefinedTool<T, R> = defineGenericTool;
