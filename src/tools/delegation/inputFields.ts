/**
 * Shared input-field schemas and attachment validation for delegation tools.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - logger
import { toErrorMessage } from '@common/errors';

// Local imports - tools
import type { ToolResult } from '@shared/schemas/toolResult';
import { formatBytes } from '@shared/utils/string';
import { parseWorkingDirectory } from '@tools/pathResolution';
import { isWorktreeSupportEnabled } from '@tools/worktreeConfig';

// Local imports - memory
import { displayToStoragePath } from '@tools/memory/memoryUtils';

// Local imports - utils
import { AbsoluteFS, WorkspaceFS } from '@utils/files';
import { hasExtension } from '@utils/core/pathCore';
import { isNonEmptyString } from '@utils/core/stringCore';

// Local imports - delegation
import type { WorkflowAgentInput } from '../DelegationTools';

const LARGE_BIB_LIMIT_BYTES = 100 * 1024;

/**
 * Shared Zod field for the `memories` parameter on delegation tools.
 * Validates that all paths are within /memories using displayToStoragePath
 * (prefix + traversal checks). Existence is NOT checked — getAttachedMemories
 * handles read failures gracefully, avoiding a TOCTOU race.
 */
export const memoriesField = z
  .array(z.string())
  .prefault([])
  .describe(
    'Memory file paths to attach (e.g. /memories/conventions.md). Content is injected into the agent prompt as read-only context. Use for project conventions, style guides, or accumulated knowledge the agent should follow.',
  )
  .superRefine((memories, ctx) => {
    for (const [i, memory] of memories.entries()) {
      try {
        displayToStoragePath(memory);
      } catch (e) {
        ctx.addIssue({
          code: 'custom',
          path: [i],
          message:
            e instanceof Error ? e.message : `Invalid memory path: ${memory}`,
        });
      }
    }
  });

const WORKTREE_DISABLED_MESSAGE =
  "git worktree support is disabled in this workspace. Omit working_directory, or enable 'Allow agents to work in git worktrees' on the Multi-Agent settings tab.";
const TOOL_USE_SUBAGENT_HANDOFF_INSTRUCTION = [
  'Delegated task handoff:',
  '- Treat the delegated instruction as your full task contract.',
  '- Follow any tool, network, file, approval, output-format, or scope constraints it includes.',
  '- If a requested action conflicts with those constraints or needs missing context, report the conflict instead of guessing permission.',
  '- Your final response is delivered verbatim to the parent orchestrator.',
  '- Include the substantive result requested: answer, findings, evidence/checks, and unresolved caveats.',
  '- Do not finish with only status/process notes such as "done", "complete", or "no files were edited"; if no files were edited, state that after the task result.',
].join('\n');

export function withToolUseSubagentHandoffInstruction(
  instruction: string,
): string {
  const trimmed = instruction.trimEnd();
  return trimmed
    ? `${trimmed}\n\n${TOOL_USE_SUBAGENT_HANDOFF_INSTRUCTION}`
    : TOOL_USE_SUBAGENT_HANDOFF_INSTRUCTION;
}

function ensureWorkingDirectoryExists(dir: string): void {
  try {
    if (AbsoluteFS.statSync(dir).isDirectory()) return;
  } catch (e) {
    throw new Error(
      `working_directory must be an existing directory: ${toErrorMessage(e)}`,
      { cause: e },
    );
  }
  throw new Error(`working_directory must be a directory: ${dir}`);
}

/**
 * Shared Zod field for the `working_directory` parameter on delegation tools.
 * Validates and normalizes in one step so downstream code always receives the
 * canonical `string | undefined` value — no trimming or absolute-path checks
 * needed at the call site.
 */
export const workingDirectoryField = z
  .string()
  .nullish()
  .describe(
    'Absolute path for the subagent to operate in (e.g. a git worktree). All tool calls within the subagent will automatically use this as their root directory. Defaults to workspace root. Only accepted when git worktree support is enabled on the Multi-Agent settings tab.',
  )
  .transform((value, ctx): string | undefined => {
    let trimmed: string | undefined;
    try {
      trimmed = parseWorkingDirectory(value);
    } catch (e) {
      ctx.addIssue({
        code: 'custom',
        message: toErrorMessage(e),
      });
      return z.NEVER;
    }
    if (!trimmed) return trimmed;
    if (!isWorktreeSupportEnabled()) {
      ctx.addIssue({
        code: 'custom',
        message: WORKTREE_DISABLED_MESSAGE,
      });
      return z.NEVER;
    }
    try {
      ensureWorkingDirectoryExists(trimmed);
    } catch (e) {
      ctx.addIssue({
        code: 'custom',
        message: toErrorMessage(e),
      });
      return z.NEVER;
    }
    return trimmed;
  });

function isBibFile(filePath: string): boolean {
  return hasExtension(filePath, '.bib');
}

/** Reject workflow proposals that attach oversized bibliography files. */
export async function rejectOversizedBibAttachments(
  input: WorkflowAgentInput,
): Promise<ToolResult | null> {
  const bibFiles = input.contextFiles
    .filter(isNonEmptyString)
    .filter(isBibFile);

  for (const bibFile of bibFiles) {
    const stats = await WorkspaceFS.stat(bibFile);
    if (stats.size <= LARGE_BIB_LIMIT_BYTES) continue;

    const message = `${bibFile} is ${stats.size} bytes (${formatBytes(stats.size)}), over the ${LARGE_BIB_LIMIT_BYTES} byte (${formatBytes(LARGE_BIB_LIMIT_BYTES)}) limit. Call extract_bib_entries first if citations are needed, then re-propose without the full .bib file.`;
    return {
      summary: `Rejected oversized BibTeX attachment`,
      error: message,
      output: message,
      isError: true,
      diagnostics: {
        type: 'oversized_bib_attachment',
        path: bibFile,
        sizeBytes: stats.size,
        limitBytes: LARGE_BIB_LIMIT_BYTES,
      },
    };
  }

  return null;
}
