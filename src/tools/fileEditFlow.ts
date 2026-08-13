// Local imports - shared schemas
import { ToolError, type ToolResult } from '@shared/schemas';

// Local imports - tools
import { requireFileReadForEdit } from '@tools/fileInteractions';
import {
  assertWritable,
  currentToolRoot,
  resolveAndFormat,
} from '@tools/pathResolution';
import {
  appendApprovalDiffNote,
  requestAndWriteApprovedEdit,
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
export function replaceFirstLiteral(
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
export function replaceAllLiteral(
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
export function findOccurrenceLineNumbers(
  content: string,
  needle: string,
): number[] {
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

type EditableFileLoad =
  { blocked: ToolResult } | { exists: boolean; originalContent: string };

interface ResolveWritableTargetOptions {
  missing?: 'allow' | 'require';
  validate?: (target: { path: string; displayPath: string }) => void;
}

/** Apply the shared read-before-edit gate, then load the current content. */
export async function loadEditableFile(
  path: string,
  missing: 'allow' | 'require' = 'require',
): Promise<EditableFileLoad> {
  const exists = await WorkspaceFS.exists(path);
  const blocked = requireFileReadForEdit(path, exists);
  if (blocked) {
    return { blocked };
  }

  return {
    exists,
    originalContent:
      exists || missing === 'require' ? await WorkspaceFS.read(path) : '',
  };
}

/** Resolve, authorize, read-gate, and load a workspace file for editing. */
export async function resolveWritableTarget(
  inputPath: string,
  options: ResolveWritableTargetOptions = {},
): Promise<WritableTargetPreparation> {
  const { path: resolved, display: displayPath } = resolveAndFormat(
    inputPath,
    currentToolRoot(),
  );
  assertWritable(resolved, displayPath);

  const path = resolved.fsPath;
  options.validate?.({ path, displayPath });
  const loaded = await loadEditableFile(path, options.missing);
  if ('blocked' in loaded) {
    return loaded;
  }
  return {
    target: {
      path,
      displayPath,
      ...loaded,
    },
  };
}

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
  firstMatchLine: number;
  lineNumbers: number[];
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

  const lineNumbers = findOccurrenceLineNumbers(content, search);
  const firstMatchIndex = content.indexOf(search);
  if (mode === 'unique' && count > 1) {
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
    firstMatchLine: content.slice(0, firstMatchIndex).split('\n').length,
    lineNumbers,
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
  beforeWrite?: () => void | Promise<void>;
  afterWrite?: (edit: AppliedFileEdit) => void | Promise<void>;
  startLine?: 'approval' | 'omit';
  diffSeparator?: string;
}

/**
 * Apply an approved edit and shape its canonical tool result.
 *
 * Callers declare presentation and the few lifecycle hooks that are genuinely
 * tool-specific; approval, writing, rejection, diff notes, and edit metadata
 * remain one invariant pipeline.
 */
export async function applyApprovedFileEdit({
  path,
  displayPath,
  originalContent,
  proposedContent,
  sourceTool,
  present,
  beforeWrite,
  afterWrite,
  startLine = 'omit',
  diffSeparator,
}: ApprovedFileEditRequest): Promise<ToolResult> {
  const outcome = await requestAndWriteApprovedEdit({
    path,
    displayPath,
    originalContent,
    proposedContent,
    sourceTool,
    beforeWrite,
  });
  if ('rejected' in outcome) {
    return outcome.rejected;
  }

  const edit: AppliedFileEdit = outcome;
  await afterWrite?.(edit);
  const presentation = present(edit);
  const output = appendApprovalDiffNote(
    presentation.output,
    displayPath,
    proposedContent,
    edit.appliedContent,
    diffSeparator,
  );

  return {
    status: 'executed',
    summary: presentation.summary,
    output,
    userPatch: edit.approval.userPatch,
    edits: [
      {
        path: displayPath,
        lineChanges: edit.approval.lineChanges,
        ...(startLine === 'approval' && {
          startLine: edit.approval.startLine,
        }),
      },
    ],
  };
}
