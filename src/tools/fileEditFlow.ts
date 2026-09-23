// Third-party imports
import { Effect, FileSystem } from 'effect';

// Local imports - common
import { ToolCall } from '@agent/runtime/ToolCall';

// Local imports - shared schemas
import { WorkspaceFs } from '@platform/rootedFs';
import { ToolError, type ToolResult } from '@shared/schemas';

// Local imports - tools
import { requireFileReadForEdit } from '@tools/fileInteractions';
import { resolveAndFormat } from '@tools/pathResolution';
import {
  appendApprovalDiffNote,
  buildApprovalRejectedResult,
  requestToolEditApproval,
  writeApprovedContent,
  type AcceptedToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';
import { normalizeLineEndings } from '@utils/text/stringUtils';

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 * Returns 0 for empty needles.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
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

/**
 * Resolve, read-gate, and load a workspace file for editing. Writability is
 * not asked here: the write tools declare their target as a loop-side guard,
 * so a read-only external root is already refused before this runs.
 */
export const resolveWritableTarget = Effect.fn('resolveWritableTarget')(
  function* (
    inputPath: string,
    options: ResolveWritableTargetOptions = {},
  ): Effect.fn.Return<
    WritableTargetPreparation,
    unknown,
    ToolCall | FileSystem.FileSystem
  > {
    // Resolution and the caller's own validation both reject with a ToolError
    // the tool runner reports to the model, so they stay a failure rather than
    // becoming a defect.
    const call = yield* ToolCall;
    const { path: resolved, display } = yield* resolveAndFormat(
      call.roots,
      call.roots.workspace,
      inputPath,
      call.workingDirectory,
    );
    const { path, absolutePath, displayPath } = yield* Effect.try({
      try: () => {
        const fsPath = resolved.fsPath;
        options.validate?.({ path: fsPath, displayPath: display });
        return {
          path: fsPath,
          // The resolution answered for the call's own workspace, so its
          // absolute form is the one the process filesystem reads —
          // including a path under a registered external root, which the
          // workspace facade reached the same way.
          absolutePath: resolved.absolute,
          displayPath: display,
        };
      },
      catch: (error) => error,
    });

    // Shared read-before-edit gate, then the current content. The gate asks
    // whether the path names a filesystem entry at all, so it must answer
    // true for a dangling symlink: `fs.exists` stats through the link and
    // reports one as missing, so the readLink fallback supplies the lstat
    // half that gates it.
    const fs = yield* FileSystem.FileSystem;
    const exists =
      (yield* fs.exists(absolutePath)) ||
      (yield* fs.readLink(absolutePath).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      ));
    const blocked = yield* requireFileReadForEdit(path, exists);
    if (blocked) {
      return { blocked };
    }

    const originalContent =
      exists || (options.missing ?? 'require') === 'require'
        ? yield* fs
            .readFileString(absolutePath)
            .pipe(Effect.map(normalizeLineEndings))
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
  }: ApprovedFileEditRequest): Effect.fn.Return<
    ToolResult,
    unknown,
    ToolCall | FileSystem.FileSystem | WorkspaceFs
  > {
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
