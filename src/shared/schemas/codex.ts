// Third-party imports
import { z } from 'zod';

/**
 * Codex tool-log identifiers and Zod schemas (pure data: no platform,
 * `vscode`, or `node:*` dependencies).
 *
 * Used both by the backend Codex tool-log builders (`@tools/codexShared`) and
 * by the progress-view webview formatters, which key on the tool-name constants
 * and `.safeParse()` the schemas while rendering. They live in
 * `@shared/schemas` so the webview frontend never imports runtime values from
 * the backend `src/tools/` zone.
 */

/** Synthetic tool names for the native Codex tool-use cards. */
export const CODEX_FILE_CHANGE_TOOL = 'codex_patch';
export const CODEX_THREAD_TOOL = 'codex_thread';
export const CODEX_TODO_TOOL = 'codex_todo';
export const CODEX_TURN_TOOL = 'codex_turn';

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
