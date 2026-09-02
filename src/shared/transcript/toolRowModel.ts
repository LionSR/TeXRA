/**
 * The one fold from a normalized tool-use payload to everything a host paints
 * for a tool row: header label, header preview, the structured sections that
 * describe the call, its output and error, and the measurements a host needs
 * to elide any of them.
 *
 * Before this module the two hosts assembled tool rows independently. The
 * progress view parsed delegation, workflow-script and MCP inputs into typed
 * sections while the CLI fell through to `JSON.stringify(input)`; the CLI
 * showed output only for `bash` and MCP while the progress view showed it for
 * everything else. Both halves live here now — sections are data, never
 * markup, so the Lit and Ink layers are the only per-host code left.
 */
import {
  TOOL_USE_STATUS,
  type NormalizedToolUse,
  type ProposalFileGroup,
  type ToolUseStatus,
} from '@shared/schemas';
import {
  executionsSubagentSummary,
  type ExecutionLabels,
} from '@shared/tools/executionsDisplay';
import {
  displayToolName,
  normalizeToolName,
} from '@shared/tools/toolDisplayName';
import { deriveToolInputPreview } from '@shared/tools/toolInputPreview';
import { toolDisplayKind } from '@shared/tools/toolKind';
import { collapseWhitespace } from '@utils/text/stringUtils';

import { dispatchSections, inputFilePath } from './toolRowSections';
import {
  transcriptText,
  type PayloadLanguage,
  type TranscriptText,
} from './transcriptText';

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** One file row inside a {@link ToolFileListSection}. */
export interface ToolSectionFile {
  readonly path: string;
  /** Source path when the call maps a produced file onto a different one. */
  readonly from?: string;
  /** Parenthetical qualifier for this file alone — a Codex patch's change
   *  kind (`add`/`update`/`delete`), for instance. */
  readonly note?: string;
  readonly lineChanges?: { readonly added: number; readonly removed: number };
}

/** Which path vocabulary a {@link ToolFileSection} names. */
type ToolFileNamespace = 'workspace' | 'memory' | 'execution';

interface ToolSectionBase {
  /** Display prefix (`Files:`, `Instruction:`); empty for an unlabeled body. */
  readonly label: string;
}

export interface ToolTextSection extends ToolSectionBase {
  readonly kind: 'text';
  readonly text: TranscriptText;
}

export interface ToolCodeSection extends ToolSectionBase {
  readonly kind: 'code';
  readonly text: TranscriptText;
  /** Highlighting hint: a language id, or the serializer that produced it. */
  readonly language: string | PayloadLanguage;
}

interface ToolIdentifierSection extends ToolSectionBase {
  readonly kind: 'identifier';
  readonly value: string;
  /** Parenthetical qualifier, e.g. the model an agent runs on. */
  readonly note?: string;
}

export interface ToolFileSection extends ToolSectionBase {
  readonly kind: 'file';
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly namespace: ToolFileNamespace;
}

export interface ToolFileGroupsSection extends ToolSectionBase {
  readonly kind: 'fileGroups';
  readonly groups: readonly ProposalFileGroup[];
}

export interface ToolFileListSection extends ToolSectionBase {
  readonly kind: 'fileList';
  readonly files: readonly ToolSectionFile[];
}

interface ToolDiffSection extends ToolSectionBase {
  readonly kind: 'diff';
  readonly oldText: string;
  readonly newText: string;
  /** Painter label for this hunk when no real file section can represent it. */
  readonly fileLabel?: string;
}

interface ToolBadgesSection extends ToolSectionBase {
  readonly kind: 'badges';
  readonly badges: readonly string[];
}

interface ToolStatusSection extends ToolSectionBase {
  readonly kind: 'status';
  readonly status: string;
}

/** One line of a {@link ToolChecklistSection}. */
interface ToolChecklistItem {
  readonly text: string;
  readonly done: boolean;
}

/** A tool's own task list — Codex's `codex_todo` card today. Carried as data
 *  so each host draws its own check mark instead of shipping glyphs. */
export interface ToolChecklistSection extends ToolSectionBase {
  readonly kind: 'checklist';
  readonly items: readonly ToolChecklistItem[];
}

export type ToolSection =
  | ToolTextSection
  | ToolCodeSection
  | ToolIdentifierSection
  | ToolFileSection
  | ToolFileGroupsSection
  | ToolFileListSection
  | ToolDiffSection
  | ToolBadgesSection
  | ToolStatusSection
  | ToolChecklistSection;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * Why the generic output block carries nothing for this call. Absent when the
 * output is shown.
 */
type ToolOutputSuppression =
  | 'empty'
  | 'duplicate-of-header'
  | 'duplicate-of-error'
  | 'rendered-by-sections'
  | 'file-link'
  | 'trivial-write';

export interface ToolRowModel {
  /** Tool name as a user reads it (`MCP fs/read`, `Multi-agent workflow`). */
  readonly headerLabel: string;
  /** Untruncated single-line "what is this call doing" text; `''` when the
   *  call says nothing beyond its name. Hosts cut it to their own width. */
  readonly headerPreview: string;
  readonly sections: readonly ToolSection[];
  /** Untruncated tool output; present only when {@link showOutput}. */
  readonly output?: TranscriptText;
  /** Untruncated error text. Named `preview` because hosts cut it. */
  readonly errorPreview?: TranscriptText;
  /** The instruction a user typed when rejecting or redirecting the call. */
  readonly userInstruction?: TranscriptText;
  readonly showOutput: boolean;
  readonly outputSuppression?: ToolOutputSuppression;
  readonly status?: ToolUseStatus;
  readonly isError: boolean;
  readonly isUserFeedback: boolean;
  readonly isInProgress: boolean;
  readonly exitCode?: number;
}

export interface ToolRowModelContext {
  /** Subagent execution id -> label, for the `executions` header summary. */
  readonly executionLabels?: ExecutionLabels;
  /** The raw `data.output` of the tool-use payload. Structured sections read
   *  it directly (MCP content blocks, edit start lines, per-file line
   *  changes); `NormalizedToolUse.outputText` is its flattened text. */
  readonly parsedOutput?: unknown;
}

/** Entire output of a `write`-kind tool that wrote a file and said so. */
const TRIVIAL_WRITE_OUTPUT = 'written';

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/** Cut a header summary at the point it starts quoting streamed output, so a
 *  tool that folds stdout into its summary does not push the actual summary
 *  off the row. No length cut — that belongs to the painter. */
function headerSummaryText(summary: string): string {
  const oneLine = collapseWhitespace(summary);
  const marker = oneLine.search(/\s+<(?:stdout|stderr)>/i);
  return marker >= 0 ? oneLine.slice(0, marker).trim() || oneLine : oneLine;
}

/**
 * The header preview both hosts show, and the only statement of its
 * precedence: a shell call is described by its command, so `bash`-kind tools
 * prefer the input preview; every other tool reports its own summary first and
 * falls back to the input preview while it is still in flight.
 *
 * Exported because subagent execution labels exist only at paint time in the
 * terminal (they name live executions), so the CLI re-derives the preview once
 * the labels are known rather than restating the precedence over the model's
 * already-computed value.
 */
export function toolHeaderPreview(
  normalized: NormalizedToolUse,
  ctx: ToolRowModelContext,
): string {
  const { toolName, input, headerSummary } = normalized;
  const labeled =
    normalizeToolName(toolName) === 'executions' && ctx.executionLabels
      ? executionsSubagentSummary(input, ctx.executionLabels)
      : undefined;
  const inputPreview =
    labeled ?? collapseWhitespace(deriveToolInputPreview(toolName, input));
  const summary = headerSummaryText(headerSummary);
  return toolDisplayKind(toolName) === 'bash'
    ? inputPreview || summary
    : summary || inputPreview;
}

// ---------------------------------------------------------------------------
// Output suppression — the one ruleset
// ---------------------------------------------------------------------------

/**
 * Tool output is SHOWN. It is withheld from the generic output block only
 * when that block would repeat something the row already says:
 *
 *  - `empty`                — there is no output.
 *  - `duplicate-of-header`  — the output is exactly the header preview.
 *  - `duplicate-of-error`   — the output is exactly the error text.
 *  - `rendered-by-sections` — the matched section builder already carries it:
 *                             MCP structured/`Result:` sections, an edit diff.
 *  - `file-link`            — a `read`-kind call, whose file link IS the
 *                             content.
 *  - `trivial-write`        — a `write`-kind call whose whole output is
 *                             `written`.
 *
 * The last two are keyed on the link the section builder actually built, not
 * on the tool kind: a `read`/`write` call whose input carries no path builds
 * no link, and suppressing its output would drop the result with nothing shown
 * in its place.
 *
 * MCP output is shown, through the structured sections. The CLI's former
 * "hide unless bash or MCP" allowlist is gone: terminal economy is a paint-
 * time head/tail elision, never a decision to drop the data.
 */
function outputSuppression(
  normalized: NormalizedToolUse,
  headerPreview: string,
  carriesOutput: boolean,
  fileLinkKind: 'read' | 'write' | undefined,
): ToolOutputSuppression | undefined {
  const { outputText, errorText } = normalized;
  if (!outputText) return 'empty';
  const collapsed = collapseWhitespace(outputText).trim();
  if (collapsed && collapsed === collapseWhitespace(headerPreview).trim()) {
    return 'duplicate-of-header';
  }
  if (collapsed && collapsed === collapseWhitespace(errorText).trim()) {
    return 'duplicate-of-error';
  }
  if (carriesOutput) return 'rendered-by-sections';
  if (fileLinkKind === 'read') return 'file-link';
  if (fileLinkKind === 'write' && outputText.trim() === TRIVIAL_WRITE_OUTPUT) {
    return 'trivial-write';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

export function toolRowModel(
  normalized: NormalizedToolUse,
  ctx: ToolRowModelContext = {},
): ToolRowModel {
  const headerPreview = toolHeaderPreview(normalized, ctx);
  const { sections, carriesOutput, fileLinkKind } = dispatchSections({
    toolName: normalized.toolName,
    input: normalized.input,
    filePath: inputFilePath(normalized.input),
    parsedOutput: ctx.parsedOutput,
    outputText: normalized.outputText,
  });

  const suppression = outputSuppression(
    normalized,
    headerPreview,
    carriesOutput,
    fileLinkKind,
  );
  const output =
    suppression === undefined
      ? transcriptText(normalized.outputText)
      : undefined;
  // A user-feedback row shows the instruction, not the tool's error text: the
  // "error" is the user's own rejection.
  const errorPreview =
    normalized.errorText && !normalized.isUserFeedback
      ? transcriptText(normalized.errorText)
      : undefined;
  const userInstruction = normalized.userInstructionText
    ? transcriptText(normalized.userInstructionText)
    : undefined;

  return {
    headerLabel: displayToolName(normalized.toolName),
    headerPreview,
    sections,
    ...(output ? { output } : {}),
    ...(errorPreview ? { errorPreview } : {}),
    ...(userInstruction ? { userInstruction } : {}),
    showOutput: suppression === undefined,
    ...(suppression ? { outputSuppression: suppression } : {}),
    ...(normalized.status ? { status: normalized.status } : {}),
    isError: normalized.isError,
    isUserFeedback: normalized.isUserFeedback,
    isInProgress: normalized.status === TOOL_USE_STATUS.IN_PROGRESS,
    ...(normalized.exitCode !== undefined
      ? { exitCode: normalized.exitCode }
      : {}),
  };
}
