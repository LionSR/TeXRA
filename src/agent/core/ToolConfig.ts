// Third-party imports
import { z } from 'zod';

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
    autoCompileInputPdf: z.boolean().default(false),
  })
  .strip()
  .default({});

export type ToolConfig = z.infer<typeof ToolConfigSchema>;
