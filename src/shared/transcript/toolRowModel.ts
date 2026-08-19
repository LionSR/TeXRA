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
  CODEX_FILE_CHANGE_TOOL,
  CODEX_THREAD_TOOL,
  CODEX_TODO_TOOL,
  CODEX_TURN_TOOL,
  CodexFileChangeToolInputSchema,
  CodexMcpToolOutputSchema,
  CodexThreadToolInputSchema,
  CodexTodoToolInputSchema,
  CodexTurnToolInputSchema,
  TOOL_USE_STATUS,
  WorkflowScriptFilesSchema,
  getProposalFileGroups,
  type NormalizedToolUse,
  type ProposalFileGroup,
  type ToolUseStatus,
} from '@shared/schemas';
import {
  EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS,
  EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS,
  EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS,
} from '@shared/toolUse';
import {
  DELEGATE_MULTI_AGENTS_TOOL_NAME,
  DELEGATION_TOOLS,
} from '@shared/constants/delegationTools';
import {
  executionsAction,
  executionsSubagentSummary,
  type ExecutionLabels,
} from '@shared/tools/executionsDisplay';
import {
  displayToolName,
  isMcpToolName,
  normalizeToolName,
} from '@shared/tools/toolDisplayName';
import { deriveToolInputPreview } from '@shared/tools/toolInputPreview';
import { isEditLikeToolName, toolDisplayKind } from '@shared/tools/toolKind';
import { clamp, filterNotNullish, formatDuration, isObject } from '@utils/core';
import { collapseWhitespace } from '@utils/text/stringUtils';

import {
  stringifyPayload,
  transcriptText,
  type PayloadLanguage,
  type TextMetrics,
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

interface ToolTextSection extends ToolSectionBase {
  readonly kind: 'text';
  readonly text: TranscriptText;
}

interface ToolCodeSection extends ToolSectionBase {
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

interface ToolRowElision {
  /** Length of the untruncated single-line header preview. */
  readonly headerPreview: TextMetrics;
  readonly output?: TextMetrics;
  readonly error?: TextMetrics;
  readonly userInstruction?: TextMetrics;
}

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
  readonly spillPath?: string;
  readonly elision: ToolRowElision;
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
 * The header preview both hosts show. A shell call is described by its
 * command, so `bash`-kind tools prefer the input preview; every other tool
 * reports its own summary first and falls back to the input preview while it
 * is still in flight.
 */
function toolHeaderPreview(
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
// Section builders
// ---------------------------------------------------------------------------

type SectionContext = {
  readonly toolName: string;
  readonly input: unknown;
  readonly filePath: string;
  readonly parsedOutput: unknown;
  readonly outputText: string;
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function textSection(label: string, body: string): ToolTextSection {
  return { kind: 'text', label, text: transcriptText(body) };
}

function codeSection(
  label: string,
  body: string,
  language: string,
): ToolCodeSection {
  return { kind: 'code', label, text: transcriptText(body), language };
}

function fileGroupsSection(
  groups: readonly ProposalFileGroup[],
): ToolFileGroupsSection | undefined {
  return groups.length === 0
    ? undefined
    : { kind: 'fileGroups', label: 'Files:', groups };
}

/** Typed `edits` array a tool attaches to its structured output. */
function outputEdits<T>(output: unknown): T[] | undefined {
  return isObject(output) ? (output.edits as T[] | undefined) : undefined;
}

/**
 * The old/new pair an edit-like call carries. No schema spans every producer:
 * TeXRA's `edit_file` writes `old_str`/`new_str`, a delegated Claude `Edit`
 * writes `old_string`/`new_string`, and `MultiEdit` nests an array of those,
 * so each candidate is read with explicit guards.
 */
function editCandidates(
  input: unknown,
): { oldText: string; newText: string }[] {
  if (!isObject(input)) return [];
  const source = Array.isArray(input.edits) ? input.edits : [input];
  return source
    .map((raw) => {
      if (!isObject(raw)) return undefined;
      const oldText = asString(raw.old_str) ?? asString(raw.old_string);
      const newText = asString(raw.new_str) ?? asString(raw.new_string);
      return oldText === undefined || newText === undefined
        ? undefined
        : { oldText, newText };
    })
    .filter(filterNotNullish);
}

function buildEditSections(ctx: SectionContext): ToolSection[] {
  const candidates = editCandidates(ctx.input);
  if (candidates.length === 0) return [];
  const sections: ToolSection[] = [];
  const startLine = outputEdits<{ startLine?: number }>(ctx.parsedOutput)?.[0]
    ?.startLine;
  if (ctx.filePath) {
    sections.push({
      kind: 'file',
      label: 'File:',
      path: ctx.filePath,
      namespace: 'workspace',
      ...(startLine !== undefined ? { startLine } : {}),
    });
  }
  for (const candidate of candidates) {
    sections.push({
      kind: 'diff',
      label: '',
      oldText: candidate.oldText,
      newText: candidate.newText,
    });
  }
  return sections;
}

function buildReadSections(ctx: SectionContext): ToolSection[] {
  if (!ctx.filePath) return [];
  const range =
    isObject(ctx.input) && isObject(ctx.input.range)
      ? ctx.input.range
      : undefined;
  const start = typeof range?.start === 'number' ? range.start : undefined;
  const end = typeof range?.end === 'number' ? range.end : undefined;
  return [
    {
      kind: 'file',
      label: 'File:',
      path: ctx.filePath,
      namespace: 'workspace',
      ...(start !== undefined ? { startLine: start } : {}),
      ...(end !== undefined ? { endLine: end } : {}),
    },
  ];
}

function buildWriteSections(ctx: SectionContext): ToolSection[] {
  if (!ctx.filePath) return [];
  const sections: ToolSection[] = [
    {
      kind: 'file',
      label: 'File:',
      path: ctx.filePath,
      namespace: 'workspace',
    },
  ];
  const content =
    isObject(ctx.input) && typeof ctx.input.content === 'string'
      ? ctx.input.content
      : undefined;
  if (content !== undefined) sections.push(codeSection('', content, 'file'));
  return sections;
}

/**
 * `MemoryToolInput` is a host-only discriminated union this browser-safe
 * module cannot import, so each displayed field is read with its own guard
 * rather than mirrored as a second schema.
 */
function buildMemorySections(ctx: SectionContext): ToolSection[] {
  const { input } = ctx;
  if (!isObject(input) || typeof input.command !== 'string') return [];
  const command = input.command;
  const path = asString(input.path);
  const memPath = command === 'rename' ? '' : (path ?? '');
  const sections: ToolSection[] = [];
  if (memPath) {
    sections.push({
      kind: 'file',
      label: 'File:',
      path: memPath,
      namespace: 'memory',
    });
  }

  const oldStr = asString(input.old_str);
  const newStr = asString(input.new_str);
  const fileText = asString(input.file_text);
  const insertText = asString(input.insert_text) ?? newStr;
  const insertLine =
    typeof input.insert_line === 'number' ? input.insert_line : undefined;

  if (command === 'str_replace' && oldStr != null && newStr != null) {
    sections.push({
      kind: 'diff',
      label: '',
      oldText: oldStr,
      newText: newStr,
    });
  } else if (command === 'create' && fileText != null) {
    sections.push(codeSection('', fileText, 'file'));
  } else if (command === 'insert' && insertText != null) {
    const label =
      insertLine != null ? `Insert at line ${insertLine}:` : 'Insert:';
    sections.push(codeSection(label, insertText, 'file'));
  } else if (command === 'rename') {
    const oldPath = asString(input.old_path);
    const newPath = asString(input.new_path);
    if (oldPath != null && newPath != null) {
      sections.push(textSection('Rename:', `${oldPath} → ${newPath}`));
    }
  }
  return sections;
}

/** Clamp of the `executions wait` timeout, matching what the tool enforces. */
function executionsWaitTimeoutSeconds(timeout: unknown): number {
  return typeof timeout === 'number' && Number.isFinite(timeout)
    ? clamp(
        timeout,
        EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS,
        EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS,
      )
    : EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS;
}

function buildExecutionsSections(ctx: SectionContext): ToolSection[] {
  const { input } = ctx;
  if (!isObject(input)) return [];
  const sections: ToolSection[] = [];
  const path = asString(input.path) ?? '';
  if (path) {
    sections.push({
      kind: 'file',
      label: 'Path:',
      path,
      namespace: 'execution',
    });
  }

  const action = executionsAction(input);
  if (action === 'wait') {
    const timeout = executionsWaitTimeoutSeconds(input.timeout);
    sections.push(textSection('Action:', `wait (timeout: ${timeout}s)`));
  } else if (action === 'kill') {
    sections.push(textSection('Action:', 'kill'));
  }

  const viewRange = input.view_range;
  if (
    Array.isArray(viewRange) &&
    typeof viewRange[0] === 'number' &&
    typeof viewRange[1] === 'number'
  ) {
    sections.push(
      textSection('Range:', `lines ${viewRange[0]}–${viewRange[1]}`),
    );
  }
  if (typeof input.offset === 'number') {
    sections.push(textSection('Offset:', String(input.offset)));
  }
  if (typeof input.limit === 'number') {
    sections.push(textSection('Limit:', String(input.limit)));
  }
  return sections;
}

function buildAcceptRunFilesSections(ctx: SectionContext): ToolSection[] {
  const { input } = ctx;
  if (!isObject(input)) return [];
  const sections: ToolSection[] = [];
  const executionId = asString(input.execution_id);
  if (executionId) {
    sections.push({
      kind: 'identifier',
      label: 'Execution:',
      value: executionId,
    });
  }

  const raw = Array.isArray(input.files) ? input.files : [];
  if (raw.length === 0) return sections;
  const edits = outputEdits<{
    path?: string;
    lineChanges?: { added: number; removed: number };
  }>(ctx.parsedOutput);
  const editsByPath = new Map(
    (edits ?? [])
      .filter((edit) => edit.path)
      .map((edit) => [edit.path as string, edit] as const),
  );
  const files: ToolSectionFile[] = raw.map((entry) => {
    const source = isObject(entry) ? (asString(entry.path) ?? '') : '';
    const original = isObject(entry) ? asString(entry.original) : undefined;
    const dest = original ?? source;
    const lineChanges = editsByPath.get(dest)?.lineChanges;
    return {
      path: dest,
      ...(dest && source && dest !== source ? { from: source } : {}),
      ...(lineChanges ? { lineChanges } : {}),
    };
  });
  sections.push({ kind: 'fileList', label: 'Files:', files });
  return sections;
}

/**
 * `DelegateAgentInput`/`WorkflowAgentInput` derive from host-only schemas, so
 * each displayed field is read with its own guard.
 */
function buildDelegationSections(ctx: SectionContext): ToolSection[] {
  const { input } = ctx;
  if (!isObject(input)) return [];
  const sections: ToolSection[] = [];

  const executionId = asString(input.execution_id);
  if (executionId) {
    sections.push({ kind: 'identifier', label: 'Resume:', value: executionId });
  }

  const agent = asString(input.agent);
  const model = asString(input.model);
  if (agent || model) {
    sections.push({
      kind: 'identifier',
      label: 'Agent:',
      value: agent ?? 'unknown',
      ...(model ? { note: model } : {}),
    });
  }

  const instruction = asString(input.instruction);
  if (instruction) sections.push(textSection('Instruction:', instruction));

  const badges = [
    input.extractFigures ? 'Extract figures' : undefined,
    input.extractTikz ? 'Extract TikZ' : undefined,
  ].filter(filterNotNullish);
  if (badges.length > 0) {
    sections.push({ kind: 'badges', label: 'Extraction:', badges });
  }

  const files = fileGroupsSection(
    getProposalFileGroups({
      inputFiles: toStringArray(input.inputFiles),
      contextFiles: toStringArray(input.contextFiles),
      mediaFiles: toStringArray(input.mediaFiles),
      outputFiles: toStringArray(input.outputFiles),
      memories: toStringArray(input.memories),
    }),
  );
  if (files) sections.push(files);
  return sections;
}

function buildWorkflowScriptSections(ctx: SectionContext): ToolSection[] {
  const { input } = ctx;
  if (!isObject(input)) {
    return [textSection('Input:', 'Workflow script input is unavailable.')];
  }
  const sections: ToolSection[] = [];

  const agent = asString(input.agent);
  if (agent !== undefined) {
    sections.push({ kind: 'identifier', label: 'Agent:', value: agent });
  }

  const script = asString(input.script);
  if (script !== undefined) {
    sections.push(codeSection('Script:', script, 'javascript'));
  }

  if (Object.hasOwn(input, 'args')) {
    const args = input.args ?? null;
    sections.push(codeSection('Args:', JSON.stringify(args, null, 2), 'json'));
  }

  const files = WorkflowScriptFilesSchema.safeParse(input.files);
  const filesSection = files.success
    ? fileGroupsSection(getProposalFileGroups(files.data))
    : undefined;
  if (filesSection) sections.push(filesSection);
  return sections;
}

function isMcpTextBlock(block: unknown): block is { text: string } {
  return (
    isObject(block) && block.type === 'text' && typeof block.text === 'string'
  );
}

/**
 * MCP output is shown, structured when it can be and raw when it cannot.
 * Ad-hoc MCP servers are not obliged to emit Codex-shaped output, so a schema
 * mismatch here is the intended "not structured output" path, not a producer
 * bug: it falls through to the raw `Result:` section below.
 */
function buildMcpSections(ctx: SectionContext): ToolSection[] {
  const sections: ToolSection[] = [];
  const args = stringifyPayload(ctx.input);
  if (args.text.full) {
    sections.push({
      kind: 'code',
      label: 'Arguments:',
      text: args.text,
      language: args.language,
    });
  }

  const parsed = CodexMcpToolOutputSchema.nullable()
    .catch(null)
    .parse(ctx.parsedOutput);
  const blocks = Array.isArray(parsed?.contentBlocks)
    ? parsed.contentBlocks
    : [];
  const textBlocks = blocks.filter(isMcpTextBlock).map((block) => block.text);
  const otherBlocks = blocks.filter((block) => !isMcpTextBlock(block));
  let structured = false;

  if (typeof parsed?.status === 'string') {
    sections.push({ kind: 'status', label: 'Status:', status: parsed.status });
    structured = true;
  }
  if (textBlocks.length > 0) {
    sections.push(textSection('Response:', textBlocks.join('\n\n')));
    structured = true;
  }
  if (parsed && 'structuredContent' in parsed) {
    const payload = stringifyPayload(parsed.structuredContent);
    if (payload.text.full) {
      sections.push({
        kind: 'code',
        label: 'Structured:',
        text: payload.text,
        language: payload.language,
      });
      structured = true;
    }
  }
  if (otherBlocks.length > 0) {
    const payload = stringifyPayload(otherBlocks);
    if (payload.text.full) {
      sections.push({
        kind: 'code',
        label: 'Content:',
        text: payload.text,
        language: payload.language,
      });
      structured = true;
    }
  }
  if (!structured && ctx.outputText) {
    sections.push(textSection('Result:', ctx.outputText));
  }
  return sections;
}

/**
 * The five native Codex cards (`codex`, `codex_patch`, `codex_thread`,
 * `codex_todo`, `codex_turn`). They used to be a webview-only Lit override;
 * expressed as sections they reach the terminal too, and the check marks,
 * change kinds and badges are one derivation instead of two.
 */
function buildCodexSections(ctx: SectionContext): ToolSection[] {
  const { input } = ctx;
  if (!isObject(input)) return [];
  const sections: ToolSection[] = [];
  const prompt = asString(input.prompt);
  if (prompt) sections.push(textSection('Prompt:', prompt));
  const badges: string[] = [];
  const sandboxMode = asString(input.sandbox_mode);
  if (sandboxMode) badges.push(sandboxMode);
  // A thread id means the call continues an existing Codex conversation.
  if (asString(input.thread_id)) badges.push('follow-up');
  if (badges.length > 0) {
    sections.push({ kind: 'badges', label: 'Mode:', badges });
  }
  return sections;
}

function buildCodexPatchSections(ctx: SectionContext): ToolSection[] {
  const parsed = CodexFileChangeToolInputSchema.safeParse(ctx.input);
  if (!parsed.success) return [];
  const sections: ToolSection[] = [];
  const status = parsed.data.patchStatus;
  if (status) sections.push({ kind: 'status', label: 'Status:', status });
  if (parsed.data.changes.length > 0) {
    sections.push({
      kind: 'fileList',
      label: 'Files:',
      files: parsed.data.changes.map((change) => ({
        path: change.path,
        note: change.kind,
      })),
    });
  }
  return sections;
}

function buildCodexThreadSections(ctx: SectionContext): ToolSection[] {
  const parsed = CodexThreadToolInputSchema.safeParse(ctx.input);
  if (!parsed.success || !parsed.data.threadId) return [];
  return [
    { kind: 'identifier', label: 'Thread ID:', value: parsed.data.threadId },
  ];
}

function buildCodexTodoSections(ctx: SectionContext): ToolSection[] {
  const parsed = CodexTodoToolInputSchema.safeParse(ctx.input);
  if (!parsed.success) return [];
  const { items, completedCount, totalCount } = parsed.data;
  const sections: ToolSection[] = [];
  if (totalCount > 0) {
    sections.push({
      kind: 'badges',
      label: 'Progress:',
      badges: [`${completedCount}/${totalCount} completed`],
    });
  }
  if (items.length > 0) {
    sections.push({
      kind: 'checklist',
      label: 'Checklist:',
      items: items.map((item) => ({ text: item.text, done: item.completed })),
    });
  }
  return sections;
}

function buildCodexTurnSections(ctx: SectionContext): ToolSection[] {
  const parsed = CodexTurnToolInputSchema.safeParse(ctx.input);
  if (!parsed.success) return [];
  const sections: ToolSection[] = [
    { kind: 'status', label: 'State:', status: parsed.data.state },
  ];
  const wallTimeMs = parsed.data.wallTimeMs ?? 0;
  if (wallTimeMs > 0) {
    sections.push(textSection('Duration:', formatDuration(wallTimeMs)));
  }
  return sections;
}

function buildDefaultSections(ctx: SectionContext): ToolSection[] {
  const { input } = ctx;
  if (input == null) return [];
  if (isObject(input)) {
    const code = input.code ?? input.command;
    if (typeof code === 'string') return [codeSection('', code, 'shell')];
  }
  const payload = stringifyPayload(input);
  if (!payload.text.full) return [];
  return [
    { kind: 'code', label: '', text: payload.text, language: payload.language },
  ];
}

/** TeXRA's native tools name the target file `path`; a delegated sub-agent's
 *  built-in Read/Write/Edit tools use Anthropic's own `file_path`. */
function inputFilePath(input: unknown): string {
  if (!isObject(input)) return '';
  return asString(input.path) ?? asString(input.file_path) ?? '';
}

const SECTION_BUILDERS: readonly {
  readonly match: (ctx: SectionContext) => boolean;
  readonly build: (ctx: SectionContext) => ToolSection[];
}[] = [
  {
    match: (ctx) => isEditLikeToolName(ctx.toolName) && isObject(ctx.input),
    build: buildEditSections,
  },
  {
    match: (ctx) =>
      toolDisplayKind(ctx.toolName) === 'read' && Boolean(ctx.filePath),
    build: buildReadSections,
  },
  {
    match: (ctx) =>
      toolDisplayKind(ctx.toolName) === 'write' && Boolean(ctx.filePath),
    build: buildWriteSections,
  },
  {
    match: (ctx) => normalizeToolName(ctx.toolName) === 'memory',
    build: buildMemorySections,
  },
  {
    match: (ctx) => normalizeToolName(ctx.toolName) === 'executions',
    build: buildExecutionsSections,
  },
  {
    match: (ctx) => normalizeToolName(ctx.toolName) === 'accept_run_files',
    build: buildAcceptRunFilesSections,
  },
  {
    match: (ctx) => ctx.toolName === DELEGATE_MULTI_AGENTS_TOOL_NAME,
    build: buildWorkflowScriptSections,
  },
  {
    match: (ctx) => DELEGATION_TOOLS.has(ctx.toolName) && isObject(ctx.input),
    build: buildDelegationSections,
  },
  { match: (ctx) => isMcpToolName(ctx.toolName), build: buildMcpSections },
  {
    match: (ctx) => normalizeToolName(ctx.toolName) === 'codex',
    build: buildCodexSections,
  },
  {
    match: (ctx) => ctx.toolName === CODEX_FILE_CHANGE_TOOL,
    build: buildCodexPatchSections,
  },
  {
    match: (ctx) => ctx.toolName === CODEX_THREAD_TOOL,
    build: buildCodexThreadSections,
  },
  {
    match: (ctx) => ctx.toolName === CODEX_TODO_TOOL,
    build: buildCodexTodoSections,
  },
  {
    match: (ctx) => ctx.toolName === CODEX_TURN_TOOL,
    build: buildCodexTurnSections,
  },
];

function dispatchSections(ctx: SectionContext): {
  sections: ToolSection[];
  /** True when the matched builder already carries the call's output. */
  carriesOutput: boolean;
} {
  for (const { match, build } of SECTION_BUILDERS) {
    if (!match(ctx)) continue;
    // A matched builder that finds nothing displayable (an edit-like tool
    // whose input shape it does not recognize) falls through to the generic
    // renderer instead of leaving the row bare.
    const sections = build(ctx);
    if (sections.length === 0) break;
    return {
      sections,
      // `delegate_multi_agents` is deliberately absent: its sections describe
      // the call (agent, script, args, files) and carry no output, so calling
      // them 'rendered-by-sections' hid the script's real result.
      carriesOutput:
        isMcpToolName(ctx.toolName) ||
        sections.some((section) => section.kind === 'diff'),
    };
  }
  return { sections: buildDefaultSections(ctx), carriesOutput: false };
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
 * MCP output is shown, through the structured sections. The CLI's former
 * "hide unless bash or MCP" allowlist is gone: terminal economy is a paint-
 * time head/tail elision, never a decision to drop the data.
 */
function outputSuppression(
  normalized: NormalizedToolUse,
  headerPreview: string,
  carriesOutput: boolean,
): ToolOutputSuppression | undefined {
  const { outputText, errorText, toolName } = normalized;
  if (!outputText) return 'empty';
  const collapsed = collapseWhitespace(outputText).trim();
  if (collapsed && collapsed === collapseWhitespace(headerPreview).trim()) {
    return 'duplicate-of-header';
  }
  if (collapsed && collapsed === collapseWhitespace(errorText).trim()) {
    return 'duplicate-of-error';
  }
  if (carriesOutput) return 'rendered-by-sections';
  const kind = toolDisplayKind(toolName);
  if (kind === 'read') return 'file-link';
  if (kind === 'write' && outputText.trim() === TRIVIAL_WRITE_OUTPUT) {
    return 'trivial-write';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

function metricsOf(text: TranscriptText): TextMetrics {
  return { lineCount: text.lineCount, charCount: text.charCount };
}

export function toolRowModel(
  normalized: NormalizedToolUse,
  ctx: ToolRowModelContext = {},
): ToolRowModel {
  const headerPreview = toolHeaderPreview(normalized, ctx);
  const { sections, carriesOutput } = dispatchSections({
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
  const previewText = transcriptText(headerPreview);

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
    ...(normalized.spillPath ? { spillPath: normalized.spillPath } : {}),
    elision: {
      headerPreview: metricsOf(previewText),
      ...(output ? { output: metricsOf(output) } : {}),
      ...(errorPreview ? { error: metricsOf(errorPreview) } : {}),
      ...(userInstruction
        ? { userInstruction: metricsOf(userInstruction) }
        : {}),
    },
  };
}
