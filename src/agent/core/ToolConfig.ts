// Third-party imports
import { z } from 'zod';

export const DEFAULT_TOOL_CONFIG = {
  autoExtractFigure: false,
  autoExtractTikzFigure: false,
  attachTeXCount: false,
  attachDiagnostics: false,
  autoCompileInputPdf: false,
} as const;

/**
 * Zod schema for validating ToolConfig objects.
 * Schema-level prefault provides all defaults from DEFAULT_TOOL_CONFIG.
 * Field-level prefaults match the schema default to handle partial inputs.
 *
 * We explicitly strip unknown properties to remain backward compatible
 * with legacy settings that may still include removed flags.
 */
export const ToolConfigSchema = z
  .object({
    autoExtractFigure: z
      .boolean()
      .prefault(DEFAULT_TOOL_CONFIG.autoExtractFigure),
    autoExtractTikzFigure: z
      .boolean()
      .prefault(DEFAULT_TOOL_CONFIG.autoExtractTikzFigure),
    attachTeXCount: z.boolean().prefault(DEFAULT_TOOL_CONFIG.attachTeXCount),
    attachDiagnostics: z
      .boolean()
      .prefault(DEFAULT_TOOL_CONFIG.attachDiagnostics),
    autoCompileInputPdf: z
      .boolean()
      .prefault(DEFAULT_TOOL_CONFIG.autoCompileInputPdf),
  })
  .prefault(DEFAULT_TOOL_CONFIG);

export type ToolConfig = z.infer<typeof ToolConfigSchema>;
