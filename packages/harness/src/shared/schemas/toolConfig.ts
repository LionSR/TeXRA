/**
 * The main view's file-processing switches (`LaunchSurface`, `CheckboxValues`).
 * Residue of the main-view schema living in the harness: the documents
 * plugin builds its task options from these fields
 * (`DocumentTaskOptionsSchema`), and both leave with that schema.
 */
import { z } from 'zod';

export const DEFAULT_TOOL_CONFIG = {
  autoExtractFigure: false,
  autoExtractTikzFigure: false,
  attachTeXCount: false,
  autoCompileInputPdf: false,
  /** A task reviews each revision but the last with the bundled `critic`
   *  and feeds its critique into the next revision. */
  reflect: false,
} as const;

type ToolConfigField = keyof typeof DEFAULT_TOOL_CONFIG;

/**
 * Base tool config object schema (exposes .shape for composition).
 * Field-level prefaults handle partial inputs.
 */
export const ToolConfigFieldsSchema = z.object(
  Object.fromEntries(
    Object.entries(DEFAULT_TOOL_CONFIG).map(([key, defaultValue]) => [
      key,
      z.boolean().prefault(defaultValue),
    ]),
  ) as { [K in ToolConfigField]: z.ZodPrefault<z.ZodBoolean> },
);
