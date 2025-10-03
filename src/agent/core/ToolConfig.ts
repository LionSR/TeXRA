// Third-party imports
import { z } from 'zod';

const TOOL_CONFIG_DEFAULTS = {
  reflect: false,
  autoExtractFigure: false,
  autoExtractTikzFigure: false,
  attachTeXCount: false,
  attachDiagnostics: false,
  autoCompileInputPdf: false,
} as const;

/**
 * Zod schema for validating ToolConfig objects.
 * Defaults are defined at the property level and the schema itself
 * defaults to an empty object, allowing omission of the entire
 * configuration section.
 *
 * We explicitly strip unknown properties to remain backward compatible
 * with legacy settings that may still include removed flags.
 */
export const ToolConfigSchema = z
  .object({
    reflect: z.boolean().default(TOOL_CONFIG_DEFAULTS.reflect),
    autoExtractFigure: z
      .boolean()
      .default(TOOL_CONFIG_DEFAULTS.autoExtractFigure),
    autoExtractTikzFigure: z
      .boolean()
      .default(TOOL_CONFIG_DEFAULTS.autoExtractTikzFigure),
    attachTeXCount: z.boolean().default(TOOL_CONFIG_DEFAULTS.attachTeXCount),
    attachDiagnostics: z
      .boolean()
      .default(TOOL_CONFIG_DEFAULTS.attachDiagnostics),
    autoCompileInputPdf: z
      .boolean()
      .default(TOOL_CONFIG_DEFAULTS.autoCompileInputPdf),
  })
  .strip()
  .default(TOOL_CONFIG_DEFAULTS);

export const DEFAULT_TOOL_CONFIG = TOOL_CONFIG_DEFAULTS;

export type ToolConfig = z.infer<typeof ToolConfigSchema>;
