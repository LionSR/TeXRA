/**
 * Tool configuration schema - shared between AgentConfig and MainViewPersistedState.
 */
import { z } from 'zod';

export const DEFAULT_TOOL_CONFIG = {
  autoExtractFigure: false,
  autoExtractTikzFigure: false,
  attachTeXCount: false,
  attachDiagnostics: false,
  autoCompileInputPdf: false,
} as const;

/**
 * Base tool config object schema (exposes .shape for composition).
 * Field-level prefaults handle partial inputs.
 */
export const ToolConfigFieldsSchema = z.object({
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
});

/**
 * Tool config schema with object-level prefault for standalone use.
 * Use ToolConfigFieldsSchema.shape for composition with other schemas.
 */
export const ToolConfigSchema =
  ToolConfigFieldsSchema.prefault(DEFAULT_TOOL_CONFIG);

export type ToolConfig = z.infer<typeof ToolConfigSchema>;
