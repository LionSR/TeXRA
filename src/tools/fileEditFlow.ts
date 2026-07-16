// Local imports - shared schemas
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';

// Local imports - tools
import {
  findOccurrenceLineNumbers,
  replaceAllLiteral,
  replaceFirstLiteral,
} from '@tools/editPrimitives';
import { requireFileReadForEdit } from '@tools/fileInteractions';
import {
  assertWritable,
  currentToolRoot,
  resolveAndFormat,
} from '@tools/pathResolution';
import { countOccurrences } from '@tools/utils';
import {
  appendApprovalDiffNote,
  requestAndWriteApprovedEdit,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';
import { WorkspaceFS } from '@utils/files';

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
  if (mode === 'unique' && count > 1) {
    if (!multipleMatchesError) {
      throw new ToolError('The text to replace must be unique.');
    }
    throw new ToolError(multipleMatchesError({ count, lineNumbers }));
  }

  return {
    content:
      mode === 'all'
        ? replaceAllLiteral(content, search, replacement)
        : replaceFirstLiteral(content, search, replacement),
    count: mode === 'all' ? count : 1,
    lineNumbers,
  };
}

interface AppliedFileEdit {
  approval: ToolEditApprovalResult;
  appliedContent: string;
  baseContent: string;
}

interface FileEditPresentation {
  summary: string;
  output: string;
  userInstruction?: string;
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
    ...(presentation.userInstruction && {
      userInstruction: presentation.userInstruction,
    }),
  };
}
