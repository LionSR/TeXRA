// Host-neutral schemas for desktop in-app diff messages. The main process
// reads original/proposed file contents (renderer is sandboxed) and posts a
// `desktop:showDiff` message to the renderer, which slots them into a
// <texra-diff-view> hosted inside a wa-dialog.

import { z } from 'zod';

export const DESKTOP_DIFF_COMMANDS = {
  SHOW_DIFF: 'desktop:showDiff',
} as const;

export const DesktopDiffPayloadSchema = z.object({
  title: z.string(),
  originalPath: z.string(),
  proposedPath: z.string(),
  originalText: z.string(),
  proposedText: z.string(),
  // Monaco language id ('latex', 'json', 'plaintext', ...). Optional — the
  // renderer falls back to 'plaintext' when missing.
  language: z.string().optional(),
});

export const DesktopShowDiffMessageSchema = z.object({
  command: z.literal(DESKTOP_DIFF_COMMANDS.SHOW_DIFF),
  diff: DesktopDiffPayloadSchema,
});

export type DesktopDiffPayload = z.infer<typeof DesktopDiffPayloadSchema>;
export type DesktopShowDiffMessage = z.infer<
  typeof DesktopShowDiffMessageSchema
>;

// Map a file extension to a Monaco language id. Pure function — host-neutral
// and easy to unit-test. Extend as more languages are needed.
export function languageForExtension(ext: string): string {
  const lower = ext.toLowerCase().replace(/^\./, '');
  switch (lower) {
    case 'tex':
    case 'sty':
    case 'cls':
    case 'bib':
      return 'latex';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'json':
      return 'json';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'html':
    case 'htm':
      return 'html';
    case 'css':
      return 'css';
    case 'py':
      return 'python';
    case 'sh':
    case 'bash':
      return 'shell';
    default:
      return 'plaintext';
  }
}
