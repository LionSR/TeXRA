/** Configuration interface for controlling tool behavior and automation features. */
import { z } from 'zod';

export interface ToolConfig {
  reflect: boolean;
  usePrefillFromInput: boolean;
  autoExtractFigure: boolean;
  autoExtractTikzFigure: boolean;
  attachTeXCount: boolean;
  printInputPrompt: boolean;
  autoCompileInputPdf: boolean;
}

/** Zod schema for ToolConfig validation */
export const ToolConfigSchema = z.object({
  reflect: z.boolean(),
  usePrefillFromInput: z.boolean(),
  autoExtractFigure: z.boolean(),
  autoExtractTikzFigure: z.boolean(),
  attachTeXCount: z.boolean(),
  printInputPrompt: z.boolean(),
  autoCompileInputPdf: z.boolean(),
});
