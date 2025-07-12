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
export const ToolConfigSchema = z.object({
  reflect: z.boolean(),
  usePrefillFromInput: z.boolean(),
  autoExtractFigure: z.boolean(),
  autoExtractTikzFigure: z.boolean(),
  attachTeXCount: z.boolean(),
  printInputPrompt: z.boolean(),
  autoCompileInputPdf: z.boolean(),
}).strict();
