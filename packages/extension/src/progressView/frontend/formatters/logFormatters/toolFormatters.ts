/**
 * Tool-style formatters for tool use and web search messages.
 * Uses Lit templates for declarative DOM construction.
 *
 * IMPORTANT: Lit templates preserve whitespace literally. Multi-line templates with
 * indentation will render with unwanted spaces in the output. Always use single-line
 * templates with `// prettier-ignore` to prevent whitespace issues.
 */

// Local imports - shared utilities
import type {
  WebSearchPayload,
  WebFetchPayload,
  LogMessageData,
} from '@shared/schemas';
import { isPlainObject } from '@shared/utils/string';
import { getProposalFileGroups } from '@shared/schemas/proposalFields';
import { DELEGATION_TOOLS } from '@shared/constants/delegationTools';
import type { ExecutionsToolInput } from '@tools/ExecutionsTool';
import type { EditInput } from '@tools/EditTool';
import type { TextEditorInput } from '@tools/TextEditorTool';
import type { ReadInput } from '@tools/ReadTool';
import type { WriteInput } from '@tools/WriteTool';
import type {
  DelegateAgentInput,
  WorkflowAgentInput,
} from '@tools/DelegationTools';
import type { AcceptRunFilesInput } from '@tools/AcceptRunFilesTool';
import {
  CodexMcpToolOutputSchema,
  type CodexMcpToolOutput,
} from '@tools/codexShared';
import type { MemoryToolInput } from '@tools/memory/MemoryTool';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

// Local imports - Lit template utilities
import {
  html,
  nothing,
  classMap,
  ifDefined,
  type TemplateResult,
  type FormatResult,
} from '../litTemplates';

// Local imports - formatter helpers
import {
  buildToolUseSection,
  wrapInPre,
  getToolIconName,
  buildFileLinkWithLines,
  buildEditDiffSection,
  buildMemoryPathDisplay,
  buildExecutionsPathDisplay,
  buildCodeBlock,
  buildDetailsSummary,
  SPINNER_ICON_NAME,
} from '../htmlBuilders';
import { normalizeToolUseData } from '../logDataParsers';
import { registerProposalInput } from '../proposalInputStore';
import { stringifyWithLanguage, extractCodeOnlyInput } from '../parseUtils';
import {
  TOOLS_WITH_DIFF_INPUT,
  TOOLS_WITH_FILE_LINK,
  TOOLS_WITH_FILE_CONTENT,
  TOOL_OUTPUT_LANGUAGES,
  TOOL_CODE_LANGUAGES,
  TOOL_LABEL_MAP,
  TRIVIAL_WRITE_OUTPUT,
  getLanguageFromPath,
} from '../constants';
import { codexToolRenderers } from './codexToolTemplates';

// Side-effect import to register <tool-timer> custom element
import '@progressView/frontend/components/ToolTimer';
import '@progressView/frontend/components/TerminalOutput';

/** Known per-tool default timeouts (ms) for display in the running timer. */
const TOOL_DEFAULT_TIMEOUTS: Record<string, number> = {
  bash: 120_000, // matches BASH_TIMEOUT_MS in src/tools/bash.ts
  executions: 300_000, // matches code default in ExecutionsTool.ts
  codex: 300_000, // generous default — Codex turns can be slow
};

/**
 * Tools whose `timeout` input field is in seconds (converted to ms for display).
 * Most tools use milliseconds directly.
 */
const TIMEOUT_IN_SECONDS = new Set(['executions']);

/**
 * Tools where the timeout only applies to a specific action value.
 * For these tools, only show the timer limit when that action is used.
 */
const TIMEOUT_GATED_BY_ACTION: Record<string, string> = {
  executions: 'wait',
};

/** Default action for the executions tool when the model omits it. */
const EXECUTIONS_DEFAULT_ACTION = 'view';

/**
 * Extract the effective timeout for a tool call from its input.
 * Returns undefined for tools without a configurable timeout.
 */
function getToolTimeoutMs(
  toolName: string,
  input: unknown,
): number | undefined {
  const defaultTimeout = TOOL_DEFAULT_TIMEOUTS[toolName];
  if (defaultTimeout === undefined) return undefined;
  if (!isPlainObject(input)) return defaultTimeout;

  // Some tools only have a meaningful timeout for a specific action
  const requiredAction = TIMEOUT_GATED_BY_ACTION[toolName];
  if (requiredAction && input.action !== requiredAction) return undefined;

  // Background tools return immediately — timeout timer is misleading
  if (input.run_in_background === true) return undefined;

  if (typeof input.timeout === 'number') {
    return TIMEOUT_IN_SECONDS.has(toolName)
      ? input.timeout * 1000
      : input.timeout;
  }
  return defaultTimeout;
}

/** Truncate a prompt string for display in collapsed headers. */
function truncatePrompt(text: string, maxLength: number): string {
  const oneLine = text.replaceAll(/\s+/g, ' ').trim();
  return truncateWithEllipsis(oneLine, maxLength);
}

/** Truncate tool header text without pulling streamed stdout/stderr into it. */
function truncateHeaderSummary(text: string, maxLength: number): string {
  const oneLine = text.replaceAll(/\s+/g, ' ').trim();
  const outputMarker = oneLine.search(/\s+<(?:stdout|stderr)>/i);
  const summary =
    outputMarker >= 0 ? oneLine.slice(0, outputMarker).trim() : oneLine;
  return truncateWithEllipsis(summary || oneLine, maxLength);
}

/** Join template sections with horizontal rule separators. */
function joinWithSeparator(sections: TemplateResult[]): TemplateResult {
  return html`${sections.map(
    (section, i) =>
      html`${section}${i < sections.length - 1
        ? html`<hr class="tool-use-separator" />`
        : ''}`,
  )}`;
}

type SpecializedToolRenderer = (
  input: unknown,
) => TemplateResult | typeof nothing | null | undefined;

const SPECIALIZED_TOOL_SECTION_RENDERERS = {
  ...codexToolRenderers,
} satisfies Record<string, SpecializedToolRenderer>;

// Web search provider display names
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

// Web search status suffixes for title
const STATUS_SUFFIXES: Record<string, string> = {
  in_progress: ' (searching...)',
  failed: ' (failed)',
};

// Web search status-based wa-icon names; SPINNER_ICON_NAME triggers a spinner.
const STATUS_ICONS: Record<string, string> = {
  failed: 'error',
  in_progress: SPINNER_ICON_NAME,
};

/** Build the banner content wrapper shared by tool-use and web-search entries. */
function buildBannerContent(
  message: Pick<LogMessageData, 'id' | 'groupId' | 'timestamp'>,
  contentTemplate: TemplateResult,
): TemplateResult {
  const fullTimestamp = new Date(message.timestamp).toISOString();
  // prettier-ignore
  return html`<div class="banner-content log-entry-content" data-log-id=${ifDefined(message.id)} data-group-id=${ifDefined(message.groupId)} data-timestamp=${ifDefined(fullTimestamp)}>${contentTemplate}</div>`;
}

/** Extract typed edits array from parsed tool output, if present. */
function getOutputEdits<T>(output: unknown): T[] | undefined {
  return isPlainObject(output) ? (output.edits as T[] | undefined) : undefined;
}

type ToolSectionOptions = {
  toolName?: string;
  language?: string;
  extraClass?: string;
};

/**
 * Build a tool section with appropriate code highlighting based on tool type.
 */
function buildToolSection(
  label: string,
  text: string,
  options: ToolSectionOptions = {},
): TemplateResult {
  const { toolName = '', language: contentLanguage, extraClass = '' } = options;

  // Determine language: tool config > content metadata > plaintext
  const toolLanguage = TOOL_OUTPUT_LANGUAGES.get(toolName);
  const language = toolLanguage || contentLanguage || 'plaintext';
  const shouldHighlight = language && language !== 'plaintext';

  const content = shouldHighlight
    ? buildCodeBlock(text, {
        language,
        className: extraClass,
        showLanguage: true,
        showCopy: true,
      })
    : wrapInPre(text, extraClass);

  return buildToolUseSection(label, content);
}

/** Build a read-only terminal section for shell output. */
function buildTerminalSection(label: string, text: string): TemplateResult {
  return buildToolUseSection(
    label,
    html`<terminal-output
      class="tool-output-terminal"
      .text=${text}
    ></terminal-output>`,
  );
}

function isMcpTextBlock(
  block: unknown,
): block is { type: 'text'; text: string } {
  return (
    isPlainObject(block) &&
    block.type === 'text' &&
    typeof block.text === 'string'
  );
}

type ToolSectionContext = {
  toolName: string;
  input: unknown;
  filePath: string;
  parsedOutput: unknown;
  outputText: string;
  isInProgress: boolean;
};

function buildEditDiffInputSections(ctx: ToolSectionContext): TemplateResult[] {
  const { input, filePath, parsedOutput } = ctx;
  if (!isPlainObject(input)) return [];
  const editInput = input as EditInput | TextEditorInput;
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
  const readInput = input as ReadInput;
  return [
    buildToolUseSection(
      'File:',
      buildFileLinkWithLines(filePath, {
        startLine: readInput.range?.start,
        endLine: readInput.range?.end ?? undefined,
      }),
    ),
  ];
}

function buildFileContentSections(ctx: ToolSectionContext): TemplateResult[] {
  const { toolName, input, filePath } = ctx;
  if (!filePath) return [];
  const writeInput = input as WriteInput;
  const contentLanguage = getLanguageFromPath(filePath);
  return [
    buildToolUseSection('File:', buildFileLinkWithLines(filePath)),
    buildToolSection('', writeInput.content, {
      toolName,
      language: contentLanguage,
    }),
  ];
}

function buildMemorySections(ctx: ToolSectionContext): TemplateResult[] {
  const { input } = ctx;
  if (!isPlainObject(input)) return [];
  const memInput = input as MemoryToolInput;
  const command = memInput.command;
  const memPath = memInput.path ?? '';
  const sections: TemplateResult[] = [];

  if (memPath) {
    sections.push(
      buildToolUseSection('File:', buildMemoryPathDisplay(memPath)),
    );
  }

  if (
    command === 'str_replace' &&
    memInput.old_str != null &&
    memInput.new_str != null
  ) {
    sections.push(
      buildToolUseSection(
        '',
        buildEditDiffSection(memInput.old_str, memInput.new_str),
      ),
    );
  } else if (command === 'create' && memInput.file_text != null) {
    const contentLanguage = memPath
      ? getLanguageFromPath(memPath)
      : 'plaintext';
    sections.push(
      buildToolSection('', memInput.file_text, {
        language: contentLanguage,
      }),
    );
  } else if (command === 'insert') {
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
  } else if (command === 'rename') {
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
  if (!isPlainObject(input)) return [];
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
    const timeout = execInput.timeout ?? 300;
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
  if (!isPlainObject(input)) return [];
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
        ? html` <span class="file-stats"><span class="added">+${edit.lineChanges.added}</span><span class="removed" style="margin-left:var(--wa-space-2xs)">-${edit.lineChanges.removed}</span></span>`
        : nothing;
      // prettier-ignore
      return html`<li class="detail-item"><wa-icon library="texra" name="file" aria-hidden="true"></wa-icon> <span class="file-link clickable-link" data-file=${dest}>${dest}</span>${isMapped ? html` <span class="file-source">(from ${source})</span>` : nothing}${diffStats}</li>`;
    })}`;
    // prettier-ignore
    sections.push(buildToolUseSection('Files:', html`<ul class="detail-list">${fileItems}</ul>`));
  }
  return sections;
}

function buildDelegationSections(ctx: ToolSectionContext): TemplateResult[] {
  const { input } = ctx;
  if (!isPlainObject(input)) return [];
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
    sections.push(buildToolUseSection('Extraction:', html`${extractFlags.map((f) => html`<span class="extract-flag"><wa-icon library="texra" name="file-media" aria-hidden="true"></wa-icon> ${f}</span>`)}`));
  }

  const fileGroups = getProposalFileGroups(delegateInput);
  if (fileGroups.length > 0) {
    // prettier-ignore
    const fileItems = html`${fileGroups.flatMap((g) => g.files.map((f) => html`<li class="detail-item"><wa-icon library="texra" name="file" aria-hidden="true"></wa-icon> <span class="${g.clickable ? 'file-link clickable-link' : 'file-label'}" data-file=${ifDefined(g.clickable ? f : undefined)}>${f}</span> <span class="file-source">(${g.label})</span></li>`))}`;
    // prettier-ignore
    sections.push(buildToolUseSection('Files:', html`<ul class="detail-list">${fileItems}</ul>`));
  }
  return sections;
}

function buildSpecializedSections(ctx: ToolSectionContext): TemplateResult[] {
  const { toolName, input } = ctx;
  const content =
    SPECIALIZED_TOOL_SECTION_RENDERERS[
      toolName as keyof typeof SPECIALIZED_TOOL_SECTION_RENDERERS
    ](input);
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

  const mcpParsed = CodexMcpToolOutputSchema.safeParse(parsedOutput);
  const mcpOutput: CodexMcpToolOutput | null = mcpParsed.success
    ? mcpParsed.data
    : null;
  const contentBlocks = Array.isArray(mcpOutput?.contentBlocks)
    ? mcpOutput.contentBlocks
    : [];
  const textBlocks = contentBlocks
    .filter(isMcpTextBlock)
    .map((block) => block.text);
  const otherBlocks = contentBlocks.filter((block) => !isMcpTextBlock(block));

  if (typeof mcpOutput?.status === 'string') {
    let statusIconName: string;
    if (mcpOutput.status === 'failed') {
      statusIconName = 'error';
    } else if (mcpOutput.status === 'in_progress') {
      statusIconName = SPINNER_ICON_NAME;
    } else {
      statusIconName = 'check';
    }
    // prettier-ignore
    const statusIconTemplate = statusIconName === SPINNER_ICON_NAME
      ? html`<wa-spinner></wa-spinner>`
      : html`<wa-icon library="texra" name=${statusIconName} aria-hidden="true"></wa-icon>`;
    // prettier-ignore
    sections.push(buildToolUseSection('Status:', html`<span class="extract-flag">${statusIconTemplate} ${mcpOutput.status}</span>`));
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
      TOOLS_WITH_DIFF_INPUT.has(ctx.toolName) && isPlainObject(ctx.input),
    build: buildEditDiffInputSections,
  },
  {
    match: (ctx) =>
      TOOLS_WITH_FILE_LINK.has(ctx.toolName) && Boolean(ctx.filePath),
    build: buildFileLinkSections,
  },
  {
    match: (ctx) =>
      TOOLS_WITH_FILE_CONTENT.has(ctx.toolName) && Boolean(ctx.filePath),
    build: buildFileContentSections,
  },
  {
    match: (ctx) => ctx.toolName === 'memory' && isPlainObject(ctx.input),
    build: buildMemorySections,
  },
  {
    match: (ctx) => ctx.toolName === 'executions' && isPlainObject(ctx.input),
    build: buildExecutionsSections,
  },
  {
    match: (ctx) =>
      ctx.toolName === 'accept_run_files' && isPlainObject(ctx.input),
    build: buildAcceptRunFilesSections,
  },
  {
    match: (ctx) =>
      DELEGATION_TOOLS.has(ctx.toolName) && isPlainObject(ctx.input),
    build: buildDelegationSections,
  },
  {
    match: (ctx) =>
      Object.hasOwn(SPECIALIZED_TOOL_SECTION_RENDERERS, ctx.toolName),
    build: buildSpecializedSections,
  },
  { match: (ctx) => ctx.toolName.startsWith('mcp:'), build: buildMcpSections },
];

function dispatchToolSections(ctx: ToolSectionContext): TemplateResult[] {
  for (const { match, build } of TOOL_SECTION_BUILDERS) {
    if (match(ctx)) return build(ctx);
  }
  return buildDefaultSections(ctx);
}

/** Format tool use log entry as TemplateResult. */
export function formatToolUseTemplate(
  message: LogMessageData,
  options?: { defaultOpen?: boolean },
): FormatResult {
  const { timestamp, data } = message;
  const normalizedToolLog = normalizeToolUseData(data);
  if (!normalizedToolLog) return null;

  const {
    parsed,
    toolName,
    errorText,
    outputText,
    userInstructionText,
    input,
    isUserFeedback,
    status,
  } = normalizedToolLog;

  // Determine display state
  const isInProgress = status === 'in_progress';
  const showAsError = normalizedToolLog.isError && !isUserFeedback;
  let iconName: string;
  if (isUserFeedback) {
    iconName = 'comment';
  } else if (isInProgress) {
    iconName = SPINNER_ICON_NAME;
  } else {
    iconName = getToolIconName(toolName, showAsError);
  }

  const titleBase = toolName.startsWith('mcp:')
    ? `MCP ${toolName.slice(4)}`
    : (TOOL_LABEL_MAP[toolName] ?? toolName) || 'tool';

  // Surface action + path for executions tool so it's visible without expanding
  let headerSummary = normalizedToolLog.headerSummary || '';
  if (!headerSummary) {
    if (toolName === 'executions' && isPlainObject(input)) {
      headerSummary =
        `${input.action ?? EXECUTIONS_DEFAULT_ACTION} ${input.path ?? ''}`.trim();
    } else if (
      toolName === 'codex' &&
      isPlainObject(input) &&
      typeof input.prompt === 'string'
    ) {
      headerSummary = truncatePrompt(input.prompt, 60);
    } else if (
      toolName === 'bash' &&
      isPlainObject(input) &&
      typeof input.command === 'string'
    ) {
      headerSummary = truncatePrompt(input.command, 60);
    }
  }
  headerSummary = truncateHeaderSummary(headerSummary, 120);
  const titleText = headerSummary
    ? `${titleBase} — ${headerSummary}`
    : titleBase;

  const filePath =
    isPlainObject(input) && typeof input.path === 'string' ? input.path : '';

  const sections: TemplateResult[] = dispatchToolSections({
    toolName,
    input,
    filePath,
    parsedOutput: parsed.output,
    outputText,
    isInProgress,
  });

  // Show output if present
  const isWriteTool = TOOLS_WITH_FILE_CONTENT.has(toolName);
  const isTrivialWriteOutput =
    isWriteTool && outputText.trim() === TRIVIAL_WRITE_OUTPUT;
  if (
    outputText &&
    !toolName.startsWith('mcp:') &&
    !TOOLS_WITH_FILE_LINK.has(toolName) &&
    !isTrivialWriteOutput
  ) {
    sections.push(
      toolName === 'bash' || toolName === 'codex'
        ? buildTerminalSection('', outputText)
        : buildToolSection('', outputText, {
            toolName,
            extraClass: 'tool-output-full',
          }),
    );
  }

  // Show error if present
  if (errorText && !isUserFeedback) {
    sections.push(
      buildToolUseSection('Error:', wrapInPre(errorText, 'tool-error-content')),
    );
  }

  // Show user instruction if present
  if (isUserFeedback && userInstructionText) {
    sections.push(
      buildToolUseSection(
        'User Instruction:',
        wrapInPre(userInstructionText, 'tool-user-feedback'),
      ),
    );
  }

  // Fallback: show raw YAML
  const contentTemplate =
    sections.length === 0
      ? buildCodeBlock(stringifyWithLanguage(parsed).text ?? '', {
          language: 'yaml',
          showLanguage: true,
          showCopy: true,
        })
      : joinWithSeparator(sections);

  // Auto-open in-progress tools so users see the command immediately
  const shouldOpen = options?.defaultOpen ?? isInProgress;
  const bannerContentTemplate = buildBannerContent(message, contentTemplate);

  // Live timer for in-progress tools, with timeout limit when available
  const toolTimeoutMs = getToolTimeoutMs(toolName, input);
  // prettier-ignore
  const timerTemplate = isInProgress ? html`<tool-timer .startTime=${timestamp} .timeoutMs=${toolTimeoutMs ?? 0}></tool-timer>` : undefined;

  // Delegation banner extras: setup link (shown in summary row)
  const isDelegation = DELEGATION_TOOLS.has(toolName);
  const proposalId =
    isDelegation && !isInProgress
      ? registerProposalInput(input, toolName)
      : null;

  // prettier-ignore
  const extraContent = html`${timerTemplate ?? nothing}${proposalId ? html`<span class="proposal-restore-link proposal-banner-setup" data-proposal-id=${proposalId} title="Setup this proposal configuration"><wa-icon library="texra" name="reply" aria-hidden="true"></wa-icon> Setup</span>` : nothing}`;

  // prettier-ignore
  return html`<details class=${classMap({
    'banner-details': true,
    'tool-use-details': true,
    'tool-use-error': showAsError,
    'tool-use-user-feedback': isUserFeedback,
    'tool-use-in-progress': isInProgress,
  })} ?open=${shouldOpen}>${buildDetailsSummary({
    iconName,
    label: titleText,
    labelClass: 'tool-use-title',
    extraContent,
  })}${bannerContentTemplate}</details>`;
}

/** Format web search results as TemplateResult. */
export function formatWebSearchTemplate(
  message: LogMessageData,
  options?: { defaultOpen?: boolean },
): FormatResult {
  const { data } = message;
  if (!data || typeof data !== 'object') return null;

  const { query, results, provider, status } = data as WebSearchPayload;
  const resultCount = Array.isArray(results) ? results.length : 0;
  const providerKey = typeof provider === 'string' ? provider : 'web';
  const statusKey = typeof status === 'string' ? status : '';

  const providerLabel = PROVIDER_LABELS[providerKey] ?? 'Web';
  const statusSuffix = STATUS_SUFFIXES[statusKey] ?? '';
  const iconName = STATUS_ICONS[statusKey] ?? 'globe';

  let titleText = `${providerLabel} Search`;
  if (query) titleText += `: "${query}"`;
  titleText += statusSuffix;

  // Build content sections — query is already in the title, only show sources
  const sections: TemplateResult[] = [];

  if (resultCount > 0) {
    // prettier-ignore
    const resultItems = (results ?? []).map(
      (r) => html`<li class="detail-item"><wa-icon library="texra" name="link" aria-hidden="true"></wa-icon> <a href=${r.url ?? ''} class="web-search-link" target="_blank" rel="noopener noreferrer">${r.title ?? r.domain ?? r.url}</a>${r.domain ? html` <span class="file-source">(${r.domain})</span>` : ''}</li>`,
    );
    // prettier-ignore
    const resultsTemplate = html`<span class="file-list-summary">Results (${resultCount})</span><ul class="detail-list">${resultItems}</ul>`;
    sections.push(buildToolUseSection('Sources:', resultsTemplate));
  } else if (statusKey === 'completed') {
    sections.push(
      buildToolUseSection(
        'Sources:',
        html`<span class="file-list-summary">No results found</span>`,
      ),
    );
  }

  const contentTemplate =
    sections.length === 0
      ? html`<pre>Web search executed</pre>`
      : joinWithSeparator(sections);

  const shouldOpen = options?.defaultOpen ?? false;
  const bannerContentTemplate = buildBannerContent(message, contentTemplate);

  // prettier-ignore
  return html`<details class=${classMap({
    'banner-details': true,
    'tool-use-details': true,
    'tool-use-error': statusKey === 'failed',
  })} ?open=${shouldOpen}>${buildDetailsSummary({
    iconName,
    label: titleText,
    labelClass: 'tool-use-title',
  })}${bannerContentTemplate}</details>`;
}

// Web fetch error code display labels
const FETCH_ERROR_LABELS: Record<string, string> = {
  invalid_tool_input: 'Invalid URL format',
  url_too_long: 'URL exceeds maximum length',
  url_not_allowed: 'URL blocked by domain filter',
  url_not_accessible: 'Failed to access URL',
  unsupported_content_type: 'Unsupported content type',
  too_many_requests: 'Rate limit exceeded',
  max_uses_exceeded: 'Maximum fetch uses exceeded',
  unavailable: 'Service unavailable',
};

/** Format web fetch results as TemplateResult. */
export function formatWebFetchTemplate(
  message: LogMessageData,
  options?: { defaultOpen?: boolean },
): FormatResult {
  const { data } = message;
  if (!data || typeof data !== 'object') return null;

  const { url, title, status, errorCode } = data as WebFetchPayload;
  const statusKey = typeof status === 'string' ? status : '';
  const isFailed = statusKey === 'failed';

  const iconName = isFailed ? 'error' : 'cloud-download';

  let titleText = 'Web Fetch';
  if (url) {
    try {
      titleText += `: ${new URL(url).hostname}`;
    } catch {
      titleText += `: ${url}`;
    }
  }
  if (isFailed) titleText += ' (failed)';

  // Build content sections
  const sections: TemplateResult[] = [];

  if (url) {
    // prettier-ignore
    sections.push(buildToolUseSection('URL:', html`<a href=${url} class="web-search-link" target="_blank" rel="noopener noreferrer">${url}</a>`));
  }

  if (title) {
    sections.push(buildToolUseSection('Title:', wrapInPre(title)));
  }

  if (isFailed && errorCode) {
    const errorLabel = FETCH_ERROR_LABELS[errorCode] ?? errorCode;
    sections.push(buildToolUseSection('Error:', wrapInPre(errorLabel)));
  }

  const contentTemplate =
    sections.length === 0
      ? html`<pre>Web fetch executed</pre>`
      : joinWithSeparator(sections);

  const shouldOpen = options?.defaultOpen ?? false;
  const bannerContentTemplate = buildBannerContent(message, contentTemplate);

  // prettier-ignore
  return html`<details class=${classMap({
    'banner-details': true,
    'tool-use-details': true,
    'tool-use-error': isFailed,
  })} ?open=${shouldOpen}>${buildDetailsSummary({
    iconName,
    label: titleText,
    labelClass: 'tool-use-title',
  })}${bannerContentTemplate}</details>`;
}
