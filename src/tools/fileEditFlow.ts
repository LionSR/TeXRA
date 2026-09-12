// Third-party imports
import { Effect } from 'effect';

// Local imports - common
import { ToolCall } from '@agent/runtime/ToolCall';
import { hostPort } from '@common/hostPort';

// Local imports - shared schemas
import { ToolError, type ToolResult } from '@shared/schemas';

// Local imports - tools
import { requireFileReadForEdit } from '@tools/fileInteractions';
import { assertWritable, resolveAndFormat } from '@tools/pathResolution';
import {
  appendApprovalDiffNote,
  buildApprovalRejectedResult,
  requestToolEditApproval,
  writeApprovedContent,
  type AcceptedToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';
import { WorkspaceFS } from '@utils/files/workspaceFS';

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 * Returns 0 for empty needles.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Replace the first literal occurrence of `oldStr` with `newStr`.
 *
 * `newStr` is inserted verbatim — replacement patterns are NOT interpreted.
 * Returns the content unchanged when `oldStr` does not occur; callers that
 * require a match should validate occurrences first with `countOccurrences`.
 */
function replaceFirstLiteral(
  content: string,
  oldStr: string,
  newStr: string,
): string {
  if (oldStr.length === 0) {
    throw new ToolError(
      'replaceFirstLiteral requires a non-empty search string.',
    );
  }
  const idx = content.indexOf(oldStr);
  if (idx === -1) {
    return content;
  }
  return content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
}

/**
 * Replace every literal occurrence of `oldStr` with `newStr`.
 *
 * `newStr` is inserted verbatim — replacement patterns are NOT interpreted.
 * `oldStr` must be non-empty; an empty needle throws to avoid the pathological
 * `''.split('')` behavior.
 */
function replaceAllLiteral(
  content: string,
  oldStr: string,
  newStr: string,
): string {
  if (oldStr.length === 0) {
    throw new ToolError(
      'replaceAllLiteral requires a non-empty search string.',
    );
  }
  return content.split(oldStr).join(newStr);
}

/**
 * 1-indexed line numbers of every line that contains `needle`. Used to build
 * the "not unique — found in lines X, Y" guidance when a search string matches
 * more than once.
 */
function findOccurrenceLineNumbers(content: string, needle: string): number[] {
  if (needle.length === 0) {
    return [];
  }
  return content
    .split('\n')
    .flatMap((line, index) => (line.includes(needle) ? [index + 1] : []));
}

interface WritableFileTarget {
  path: string;
  displayPath: string;
  exists: boolean;
  originalContent: string;
}

type WritableTargetPreparation =
  { blocked: ToolResult } | { target: WritableFileTarget };

interface ResolveWritableTargetOptions {
  missing?: 'allow' | 'require';
  validate?: (target: { path: string; displayPath: string }) => void;
}

/** Resolve, authorize, read-gate, and load a workspace file for editing. */
export const resolveWritableTarget = Effect.fn('resolveWritableTarget')(
  function* (
    inputPath: string,
    options: ResolveWritableTargetOptions = {},
  ): Effect.fn.Return<WritableTargetPreparation, unknown, ToolCall> {
    // Resolution, the read-only-root check and the caller's own validation all
    // reject with a ToolError the tool runner reports to the model, so they
    // stay a failure rather than becoming a defect.
    const call = yield* ToolCall;
    const { path, displayPath } = yield* Effect.try({
      try: () =>
        call.inScope(() => {
          const { path: resolved, display } = resolveAndFormat(
            inputPath,
            call.workingDirectory,
          );
          assertWritable(resolved, display);

          const fsPath = resolved.fsPath;
          options.validate?.({ path: fsPath, displayPath: display });
          return { path: fsPath, displayPath: display };
        }),
      catch: (error) => error,
    });

    // Shared read-before-edit gate, then the current content.
    const exists = yield* hostPort(() =>
      call.inScope(() => WorkspaceFS.exists(path)),
    );
    const blocked = yield* requireFileReadForEdit(path, exists);
    if (blocked) {
      return { blocked };
    }

    const originalContent =
      exists || (options.missing ?? 'require') === 'require'
        ? yield* hostPort(() => call.inScope(() => WorkspaceFS.read(path)))
        : '';

    return {
      target: {
        path,
        displayPath,
        exists,
        originalContent,
      },
    };
  },
);

interface LiteralMatchContext {
  count: number;
  lineNumbers: number[];
}

interface LiteralReplacementRequest {
  content: string;
  search: string;
  replacement: string;
  mode: 'unique' | 'all';
  notFoundError: () => string;
  multipleMatchesError?: (context: LiteralMatchContext) => string;
}

interface LiteralReplacement {
  content: string;
  count: number;
}

/** Apply an exact literal replacement under an explicit match policy. */
export function replaceLiteralMatches({
  content,
  search,
  replacement,
  mode,
  notFoundError,
  multipleMatchesError,
}: LiteralReplacementRequest): LiteralReplacement {
  const count = countOccurrences(content, search);
  if (count === 0) {
    throw new ToolError(notFoundError());
  }

  if (mode === 'unique' && count > 1) {
    // Only ambiguous matches need the per-line guidance, so the scan over the
    // whole file stays out of the common single-match path.
    const lineNumbers = findOccurrenceLineNumbers(content, search);
    throw new ToolError(
      multipleMatchesError?.({ count, lineNumbers }) ??
        'The text to replace must be unique.',
    );
  }

  return {
    // Slice/split-based primitives insert replacement strings verbatim; unlike
    // String.replace, dollar patterns in LaTeX or code are never interpreted.
    content:
      mode === 'all'
        ? replaceAllLiteral(content, search, replacement)
        : replaceFirstLiteral(content, search, replacement),
    count: mode === 'all' ? count : 1,
  };
}

interface AppliedFileEdit {
  approval: AcceptedToolEditApprovalResult;
  appliedContent: string;
  baseContent: string;
}

interface FileEditPresentation {
  summary: string;
  output: string;
}

interface ApprovedFileEditRequest {
  path: string;
  displayPath: string;
  originalContent: string;
  proposedContent: string;
  sourceTool: string;
  present: (edit: AppliedFileEdit) => FileEditPresentation;
}

/**
 * Request approval for an edit, write the approved content (the user's
 * adjustments if any, else the proposal), and shape the canonical tool
 * result. Callers declare only the presentation; approval, writing,
 * rejection, diff notes, and edit metadata remain one invariant pipeline.
 */
export const applyApprovedFileEdit = Effect.fn('applyApprovedFileEdit')(
  function* ({
    path,
    displayPath,
    originalContent,
    proposedContent,
    sourceTool,
    present,
  }: ApprovedFileEditRequest): Effect.fn.Return<ToolResult, unknown, ToolCall> {
    const approval = yield* requestToolEditApproval({
      path,
      originalContent,
      proposedContent,
      sourceTool,
    });
    if (approval.action !== 'apply') {
      return buildApprovalRejectedResult(displayPath, sourceTool, approval);
    }

    const written = yield* writeApprovedContent(
      path,
      originalContent,
      approval.appliedContent,
    );
    const presentation = present({ approval, ...written });
    const output = appendApprovalDiffNote(
      presentation.output,
      displayPath,
      proposedContent,
      written.appliedContent,
    );

    return {
      status: 'executed',
      summary: presentation.summary,
      output,
      userPatch: approval.userPatch,
      edits: [
        {
          path: displayPath,
          lineChanges: approval.lineChanges,
          startLine: approval.startLine,
        },
      ],
    };
  },
);
