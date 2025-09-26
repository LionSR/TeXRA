// Third-party imports
import { z } from 'zod';

export const TOOL_CONFIG_DEFAULTS = {
  reflect: false,
  autoExtractFigure: false,
  autoExtractTikzFigure: false,
  attachTeXCount: false,
  attachDiagnostics: false,
  printInputPrompt: false,
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
    reflect: z.boolean().default(false),
    autoExtractFigure: z.boolean().default(false),
    autoExtractTikzFigure: z.boolean().default(false),
    attachTeXCount: z.boolean().default(false),
    attachDiagnostics: z.boolean().default(false),
    printInputPrompt: z.boolean().default(false),
    autoCompileInputPdf: z.boolean().default(false),
  })
  .strip()
  .default(TOOL_CONFIG_DEFAULTS);

export type ToolConfig = z.infer<typeof ToolConfigSchema>;
