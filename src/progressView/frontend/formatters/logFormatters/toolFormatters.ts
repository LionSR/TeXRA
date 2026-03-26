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
import type { MemoryToolInput } from '@tools/memory/MemoryTool';
import type { CodexInput } from '@tools/codex';

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
  getToolIconClass,
  buildFileLinkWithLines,
  buildEditDiffSection,
  buildMemoryPathDisplay,
  buildExecutionsPathDisplay,
  buildCodeBlock,
  buildDetailsSummary,
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
  TRIVIAL_WRITE_OUTPUT,
  getLanguageFromPath,
} from '../constants';

// Side-effect import to register <tool-timer> custom element
import '../../components/ToolTimer';
import '../../components/TerminalOutput';

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

  // Some tools only have a meaningful timeout for a specific action
  const requiredAction = TIMEOUT_GATED_BY_ACTION[toolName];
  if (
    requiredAction &&
    isPlainObject(input) &&
    input.action !== requiredAction
  ) {
    return undefined;
  }

  // Background tools return immediately — timeout timer is misleading
  if (isPlainObject(input) && input.run_in_background === true) {
    return undefined;
  }

  if (isPlainObject(input) && typeof input.timeout === 'number') {
    return TIMEOUT_IN_SECONDS.has(toolName)
      ? input.timeout * 1000
      : input.timeout;
  }
  return defaultTimeout;
}

/** Truncate a prompt string for display in collapsed headers. */
function truncatePrompt(text: string, maxLength: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLength) return oneLine;
  return oneLine.slice(0, maxLength - 1) + '…';
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

// Web search status-based icon classes
const STATUS_ICONS: Record<string, string> = {
  failed: 'codicon codicon-error',
  in_progress: 'codicon codicon-sync spin',
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
  if (output && typeof output === 'object' && 'edits' in output) {
    return (output as { edits?: T[] }).edits;
  }
  return undefined;
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
  let iconClass: string;
  if (isUserFeedback) {
    iconClass = 'codicon-comment';
  } else if (isInProgress) {
    iconClass = 'codicon-sync spin';
  } else {
    iconClass = getToolIconClass(toolName, showAsError);
  }

  const titleBase = toolName || 'tool';

  // Surface action + path for executions tool so it's visible without expanding
  const headerSummary =
    normalizedToolLog.headerSummary ||
    (toolName === 'executions' && isPlainObject(input)
      ? `${input.action ?? EXECUTIONS_DEFAULT_ACTION} ${input.path ?? ''}`.trim()
      : toolName === 'codex' &&
          isPlainObject(input) &&
          typeof input.prompt === 'string'
        ? truncatePrompt(input.prompt, 60)
        : '');
  const titleText = headerSummary
    ? `${titleBase} — ${headerSummary}`
    : titleBase;

  // Build content sections
  const sections: TemplateResult[] = [];

  const filePath =
    isPlainObject(input) && 'path' in input
      ? String((input as { path?: string }).path ?? '')
      : '';

  // Handle edit tools with diff display
  if (TOOLS_WITH_DIFF_INPUT.has(toolName) && isPlainObject(input)) {
    const editInput = input as EditInput | TextEditorInput;
    if (
      typeof editInput.old_str === 'string' &&
      typeof editInput.new_str === 'string'
    ) {
      const edits = getOutputEdits<{ startLine?: number }>(parsed.output);
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
    }
  }
  // Handle read tools with file link
  else if (TOOLS_WITH_FILE_LINK.has(toolName) && filePath) {
    const readInput = input as ReadInput;
    sections.push(
      buildToolUseSection(
        'File:',
        buildFileLinkWithLines(filePath, {
          startLine: readInput.range?.start,
          endLine: readInput.range?.end ?? undefined,
        }),
      ),
    );
  }
  // Handle write tools with file link + content
  else if (TOOLS_WITH_FILE_CONTENT.has(toolName) && filePath) {
    const writeInput = input as WriteInput;
    sections.push(
      buildToolUseSection('File:', buildFileLinkWithLines(filePath)),
    );
    const contentLanguage = getLanguageFromPath(filePath);
    sections.push(
      buildToolSection('', writeInput.content, {
        toolName,
        language: contentLanguage,
      }),
    );
  }
  // Handle memory tool with specialized formatting based on command
  else if (toolName === 'memory' && isPlainObject(input)) {
    const memInput = input as MemoryToolInput;
    const command = memInput.command;
    const memPath = memInput.path ?? '';

    // Show memory file path for commands that operate on a single path
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
      // str_replace: show diff (like edit_file)
      sections.push(
        buildToolUseSection(
          '',
          buildEditDiffSection(memInput.old_str, memInput.new_str),
        ),
      );
    } else if (command === 'create' && memInput.file_text != null) {
      // create: show file content (like write_file)
      const contentLanguage = memPath
        ? getLanguageFromPath(memPath)
        : 'plaintext';
      sections.push(
        buildToolSection('', memInput.file_text, {
          language: contentLanguage,
        }),
      );
    } else if (command === 'insert') {
      // insert: show inserted text at line number (tool accepts insert_text or new_str)
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
      // rename: show old → new path (both required)
      const oldPath = memInput.old_path;
      const newPath = memInput.new_path;
      if (oldPath != null && newPath != null) {
        sections.push(
          buildToolUseSection('Rename:', wrapInPre(`${oldPath} → ${newPath}`)),
        );
      }
    }
    // view and delete: file path section above is sufficient
  }
  // Handle executions tool with specialized formatting based on action
  else if (toolName === 'executions' && isPlainObject(input)) {
    const execInput = input as ExecutionsToolInput;
    const execPath = execInput.path ?? '';
    const action = execInput.action ?? EXECUTIONS_DEFAULT_ACTION;

    // Show the virtual path being accessed
    if (execPath) {
      sections.push(
        buildToolUseSection('Path:', buildExecutionsPathDisplay(execPath)),
      );
    }

    if (action === 'wait') {
      // wait: show timeout info
      const timeout = execInput.timeout ?? 300;
      sections.push(
        buildToolUseSection(
          'Action:',
          wrapInPre(`wait (timeout: ${timeout}s)`),
        ),
      );
    } else if (action === 'kill') {
      // kill: show action
      sections.push(buildToolUseSection('Action:', wrapInPre('kill')));
    }
    // view: path section above is sufficient

    // Show view_range if specified
    if (execInput.view_range) {
      const [start, end] = execInput.view_range;
      sections.push(
        buildToolUseSection('Range:', wrapInPre(`lines ${start}–${end}`)),
      );
    }
  }
  // Handle accept_run_files with file list display
  else if (toolName === 'accept_run_files' && isPlainObject(input)) {
    const acceptInput = input as AcceptRunFilesInput;

    // Show execution ID
    if (acceptInput.execution_id) {
      // prettier-ignore
      sections.push(buildToolUseSection('Execution:', html`<code class="execution-id">${acceptInput.execution_id}</code>`));
    }

    // Show file mappings as a list with file links
    const files = acceptInput.files;
    if (Array.isArray(files) && files.length > 0) {
      const edits = getOutputEdits<{
        path?: string;
        lineChanges?: { added: number; removed: number };
      }>(parsed.output);
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
          ? html` <span class="file-stats"><span class="added">+${edit.lineChanges.added}</span><span class="removed" style="margin-left:var(--spacing-small)">-${edit.lineChanges.removed}</span></span>`
          : nothing;
        // prettier-ignore
        return html`<li class="detail-item"><i class="codicon codicon-file"></i> <span class="file-link clickable-link" data-file=${dest}>${dest}</span>${isMapped ? html` <span class="file-source">(from ${source})</span>` : nothing}${diffStats}</li>`;
      })}`;
      // prettier-ignore
      sections.push(buildToolUseSection('Files:', html`<ul class="detail-list">${fileItems}</ul>`));
    }
  }
  // Handle delegation tools with structured display
  else if (DELEGATION_TOOLS.has(toolName) && isPlainObject(input)) {
    const delegateInput = input as DelegateAgentInput | WorkflowAgentInput;

    // Resume mode: show execution ID
    const execId =
      'execution_id' in delegateInput
        ? (delegateInput as DelegateAgentInput).execution_id
        : undefined;
    if (execId) {
      // prettier-ignore
      sections.push(buildToolUseSection('Resume:', html`<code class="execution-id">${execId}</code>`));
    }

    // Agent and model on one line
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

    // Instruction as readable text
    const instruction = delegateInput.instruction;
    if (instruction) {
      sections.push(
        buildToolUseSection('Instruction:', wrapInPre(instruction)),
      );
    }

    // Extract figure flags (workflow delegation only)
    const extractFlags: string[] = [];
    if ('extractFigures' in delegateInput && delegateInput.extractFigures)
      extractFlags.push('Extract Figures');
    if ('extractTikz' in delegateInput && delegateInput.extractTikz)
      extractFlags.push('Extract TikZ');
    if (extractFlags.length > 0) {
      // prettier-ignore
      sections.push(buildToolUseSection('Extraction:', html`${extractFlags.map((f) => html`<span class="extract-flag"><i class="codicon codicon-file-media"></i> ${f}</span>`)}`));
    }

    // File groups (workflow file fields + memories for both delegation types)
    const fileGroups = getProposalFileGroups(delegateInput);
    if (fileGroups.length > 0) {
      // prettier-ignore
      const fileItems = html`${fileGroups.flatMap((g) => g.files.map((f) => html`<li class="detail-item"><i class="codicon codicon-file"></i> <span class="${g.clickable ? 'file-link clickable-link' : 'file-label'}" data-file=${ifDefined(g.clickable ? f : undefined)}>${f}</span> <span class="file-source">(${g.label})</span></li>`))}`;
      // prettier-ignore
      sections.push(buildToolUseSection('Files:', html`<ul class="detail-list">${fileItems}</ul>`));
    }
  }
  // Handle codex tool with structured display
  else if (toolName === 'codex' && isPlainObject(input)) {
    const codexInput = input as CodexInput;

    // Prompt as readable text
    if (codexInput.prompt) {
      sections.push(
        buildToolUseSection('Prompt:', wrapInPre(codexInput.prompt)),
      );
    }

    // Sandbox mode + background as compact badges
    const badges: TemplateResult[] = [];
    if (codexInput.sandbox_mode) {
      // prettier-ignore
      badges.push(html`<span class="extract-flag"><i class="codicon codicon-shield"></i> ${codexInput.sandbox_mode}</span>`);
    }
    if (codexInput.run_in_background) {
      // prettier-ignore
      badges.push(html`<span class="extract-flag"><i class="codicon codicon-run-all"></i> background</span>`);
    }
    if (badges.length > 0) {
      // prettier-ignore
      sections.push(buildToolUseSection('Mode:', html`${badges}`));
    }

    // Working directory if specified
    if (codexInput.working_directory) {
      sections.push(
        buildToolUseSection(
          'Directory:',
          wrapInPre(codexInput.working_directory),
        ),
      );
    }
  }
  // Default handling for other tools
  else if (input != null) {
    const codeLanguage = TOOL_CODE_LANGUAGES.get(toolName);
    const { isCodeOnly, code } = codeLanguage
      ? extractCodeOnlyInput(input)
      : { isCodeOnly: false, code: '' };

    if (isCodeOnly) {
      sections.push(
        buildToolSection('', code, { toolName, language: codeLanguage }),
      );
    } else {
      const { text: inputValue, language: inputLanguage } =
        stringifyWithLanguage(input);
      if (inputValue) {
        sections.push(
          buildToolSection('', inputValue, {
            toolName,
            language: inputLanguage,
          }),
        );
      }
    }
  }

  // Show output if present
  const isWriteTool = TOOLS_WITH_FILE_CONTENT.has(toolName);
  const isTrivialWriteOutput =
    isWriteTool && outputText.trim() === TRIVIAL_WRITE_OUTPUT;
  if (
    outputText &&
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
  const extraContent = html`${timerTemplate ?? nothing}${proposalId ? html`<span class="proposal-restore-link proposal-banner-setup" data-proposal-id=${proposalId} title="Setup this proposal configuration"><i class="codicon codicon-reply"></i> Setup</span>` : nothing}`;

  // prettier-ignore
  return html`<details class=${classMap({
    'banner-details': true,
    'tool-use-details': true,
    'tool-use-error': showAsError,
    'tool-use-user-feedback': isUserFeedback,
    'tool-use-in-progress': isInProgress,
  })} ?open=${shouldOpen}>${buildDetailsSummary({
    iconClass,
    label: titleText,
    labelClass: 'tool-use-title',
    includeIconClass: false,
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
  const iconClass = STATUS_ICONS[statusKey] ?? 'codicon codicon-globe';

  let titleText = `${providerLabel} Search`;
  if (query) titleText += `: "${query}"`;
  titleText += statusSuffix;

  // Build content sections — query is already in the title, only show sources
  const sections: TemplateResult[] = [];

  if (resultCount > 0) {
    // prettier-ignore
    const resultItems = (results ?? []).map(
      (r) => html`<li class="detail-item"><i class="codicon codicon-link"></i> <a href=${r.url ?? ''} class="web-search-link" target="_blank" rel="noopener noreferrer">${r.title ?? r.domain ?? r.url}</a>${r.domain ? html` <span class="file-source">(${r.domain})</span>` : ''}</li>`,
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
    iconClass,
    label: titleText,
    labelClass: 'tool-use-title',
    includeIconClass: false,
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

  const iconClass = isFailed
    ? 'codicon codicon-error'
    : 'codicon codicon-cloud-download';

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
    iconClass,
    label: titleText,
    labelClass: 'tool-use-title',
    includeIconClass: false,
  })}${bannerContentTemplate}</details>`;
}
