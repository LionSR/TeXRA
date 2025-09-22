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
export const ToolConfigSchema = z.object({
    reflect: z.boolean().prefault(false),
    autoExtractFigure: z.boolean().prefault(false),
    autoExtractTikzFigure: z.boolean().prefault(false),
    attachTeXCount: z.boolean().prefault(false),
    attachDiagnostics: z.boolean().prefault(false),
    printInputPrompt: z.boolean().prefault(false),
    autoCompileInputPdf: z.boolean().prefault(false),
  })
  .prefault({});

export type ToolConfig = z.infer<typeof ToolConfigSchema>;
