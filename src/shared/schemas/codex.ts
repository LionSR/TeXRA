// Third-party imports
import { z } from 'zod';

/**
 * Zod schemas for Codex tool-log inputs/outputs.
 *
 * These are pure data validators (no platform, `vscode`, or `node:*`
 * dependencies) used both by the backend Codex tool-log builders
 * (`@tools/codexShared`) and by the progress-view webview formatters, which
 * `.safeParse()` them while rendering. They live in `@shared/schemas` so the
 * webview frontend never imports runtime values from the backend `src/tools/`
 * zone.
 */

const CodexFileChangeItemSchema = z.object({
  path: z.string(),
  kind: z.string(),
});

export const CodexFileChangeToolInputSchema = z.object({
  changes: z.array(CodexFileChangeItemSchema),
  patchStatus: z.string().nullish(),
});

export type CodexFileChangeToolInput = z.infer<
  typeof CodexFileChangeToolInputSchema
>;

export const CodexMcpToolOutputSchema = z.object({
  status: z.string().optional(),
  structuredContent: z.unknown().optional(),
  contentBlocks: z.array(z.record(z.string(), z.unknown())).optional(),
});

export type CodexMcpToolOutput = z.infer<typeof CodexMcpToolOutputSchema>;

export const CodexThreadToolInputSchema = z.object({
  threadId: z.string(),
});

export type CodexThreadToolInput = z.infer<typeof CodexThreadToolInputSchema>;

const CodexTodoItemSchema = z.object({
  text: z.string(),
  completed: z.boolean(),
});

export const CodexTodoToolInputSchema = z.object({
  items: z.array(CodexTodoItemSchema),
  completedCount: z.number(),
  totalCount: z.number(),
});

export type CodexTodoToolInput = z.infer<typeof CodexTodoToolInputSchema>;

const CodexTurnStateSchema = z.enum(['running', 'completed', 'failed']);
export type CodexTurnState = z.infer<typeof CodexTurnStateSchema>;

export const CodexTurnToolInputSchema = z.object({
  state: CodexTurnStateSchema,
  wallTimeMs: z.number().nullish(),
});

export type CodexTurnToolInput = z.infer<typeof CodexTurnToolInputSchema>;
