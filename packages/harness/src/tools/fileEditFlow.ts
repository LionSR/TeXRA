// Third-party imports
import { Effect, FileSystem, Result } from 'effect';

// Local imports - common
import { ToolContext } from '@tools/core/ToolTypes';

// Local imports - shared schemas
import type { AppSignals } from '@platform/appSignals';
import { WorkspaceFs } from '@platform/rootedFs';
import { ToolError, type ToolResult } from '@shared/schemas';
import { resolveToolPath } from '@tools/pathResolution';

// Local imports - tools
import {
  appendApprovalDiffNote,
  buildApprovalRejectedResult,
  requestToolEditApproval,
} from '@tools/approval/toolEditApproval';
import { writeApprovedContent } from '@tools/approval/approvedWrite';
import { entryExists } from '@utils/files/fsEntryExists';
import { readNormalizedFile } from '@utils/files/fsDurability';

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 * Returns 0 for empty needles.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}

/** A file an edit tool may rewrite, with the content it holds now. */
interface WritableFileTarget {
  path: string;
  displayPath: string;
  /** The file's content; null when there is no file yet. */
  original: string | null;
}

/** Resolve and load a file for editing. */
export const resolveWritableTarget = Effect.fn('resolveWritableTarget')(
  function* (
    inputPath: string,
  ): Effect.fn.Return<
    WritableFileTarget,
    Error,
    ToolContext | FileSystem.FileSystem
  > {
    const call = yield* ToolContext;
    const {
      fsPath: path,
      absolute: absolutePath,
      display: displayPath,
    } = yield* resolveToolPath(call.env, inputPath);

    const fs = yield* FileSystem.FileSystem;
    const exists = yield* entryExists(fs, absolutePath);

    return {
      path,
      displayPath,
      original: exists ? yield* readNormalizedFile(fs, absolutePath) : null,
    };
  },
);

interface LiteralReplacementRequest {
  content: string;
  search: string;
  replacement: string;
  /** Replace every occurrence; otherwise the single match, failing when it is
   *  not unique. */
  replaceAll: boolean;
  notFoundError: () => string;
  multipleMatchesError: (count: number) => string;
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
  replaceAll,
  notFoundError,
  multipleMatchesError,
}: LiteralReplacementRequest): Result.Result<LiteralReplacement, ToolError> {
  const count = countOccurrences(content, search);
  if (count === 0) {
    return Result.fail(new ToolError(notFoundError()));
  }

  if (!replaceAll && count > 1) {
    return Result.fail(new ToolError(multipleMatchesError(count)));
  }

  // A function replacer inserts its result verbatim: dollar patterns in prose
  // or code are never interpreted.
  const verbatim = (): string => replacement;
  return Result.succeed({
    content: replaceAll
      ? content.replaceAll(search, verbatim)
      : content.replace(search, verbatim),
    count: replaceAll ? count : 1,
  });
}

interface AppliedFileEdit {
  appliedContent: string;
}

interface FileEditPresentation {
  summary: string;
  output: string;
}

interface ApprovedFileEditRequest {
  target: WritableFileTarget;
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
    target: { path, displayPath, original },
    proposedContent,
    sourceTool,
    present,
  }: ApprovedFileEditRequest): Effect.fn.Return<
    ToolResult,
    Error,
    ToolContext | FileSystem.FileSystem | WorkspaceFs | AppSignals
  > {
    const approval = yield* requestToolEditApproval({
      path,
      originalContent: original,
      proposedContent,
      sourceTool,
    });
    if (approval.action !== 'apply') {
      return buildApprovalRejectedResult(displayPath, sourceTool, approval);
    }

    const written = yield* writeApprovedContent(
      path,
      approval.originalContent,
      approval.appliedContent,
    );
    const presentation = present(written);
    const output = yield* appendApprovalDiffNote(
      presentation.output,
      displayPath,
      approval.proposedContent,
      written.appliedContent,
    );

    return {
      status: 'executed',
      summary: presentation.summary,
      output,
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
