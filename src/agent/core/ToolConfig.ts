import { z } from 'zod';

/** Configuration interface for controlling tool behavior and automation features. */
export interface ToolConfig {
  reflect: boolean;
  usePrefillFromInput: boolean;
  autoExtractFigure: boolean;
  autoExtractTikzFigure: boolean;
  attachTeXCount: boolean;
  printInputPrompt: boolean;
  autoCompileInputPdf: boolean;
}

/** Zod schema for validating ToolConfig objects */
export const DEFAULT_TOOL_CONFIG: ToolConfig = {
  reflect: false,
  usePrefillFromInput: false,
  autoExtractFigure: false,
  autoExtractTikzFigure: false,
  attachTeXCount: false,
  printInputPrompt: false,
  autoCompileInputPdf: false,
};

export const ToolConfigSchema = z
  .object({
    reflect: z.boolean().default(false),
    usePrefillFromInput: z.boolean().default(false),
    autoExtractFigure: z.boolean().default(false),
    autoExtractTikzFigure: z.boolean().default(false),
    attachTeXCount: z.boolean().default(false),
    printInputPrompt: z.boolean().default(false),
    autoCompileInputPdf: z.boolean().default(false),
  })
  .strict()
  .default(DEFAULT_TOOL_CONFIG);
