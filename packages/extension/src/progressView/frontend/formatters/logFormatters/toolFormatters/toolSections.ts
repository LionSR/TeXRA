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
import {
  stringifyWithLanguage,
  extractCodeOnlyInput,
} from '@progressView/frontend/formatters/parseUtils';
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
  DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
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
import type { ExecutionsToolInput } from '@tools/ExecutionsTool';
import type { ReadInput } from '@tools/ReadTool';
import type { WriteInput } from '@tools/WriteTool';
import type {
  DelegateAgentInput,
  WorkflowAgentInput,
} from '@tools/DelegationTools';
import type { AcceptRunFilesInput } from '@tools/AcceptRunFilesTool';
import type { MemoryToolInput } from '@tools/memory/MemoryTool';
import { isObject } from '@utils/core';

import { codexToolRenderers } from '../codexToolTemplates';
import {
  buildToolSection,
  getOutputEdits,
  getExecutionsWaitTimeoutSeconds,
  isMcpTextBlock,
} from './helpers';

export type ToolSectionContext = {
  toolName: string;
  input: unknown;
  filePath: string;
  parsedOutput: unknown;
  outputText: string;
};

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

/** Common shape of the edit_file and str_replace_editor tool inputs, for display purposes only. */
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

function buildFileLinkSections(ctx: ToolSectionContext): TemplateResult[] {
  const { input, filePath } = ctx;
  if (!filePath) return [];
  const readInput = isObject(input) ? (input as ReadInput) : undefined;
  return [
    buildToolUseSection(
      'File:',
      buildFileLinkWithLines(filePath, {
        startLine: readInput?.range?.start,
        endLine: readInput?.range?.end ?? undefined,
      }),
    ),
  ];
}

function buildFileContentSections(ctx: ToolSectionContext): TemplateResult[] {
  const { toolName, input, filePath } = ctx;
  if (!filePath) return [];
  const writeInput = isObject(input) ? (input as WriteInput) : undefined;
  const contentLanguage = getLanguageFromPath(filePath);
  const sections = [
    buildToolUseSection('File:', buildFileLinkWithLines(filePath)),
  ];
  if (typeof writeInput?.content === 'string') {
    sections.push(
      buildToolSection('', writeInput.content, {
        toolName,
        language: contentLanguage,
      }),
    );
  }
  return sections;
}

function buildMemorySections(ctx: ToolSectionContext): TemplateResult[] {
  const { input } = ctx;
  if (!isObject(input)) return [];
  const memInput = input as MemoryToolInput;
  const memPath = memInput.command === 'rename' ? '' : (memInput.path ?? '');
  const sections: TemplateResult[] = [];

  if (memPath) {
    sections.push(
      buildToolUseSection('File:', buildMemoryPathDisplay(memPath)),
    );
  }

  if (
    memInput.command === 'str_replace' &&
    memInput.old_str != null &&
    memInput.new_str != null
  ) {
    sections.push(
      buildToolUseSection(
        '',
        buildEditDiffSection(memInput.old_str, memInput.new_str),
      ),
    );
  } else if (memInput.command === 'create' && memInput.file_text != null) {
    const contentLanguage = memPath
      ? getLanguageFromPath(memPath)
      : 'plaintext';
    sections.push(
      buildToolSection('', memInput.file_text, {
        language: contentLanguage,
      }),
    );
  } else if (memInput.command === 'insert') {
    const insertText = memInput.insert_text ?? memInput.new_str;
    if (insertText != null) {
      const lineLabel =
        memInput.insert_line != null
          ? `Insert at line ${memInput.insert_line}:`
          : 'Insert:';
      const contentLanguage = memPath
        ? getLanguageFromPath(memPath)
        : 'plaintext';
      sections.push(
        buildToolSection(lineLabel, insertText, {
          language: contentLanguage,
        }),
      );
    }
  } else if (memInput.command === 'rename') {
    const oldPath = memInput.old_path;
    const newPath = memInput.new_path;
    if (oldPath != null && newPath != null) {
      sections.push(
        buildToolUseSection('Rename:', wrapInPre(`${oldPath} → ${newPath}`)),
      );
    }
  }
  return sections;
}

function buildExecutionsSections(ctx: ToolSectionContext): TemplateResult[] {
  const { input } = ctx;
  if (!isObject(input)) return [];
  const execInput = input as ExecutionsToolInput;
  const execPath = execInput.path ?? '';
  const action = execInput.action ?? EXECUTIONS_DEFAULT_ACTION;
  const sections: TemplateResult[] = [];

  if (execPath) {
    sections.push(
      buildToolUseSection('Path:', buildExecutionsPathDisplay(execPath)),
    );
  }

  if (action === 'wait') {
    const timeout = getExecutionsWaitTimeoutSeconds(execInput.timeout);
    sections.push(
      buildToolUseSection('Action:', wrapInPre(`wait (timeout: ${timeout}s)`)),
    );
  } else if (action === 'kill') {
    sections.push(buildToolUseSection('Action:', wrapInPre('kill')));
  }

  if (execInput.view_range) {
    const [start, end] = execInput.view_range;
    sections.push(
      buildToolUseSection('Range:', wrapInPre(`lines ${start}–${end}`)),
    );
  }
  return sections;
}

function buildAcceptRunFilesSections(
  ctx: ToolSectionContext,
): TemplateResult[] {
  const { input, parsedOutput } = ctx;
  if (!isObject(input)) return [];
  const acceptInput = input as AcceptRunFilesInput;
  const sections: TemplateResult[] = [];

  if (acceptInput.execution_id) {
    // prettier-ignore
    sections.push(buildToolUseSection('Execution:', html`<code class="execution-id">${acceptInput.execution_id}</code>`));
  }

  const files = acceptInput.files;
  if (Array.isArray(files) && files.length > 0) {
    const edits = getOutputEdits<{
      path?: string;
      lineChanges?: { added: number; removed: number };
    }>(parsedOutput);
    const editsByPath = new Map(
      (edits ?? []).filter((e) => e.path).map((e) => [e.path!, e] as const),
    );

    // prettier-ignore
    const fileItems = html`${files.map((f) => {
      const dest = f.original ?? f.path ?? '';
      const source = f.path ?? '';
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

function buildDelegationSections(ctx: ToolSectionContext): TemplateResult[] {
  const { input } = ctx;
  if (!isObject(input)) return [];
  const delegateInput = input as DelegateAgentInput | WorkflowAgentInput;
  const sections: TemplateResult[] = [];

  const execId =
    'execution_id' in delegateInput
      ? (delegateInput as DelegateAgentInput).execution_id
      : undefined;
  if (execId) {
    // prettier-ignore
    sections.push(buildToolUseSection('Resume:', html`<code class="execution-id">${execId}</code>`));
  }

  const agent = delegateInput.agent;
  const model = delegateInput.model;
  if (agent || model) {
    const agentPart = agent ?? 'unknown';
    const modelPart = model
      ? html` <span class="file-source">(${model})</span>`
      : nothing;
    // prettier-ignore
    sections.push(buildToolUseSection('Agent:', html`<code class="execution-id">${agentPart}</code>${modelPart}`));
  }

  const instruction = delegateInput.instruction;
  if (instruction) {
    sections.push(buildToolUseSection('Instruction:', wrapInPre(instruction)));
  }

  const extractFlags: string[] = [];
  if ('extractFigures' in delegateInput && delegateInput.extractFigures)
    extractFlags.push('Extract Figures');
  if ('extractTikz' in delegateInput && delegateInput.extractTikz)
    extractFlags.push('Extract TikZ');
  if (extractFlags.length > 0) {
    // prettier-ignore
    sections.push(buildToolUseSection('Extraction:', html`${extractFlags.map((f) => buildStatusBadge('image', f))}`));
  }

  const fileGroups = getProposalFileGroups(delegateInput);
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
  if (typeof input.agent === 'string') {
    // prettier-ignore
    sections.push(buildToolUseSection('Agent:', html`<code class="execution-id">${input.agent}</code>`));
  }

  if (typeof input.script === 'string') {
    sections.push(
      buildToolSection('Script:', input.script, {
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
  const { isCodeOnly, code } = codeLanguage
    ? extractCodeOnlyInput(input)
    : { isCodeOnly: false, code: '' };

  if (isCodeOnly) {
    return [
      buildToolSection('', code, {
        toolName,
        language: codeLanguage,
        extraClass: 'tool-command-input',
      }),
    ];
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
    match: (ctx) => ctx.toolName === DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
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
