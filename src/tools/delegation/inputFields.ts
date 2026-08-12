/**
 * Shared input-field schemas and attachment validation for delegation tools.
 */

// Third-party imports
import { z } from 'zod';

// Local imports
import type { ToolResult } from '@shared/schemas/toolResult';
import { parseWorkingDirectory } from '@tools/pathResolution';
import { errorResult } from '@tools/core/result';
import { displayToStoragePath } from '@tools/memory/memoryUtils';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { isWorktreeSupportEnabled } from '@utils/config/worktreeConfig';
import {
  extractErrorMessage,
  toErrorMessage,
} from '@utils/errors/errorMessage';
import { hasExtension } from '@utils/core/pathCore';
import { formatBytes, isNonEmptyString } from '@utils/text/stringUtils';

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
          message: extractErrorMessage(e) ?? `Invalid memory path: ${memory}`,
        });
      }
    }
  });

/** Schema for the delegate_workflow tool (document processing). */
export const WorkflowAgentInputSchema = z.strictObject({
  agent: z.string().describe('Name of the workflow agent to execute'),
  model: z
    .string()
    .nullish()
    .describe(
      'Model short name from the Available models line. Omit unless the user explicitly requested a model. Defaults to the current model when available.',
    ),
  instruction: z
    .string()
    .describe(
      'State what the agent should do in plain prose. Include the document subject, the changes wanted, and any constraints (terminology, scope, sections to prioritize). If you attach context or media files, name each one and explain its role. For example: "preamble.tex defines the math macros; refs.bib is the bibliography to cite from; figure.png shows the panel layout to match". The subagent has no other signal for why each file was attached.',
    ),
  inputFiles: z
    .array(z.string())
    .min(1)
    .describe(
      'Files the agent rewrites. List every file you want it to touch. The agent emits one revised <document> per entry.',
    ),
  contextFiles: z
    .array(z.string())
    .prefault([])
    .describe(
      'Read-only context the agent should see but not modify: guidance, examples, related papers, bibliographies (.bib), style/macro definitions (.sty/.cls). Explain each one in the instruction.',
    ),
  mediaFiles: z
    .array(z.string())
    .prefault([])
    .describe('Images, figures, PDFs, or audio files the agent should view.'),
  extractFigures: z
    .boolean()
    .nullish()
    .describe(
      'When true, automatically extracts figures referenced by the input LaTeX file(s) (via \\includegraphics, \\begin{overpic}) and attaches them as media files. Merges with any explicitly provided mediaFile/mediaFiles.',
    ),
  extractTikz: z
    .boolean()
    .nullish()
    .describe(
      'When true, extracts TikZ figures from the input LaTeX file(s), compiles them into standalone PDFs, and attaches them as media files.',
    ),
  outputFiles: z
    .array(z.string())
    .prefault([])
    .describe(
      'Output file paths. Must be a subset of input files. Never create new files or change format. Leave empty for default suffix-based outputs.',
    ),
  memories: memoriesField,
});

export type WorkflowAgentInput = z.infer<typeof WorkflowAgentInputSchema>;

const WORKTREE_DISABLED_MESSAGE =
  "git worktree support is disabled in this workspace. Omit working_directory, or ask the user to turn on `texra.git.worktreeSupport` ('Allow agents to work in git worktrees' on the Multi-Agent settings tab).";
const TOOL_USE_SUBAGENT_HANDOFF_INSTRUCTION = [
  'The delegated instruction above is your full task contract. This includes any tool, network, file, approval, output-format, or scope constraints it states. If a requested action conflicts with those constraints or needs missing context, report the conflict instead of assuming permission.',
  'Your final response is delivered verbatim to the parent orchestrator. End with the substantive result (answer, findings, evidence, unresolved caveats), never only a status note such as "done".',
].join(' ');
export function withToolUseSubagentHandoffInstruction(
  instruction: string,
  parentInstruction?: string,
): string {
  const trimmed = instruction.trim();
  const trimmedParent = parentInstruction?.trim();
  const parts = trimmed ? [trimmed] : [];
  if (trimmedParent) {
    const contextBlock =
      trimmedParent === trimmed
        ? 'The delegated task above is copied verbatim from the parent user request.'
        : `Parent user request (constraint context only):\n${trimmedParent}`;
    parts.push(
      `${contextBlock}\n\nConstraints in the parent user request are mandatory and override conflicting delegated-task wording. Do not repeat orchestration actions assigned to the parent.`,
    );
  }
  parts.push(TOOL_USE_SUBAGENT_HANDOFF_INSTRUCTION);
  return parts.join('\n\n');
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
    'Absolute path for the subagent to operate in (e.g. a git worktree). All tool calls within the subagent will automatically use this as their root directory. Defaults to workspace root. Only accepted when git worktree support (`texra.git.worktreeSupport`) is enabled for this workspace.',
  )
  .transform((value, ctx): string | undefined => {
    const fail = (message: string): typeof z.NEVER => {
      ctx.addIssue({ code: 'custom', message });
      return z.NEVER;
    };
    let trimmed: string | undefined;
    try {
      trimmed = parseWorkingDirectory(value);
    } catch (e) {
      return fail(toErrorMessage(e));
    }
    if (!trimmed) return trimmed;
    if (!isWorktreeSupportEnabled()) {
      return fail(WORKTREE_DISABLED_MESSAGE);
    }
    try {
      ensureWorkingDirectoryExists(trimmed);
    } catch (e) {
      return fail(toErrorMessage(e));
    }
    return trimmed;
  });

/** Reject delegated workflow context that attaches oversized bibliography files. */
export async function rejectOversizedBibAttachments(
  contextFiles: readonly string[],
): Promise<Extract<ToolResult, { status: 'error' }> | null> {
  const bibFiles = contextFiles
    .filter(isNonEmptyString)
    .filter((file) => hasExtension(file, '.bib'));

  for (const bibFile of bibFiles) {
    const stats = await WorkspaceFS.stat(bibFile);
    if (stats.size <= LARGE_BIB_LIMIT_BYTES) continue;

    const message = `${bibFile} is ${stats.size} bytes (${formatBytes(stats.size)}), over the ${LARGE_BIB_LIMIT_BYTES} byte (${formatBytes(LARGE_BIB_LIMIT_BYTES)}) limit. Call extract_bib_entries first if citations are needed, then re-propose without the full .bib file.`;
    return errorResult(message, {
      summary: `Rejected oversized BibTeX attachment`,
      diagnostics: {
        type: 'oversized_bib_attachment',
        path: bibFile,
        sizeBytes: stats.size,
        limitBytes: LARGE_BIB_LIMIT_BYTES,
      },
    });
  }

  return null;
}

interface WorkflowFileGroup {
  readonly label: string;
  readonly files: readonly string[];
}

/** Validate workspace-backed workflow inputs before launching a child run. */
export async function assertWorkflowFilesExist(
  groups: readonly WorkflowFileGroup[],
): Promise<void> {
  const entries = groups.flatMap(({ label, files }) =>
    files.filter(isNonEmptyString).map((path) => ({ label, path })),
  );
  const inspected = await Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      exists: await WorkspaceFS.exists(entry.path),
    })),
  );
  const missing = inspected.find((entry) => !entry.exists);
  if (missing) {
    throw new Error(`${missing.label} not found: ${missing.path}`);
  }
}
