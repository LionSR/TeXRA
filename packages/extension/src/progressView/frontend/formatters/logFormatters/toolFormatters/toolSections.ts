/**
 * Per-tool input/output section builders and their dispatch table.
 *
 * `dispatchToolSections` matches a tool name to its section builder; each
 * builder turns a `ToolSectionContext` into the Lit templates rendered inside
 * a tool-use banner. New tools add one entry to `TOOL_SECTION_BUILDERS`.
 *
 * IMPORTANT: Lit templates preserve whitespace literally. Always use
 * single-line templates with `// prettier-ignore` to prevent whitespace issues.
 */

import { html, nothing, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';

import {
  buildToolUseSection,
  wrapInPre,
  buildFileLinkSpan,
  buildFileLinkWithLines,
  buildEditDiffSection,
  buildMemoryPathDisplay,
  buildExecutionsPathDisplay,
  buildStatusBadge,
  SPINNER_ICON_NAME,
} from '@progressView/frontend/formatters/htmlBuilders';
import { stringifyWithLanguage } from '@progressView/frontend/formatters/parseUtils';
import {
  TOOL_CODE_LANGUAGES,
  getLanguageFromPath,
} from '@progressView/frontend/formatters/constants';
import { toolDisplayKind } from '@shared/tools/toolKind';
import { isMcpToolName } from '@shared/tools/toolDisplayName';
import { EXECUTIONS_DEFAULT_ACTION } from '@shared/tools/executionsDisplay';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import {
  DELEGATE_MULTI_AGENTS_TOOL_NAME,
  DELEGATION_TOOLS,
} from '@shared/constants/delegationTools';
import {
  CodexMcpToolOutputSchema,
  type CodexMcpToolOutput,
} from '@shared/schemas/codex';
import {
  getProposalFileGroups,
  type ProposalFileGroup,
} from '@shared/schemas/proposalFields';
import { WorkflowScriptFilesSchema } from '@shared/schemas/workflowScriptFiles';
// Type-only: this is a browser frontend (see eslint `no-restricted-imports`
// for packages/extension/src/{webview,progressView,settingsView}/frontend),
// so runtime values (including each tool's Zod input schema) cannot be
// imported from `@tools/**` here — only their inferred types, which are
// erased at build time. Each builder below therefore validates the input
// shape itself with `isObject`/`typeof` guards rather than a schema parse;
// `WriteInput` is used purely for its (erased) type shape, the rest are
// documented in each builder's own comment.
import type { WriteInput } from '@tools/WriteTool';
import { isObject } from '@utils/core';

import { codexToolRenderers } from '../codexToolTemplates';
import {
  buildToolSection,
  getOutputEdits,
  getExecutionsWaitTimeoutSeconds,
  isMcpTextBlock,
} from './helpers';

type ToolSectionContext = {
  toolName: string;
  input: unknown;
  filePath: string;
  parsedOutput: unknown;
  outputText: string;
};

/** Narrow an unknown field value to a string, dropping non-string values. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function buildFileGroupsSection(
  fileGroups: readonly ProposalFileGroup[],
): TemplateResult | undefined {
  if (fileGroups.length === 0) return undefined;
  // prettier-ignore
  const fileItems = html`${fileGroups.flatMap((group) => group.files.map((file) => html`<li class="detail-item">${waIcon('file')} <span class="${group.clickable ? 'file-link clickable-link' : 'file-label'}" data-file=${ifDefined(group.clickable ? file : undefined)} role=${ifDefined(group.clickable ? 'button' : undefined)} tabindex=${ifDefined(group.clickable ? '0' : undefined)}>${file}</span> <span class="file-source">(${group.label})</span></li>`))}`;
  return buildToolUseSection(
    'Files:',
    html`<ul class="detail-list">
      ${fileItems}
    </ul>`,
  );
}

/**
 * Common shape of the edit_file and str_replace_editor tool inputs, for
 * display purposes only.
 *
 * No single canonical schema validates this shape: this dispatch entry
 * ('edit' display kind) covers three different tool names — edit_file
 * (`EditInputSchema`), str_replace_editor (`TextEditorInputSchema`, a
 * discriminated union where only the `str_replace` branch has
 * old_str/new_str), and str_replace_based_edit_tool, which is Anthropic's
 * native tool-use alias and is not a registered TeXRA tool with its own
 * schema at all. Rather than fabricate a schema spanning all three, this
 * keeps the type-only cast but narrows with explicit runtime `typeof` checks
 * below before any field is used.
 */
type EditDiffLikeInput = { old_str?: unknown; new_str?: unknown };

function buildEditDiffInputSections(ctx: ToolSectionContext): TemplateResult[] {
  const { input, filePath, parsedOutput } = ctx;
  if (!isObject(input)) return [];
  const editInput = input as EditDiffLikeInput;
  if (
    typeof editInput.old_str !== 'string' ||
    typeof editInput.new_str !== 'string'
  ) {
    return [];
  }
  const sections: TemplateResult[] = [];
  const edits = getOutputEdits<{ startLine?: number }>(parsedOutput);
  const startLine = edits?.[0]?.startLine;

  if (filePath) {
    sections.push(
      buildToolUseSection(
        'File:',
        buildFileLinkWithLines(filePath, { startLine }),
      ),
    );
  }
  sections.push(
    buildToolUseSection(
      '',
      buildEditDiffSection(editInput.old_str, editInput.new_str),
    ),
  );
  return sections;
}

/** Narrows `input.range` to the read tool's display-relevant fields. */
function readRangeOf(
  input: unknown,
): { start: number; end?: number } | undefined {
  if (!isObject(input) || !isObject(input.range)) return undefined;
  const { start, end } = input.range;
  if (typeof start !== 'number') return undefined;
  return { start, end: typeof end === 'number' ? end : undefined };
}

function buildFileLinkSections(ctx: ToolSectionContext): TemplateResult[] {
  const { input, filePath } = ctx;
  if (!filePath) return [];
  const range = readRangeOf(input);
  return [
    buildToolUseSection(
      'File:',
      buildFileLinkWithLines(filePath, {
        startLine: range?.start,
        endLine: range?.end,
      }),
    ),
  ];
}

function buildFileContentSections(ctx: ToolSectionContext): TemplateResult[] {
  const { toolName, input, filePath } = ctx;
  if (!filePath) return [];
  // WriteInput's only display-relevant field; validated directly rather than
  // via `WriteInputSchema` (a runtime import from `@tools/WriteTool`, which a
  // browser frontend may not use — see the import-block comment above).
  const content: WriteInput['content'] | undefined =
    isObject(input) && typeof input.content === 'string'
      ? input.content
      : undefined;
  const contentLanguage = getLanguageFromPath(filePath);
  const sections = [
    buildToolUseSection('File:', buildFileLinkWithLines(filePath)),
  ];
  if (content !== undefined) {
    sections.push(
      buildToolSection('', content, {
        toolName,
        language: contentLanguage,
      }),
    );
  }
  return sections;
}

/**
 * `MemoryToolInput` is a `z.discriminatedUnion` on the host-only
 * `MemoryToolInputSchema` (`@tools/memory/MemoryTool`), which this browser
 * frontend cannot import as a runtime value (see the import-block comment
 * above). Rather than re-implement the full 8-branch union as a parallel
 * schema, each field this section actually displays is read directly with
 * its own `typeof` guard.
 */
function buildMemorySections(ctx: ToolSectionContext): TemplateResult[] {
  const { input } = ctx;
  if (!isObject(input) || typeof input.command !== 'string') return [];
  const command = input.command;
  const path = asString(input.path);
  const memPath = command === 'rename' ? '' : (path ?? '');
  const sections: TemplateResult[] = [];

  if (memPath) {
    sections.push(
      buildToolUseSection('File:', buildMemoryPathDisplay(memPath)),
    );
  }

  const oldStr = asString(input.old_str);
  const newStr = asString(input.new_str);
  const fileText = asString(input.file_text);
  const insertText = asString(input.insert_text);
  const insertLine =
    typeof input.insert_line === 'number' ? input.insert_line : undefined;
  const oldPath = asString(input.old_path);
  const newPath = asString(input.new_path);

  if (command === 'str_replace' && oldStr != null && newStr != null) {
    sections.push(
      buildToolUseSection('', buildEditDiffSection(oldStr, newStr)),
    );
  } else if (command === 'create' && fileText != null) {
    const contentLanguage = memPath
      ? getLanguageFromPath(memPath)
      : 'plaintext';
    sections.push(
      buildToolSection('', fileText, {
        language: contentLanguage,
      }),
    );
  } else if (command === 'insert') {
    const text = insertText ?? newStr;
    if (text != null) {
      const lineLabel =
        insertLine != null ? `Insert at line ${insertLine}:` : 'Insert:';
      const contentLanguage = memPath
        ? getLanguageFromPath(memPath)
        : 'plaintext';
      sections.push(
        buildToolSection(lineLabel, text, {
          language: contentLanguage,
        }),
      );
    }
  } else if (command === 'rename') {
    if (oldPath != null && newPath != null) {
      sections.push(
        buildToolUseSection('Rename:', wrapInPre(`${oldPath} → ${newPath}`)),
      );
    }
  }
  return sections;
}

/**
 * `ExecutionsToolInput` derives from the host-only `ExecutionsToolInputSchema`
 * (`@tools/ExecutionsTool`), unavailable as a runtime import here (see the
 * import-block comment above); fields are read with individual guards
 * instead.
 */
function buildExecutionsSections(ctx: ToolSectionContext): TemplateResult[] {
  const { input } = ctx;
  if (!isObject(input)) return [];
  const execPath = asString(input.path) ?? '';
  const action = asString(input.action) ?? EXECUTIONS_DEFAULT_ACTION;
  const sections: TemplateResult[] = [];

  if (execPath) {
    sections.push(
      buildToolUseSection('Path:', buildExecutionsPathDisplay(execPath)),
    );
  }

  if (action === 'wait') {
    const timeout = getExecutionsWaitTimeoutSeconds(input.timeout);
    sections.push(
      buildToolUseSection('Action:', wrapInPre(`wait (timeout: ${timeout}s)`)),
    );
  } else if (action === 'kill') {
    sections.push(buildToolUseSection('Action:', wrapInPre('kill')));
  }

  const viewRange = input.view_range;
  if (
    Array.isArray(viewRange) &&
    typeof viewRange[0] === 'number' &&
    typeof viewRange[1] === 'number'
  ) {
    const [start, end] = viewRange;
    sections.push(
      buildToolUseSection('Range:', wrapInPre(`lines ${start}–${end}`)),
    );
  }

  if (typeof input.offset === 'number') {
    sections.push(
      buildToolUseSection('Offset:', wrapInPre(String(input.offset))),
    );
  }
  if (typeof input.limit === 'number') {
    sections.push(
      buildToolUseSection('Limit:', wrapInPre(String(input.limit))),
    );
  }
  return sections;
}

/** One `AcceptRunFilesInput.files` entry, narrowed for display purposes only. */
function acceptRunFileEntryOf(raw: unknown): {
  path: string;
  original?: string;
} {
  if (!isObject(raw)) return { path: '' };
  return { path: asString(raw.path) ?? '', original: asString(raw.original) };
}

/**
 * `AcceptRunFilesInput` derives from the host-only
 * `AcceptRunFilesInputSchema` (`@tools/AcceptRunFilesTool`), unavailable as a
 * runtime import here (see the import-block comment above); fields are read
 * with individual guards instead.
 */
function buildAcceptRunFilesSections(
  ctx: ToolSectionContext,
): TemplateResult[] {
  const { input, parsedOutput } = ctx;
  if (!isObject(input)) return [];
  const sections: TemplateResult[] = [];

  const executionId = asString(input.execution_id);
  if (executionId) {
    // prettier-ignore
    sections.push(buildToolUseSection('Execution:', html`<code class="execution-id">${executionId}</code>`));
  }

  const files = Array.isArray(input.files) ? input.files : undefined;
  if (files && files.length > 0) {
    const edits = getOutputEdits<{
      path?: string;
      lineChanges?: { added: number; removed: number };
    }>(parsedOutput);
    const editsByPath = new Map(
      (edits ?? []).filter((e) => e.path).map((e) => [e.path!, e] as const),
    );

    // prettier-ignore
    const fileItems = html`${files.map((raw) => {
      const f = acceptRunFileEntryOf(raw);
      const dest = f.original ?? f.path;
      const source = f.path;
      const isMapped = dest && source && dest !== source;
      const edit = editsByPath.get(dest);
      const diffStats = edit?.lineChanges
        ? html` <span class="file-stats"><span class="added">+${edit.lineChanges.added}</span><span class="removed">-${edit.lineChanges.removed}</span></span>`
        : nothing;
      // prettier-ignore
      return html`<li class="detail-item">${waIcon('file')} ${buildFileLinkSpan(dest, dest)}${isMapped ? html` <span class="file-source">(from ${source})</span>` : nothing}${diffStats}</li>`;
    })}`;
    // prettier-ignore
    sections.push(buildToolUseSection('Files:', html`<ul class="detail-list">${fileItems}</ul>`));
  }
  return sections;
}

/** Filters an unknown value down to a `string[]`, dropping non-string entries. */
function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * `DelegateAgentInput`/`WorkflowAgentInput` derive from host-only schemas
 * (`@tools/delegation/DelegationTools`, `@tools/delegation/inputFields`), unavailable as
 * runtime imports here (see the import-block comment above). Each displayed
 * field is read with its own guard.
 */
function buildDelegationSections(ctx: ToolSectionContext): TemplateResult[] {
  const { input } = ctx;
  if (!isObject(input)) return [];
  const sections: TemplateResult[] = [];

  const execId = asString(input.execution_id);
  if (execId) {
    // prettier-ignore
    sections.push(buildToolUseSection('Resume:', html`<code class="execution-id">${execId}</code>`));
  }

  const agent = asString(input.agent);
  const model = asString(input.model);
  if (agent || model) {
    const agentPart = agent ?? 'unknown';
    const modelPart = model
      ? html` <span class="file-source">(${model})</span>`
      : nothing;
    // prettier-ignore
    sections.push(buildToolUseSection('Agent:', html`<code class="execution-id">${agentPart}</code>${modelPart}`));
  }

  const instruction = asString(input.instruction);
  if (instruction) {
    sections.push(buildToolUseSection('Instruction:', wrapInPre(instruction)));
  }

  const extractFlags: string[] = [];
  if (input.extractFigures) extractFlags.push('Extract figures');
  if (input.extractTikz) extractFlags.push('Extract TikZ');
  if (extractFlags.length > 0) {
    // prettier-ignore
    sections.push(buildToolUseSection('Extraction:', html`${extractFlags.map((f) => buildStatusBadge('image', f))}`));
  }

  const fileGroups = getProposalFileGroups({
    inputFiles: toStringArray(input.inputFiles),
    contextFiles: toStringArray(input.contextFiles),
    mediaFiles: toStringArray(input.mediaFiles),
    outputFiles: toStringArray(input.outputFiles),
    memories: toStringArray(input.memories),
  });
  const filesSection = buildFileGroupsSection(fileGroups);
  if (filesSection !== undefined) sections.push(filesSection);
  return sections;
}

function buildWorkflowScriptSections(
  ctx: ToolSectionContext,
): TemplateResult[] {
  const { input } = ctx;
  if (!isObject(input)) {
    return [
      buildToolUseSection(
        'Input:',
        wrapInPre('Workflow script input is unavailable.'),
      ),
    ];
  }

  const sections: TemplateResult[] = [];
  const agent = asString(input.agent);
  if (agent !== undefined) {
    // prettier-ignore
    sections.push(buildToolUseSection('Agent:', html`<code class="execution-id">${agent}</code>`));
  }

  const script = asString(input.script);
  if (script !== undefined) {
    sections.push(
      buildToolSection('Script:', script, {
        language: 'javascript',
        extraClass: 'tool-command-input',
      }),
    );
  }

  if (Object.hasOwn(input, 'args')) {
    const args = input.args === undefined ? null : input.args;
    sections.push(
      buildToolSection('Args:', JSON.stringify(args, null, 2), {
        language: 'json',
      }),
    );
  }

  const files = WorkflowScriptFilesSchema.safeParse(input.files);
  const filesSection = files.success
    ? buildFileGroupsSection(getProposalFileGroups(files.data))
    : undefined;
  if (filesSection !== undefined) sections.push(filesSection);

  return sections;
}

function buildSpecializedSections(ctx: ToolSectionContext): TemplateResult[] {
  const { toolName, input } = ctx;
  const content =
    codexToolRenderers[toolName as keyof typeof codexToolRenderers](input);
  if (content != null && content !== nothing) {
    return [content];
  }
  return [];
}

function buildMcpSections(ctx: ToolSectionContext): TemplateResult[] {
  const { toolName, input, parsedOutput, outputText } = ctx;
  const sections: TemplateResult[] = [];
  let renderedMcpOutput = false;

  if (input != null) {
    const { text: inputValue, language: inputLanguage } =
      stringifyWithLanguage(input);
    if (inputValue) {
      sections.push(
        buildToolSection('Arguments:', inputValue, {
          toolName,
          language: inputLanguage,
        }),
      );
    }
  }

  const mcpOutput: CodexMcpToolOutput | null =
    CodexMcpToolOutputSchema.nullable().catch(null).parse(parsedOutput);
  const contentBlocks = Array.isArray(mcpOutput?.contentBlocks)
    ? mcpOutput.contentBlocks
    : [];
  const textBlocks = contentBlocks
    .filter(isMcpTextBlock)
    .map((block) => block.text);
  const otherBlocks = contentBlocks.filter((block) => !isMcpTextBlock(block));

  if (typeof mcpOutput?.status === 'string') {
    let statusIconName: TeXRAIconName | typeof SPINNER_ICON_NAME;
    if (mcpOutput.status === 'failed') {
      statusIconName = 'circle-exclamation';
    } else if (mcpOutput.status === 'in_progress') {
      statusIconName = SPINNER_ICON_NAME;
    } else {
      statusIconName = 'check';
    }
    sections.push(
      buildToolUseSection(
        'Status:',
        buildStatusBadge(statusIconName, mcpOutput.status),
      ),
    );
    renderedMcpOutput = true;
  }

  if (textBlocks.length > 0) {
    sections.push(buildToolSection('Response:', textBlocks.join('\n\n')));
    renderedMcpOutput = true;
  }

  if (mcpOutput && 'structuredContent' in mcpOutput) {
    const { text: structuredText, language: structuredLanguage } =
      stringifyWithLanguage(mcpOutput.structuredContent);
    if (structuredText) {
      sections.push(
        buildToolSection('Structured:', structuredText, {
          toolName,
          language: structuredLanguage,
        }),
      );
      renderedMcpOutput = true;
    }
  }

  if (otherBlocks.length > 0) {
    const { text: contentText, language: contentLanguage } =
      stringifyWithLanguage(otherBlocks);
    if (contentText) {
      sections.push(
        buildToolSection('Content:', contentText, {
          toolName,
          language: contentLanguage,
        }),
      );
      renderedMcpOutput = true;
    }
  }

  if (!renderedMcpOutput && outputText) {
    sections.push(
      buildToolSection('Result:', outputText, {
        toolName,
        extraClass: 'tool-output-full',
      }),
    );
  }
  return sections;
}

function buildDefaultSections(ctx: ToolSectionContext): TemplateResult[] {
  const { toolName, input } = ctx;
  if (input == null) return [];
  const codeLanguage = TOOL_CODE_LANGUAGES.get(toolName);

  // Code-only input (wolfram `code` / bash `command`) renders with syntax
  // highlighting instead of falling back to YAML serialization.
  if (codeLanguage && isObject(input)) {
    const codeValue = input.code ?? input.command;
    if (typeof codeValue === 'string') {
      return [
        buildToolSection('', codeValue, {
          toolName,
          language: codeLanguage,
          extraClass: 'tool-command-input',
        }),
      ];
    }
  }
  const { text: inputValue, language: inputLanguage } =
    stringifyWithLanguage(input);
  if (inputValue) {
    return [
      buildToolSection('', inputValue, {
        toolName,
        language: inputLanguage,
      }),
    ];
  }
  return [];
}

const TOOL_SECTION_BUILDERS: Array<{
  match: (ctx: ToolSectionContext) => boolean;
  build: (ctx: ToolSectionContext) => TemplateResult[];
}> = [
  {
    match: (ctx) =>
      toolDisplayKind(ctx.toolName) === 'edit' && isObject(ctx.input),
    build: buildEditDiffInputSections,
  },
  {
    match: (ctx) =>
      toolDisplayKind(ctx.toolName) === 'read' && Boolean(ctx.filePath),
    build: buildFileLinkSections,
  },
  {
    match: (ctx) =>
      toolDisplayKind(ctx.toolName) === 'write' && Boolean(ctx.filePath),
    build: buildFileContentSections,
  },
  {
    match: (ctx) => ctx.toolName === 'memory' && isObject(ctx.input),
    build: buildMemorySections,
  },
  {
    match: (ctx) => ctx.toolName === 'executions' && isObject(ctx.input),
    build: buildExecutionsSections,
  },
  {
    match: (ctx) => ctx.toolName === 'accept_run_files' && isObject(ctx.input),
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
  {
    match: (ctx) => Object.hasOwn(codexToolRenderers, ctx.toolName),
    build: buildSpecializedSections,
  },
  { match: (ctx) => isMcpToolName(ctx.toolName), build: buildMcpSections },
];

export function dispatchToolSections(
  ctx: ToolSectionContext,
): TemplateResult[] {
  for (const { match, build } of TOOL_SECTION_BUILDERS) {
    if (match(ctx)) return build(ctx);
  }
  return buildDefaultSections(ctx);
}
