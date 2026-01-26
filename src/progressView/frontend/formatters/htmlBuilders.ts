/**
 * Lit template utilities for progress view formatters.
 * These functions create reusable Lit templates from normalized data.
 */

// Third-party imports - use optimized hljs with only TeXRA-relevant languages
import hljs from '@shared/highlighting/hljs';

// Local imports - Lit utilities

// Local imports - shared utilities
import { CHEVRON_RIGHT_CLASS, CHEVRON_DOWN_CLASS } from '@shared/utils/icons';
import { getBasename } from '@shared/utils/path';
import {
  html,
  unsafeHTML,
  classMap,
  ifDefined,
  type TemplateResult,
} from './litTemplates';

// Local imports - shared schemas

// Local imports - formatter helpers
import {
  TOOL_ICON_MAP,
  DIFF_DETECTION_LINE_LIMIT,
  DIFF_MARKER_THRESHOLD,
} from './constants';
import { generateInlineDiff } from './wordDiff';
import type { FileListEntry } from '@shared/schemas';

/** Build a tool-use section template. */
export function buildToolUseSection(
  label: string,
  content: TemplateResult,
): TemplateResult {
  return html`
    <div class="tool-use-section">
      <div class="tool-use-subsection">
        <span class="tool-use-sublabel">${label}</span>
        ${content}
      </div>
    </div>
  `;
}

// Diff line prefix patterns (longer prefixes first for correct matching)
const DIFF_LINE_PATTERNS = [
  { prefix: '@@', className: 'diff-hunk' },
  { prefix: '+++', className: null },
  { prefix: '---', className: null },
  { prefix: '+', className: 'diff-add' },
  { prefix: '-', className: 'diff-remove' },
] as const;

/** Get diff line class based on line content. */
function getDiffLineClass(line: string): string | null {
  for (const { prefix, className } of DIFF_LINE_PATTERNS) {
    if (line.startsWith(prefix)) return className;
  }
  return null;
}

/** Check if text appears to be diff output. */
function isDiffContent(text: string): boolean {
  const lines = text.split('\n').slice(0, DIFF_DETECTION_LINE_LIMIT);
  const diffMarkers = lines.filter(
    (line) =>
      line.startsWith('@@') || line.startsWith('+++') || line.startsWith('---'),
  ).length;
  return diffMarkers >= DIFF_MARKER_THRESHOLD;
}

/** Wrap text in a pre element with optional class and diff highlighting. */
export function wrapInPre(text: string, className = ''): TemplateResult {
  if (!isDiffContent(text)) {
    return html`<pre class=${ifDefined(className || undefined)}>${text}</pre>`;
  }

  // Apply diff highlighting
  const lines = text.split('\n');
  return html`<pre class=${ifDefined(className || undefined)}>
${lines.map((line, i) => {
      const diffClass = getDiffLineClass(line);
      const suffix = i < lines.length - 1 ? '\n' : '';
      return diffClass
        ? html`<span class=${diffClass}>${line}</span>${suffix}`
        : html`${line}${suffix}`;
    })}</pre
  >`;
}

/** Set common dataset attributes on an element. */
export function setElementDataset(
  element: HTMLElement,
  {
    logId,
    groupId,
    timestamp,
  }: { logId?: string; groupId?: string; timestamp?: string },
): void {
  if (logId) element.dataset.logId = logId;
  if (groupId) element.dataset.groupId = groupId;
  if (timestamp) element.dataset.fullTimestamp = timestamp;
}

/** Initialize toggle icon on a collapsible element. */
export function initToggleIcon(element: HTMLElement, expanded = false): void {
  const toggleIcon = element.querySelector('.toggle-icon');
  if (toggleIcon) {
    toggleIcon.className = `${
      expanded ? CHEVRON_DOWN_CLASS : CHEVRON_RIGHT_CLASS
    } toggle-icon`;
  }
}

/** Build a copy button for banner content. */
export function buildCopyButton(title: string, hidden = false): TemplateResult {
  return html`
    <vscode-toolbar-button
      class="banner-content-copy"
      icon="copy"
      title=${title}
      aria-label=${title}
      data-default-title=${title}
      data-success-title="Copied!"
      ?hidden=${hidden}
    ></vscode-toolbar-button>
  `;
}

/** Options for building a details summary header. */
export interface DetailsSummaryOptions {
  iconClass: string;
  label: string;
  labelClass?: string;
  includeIconClass?: boolean;
  timestamp?: { display: string; tooltip: string };
  copyButton?: { title: string; hidden?: boolean };
  /** Initial expanded state for toggle icon. Default: false (collapsed). */
  expanded?: boolean;
}

/** Build a details summary element with icon, label, and optional extras. */
export function buildDetailsSummary(
  options: DetailsSummaryOptions,
): TemplateResult {
  const {
    iconClass,
    label,
    labelClass = 'label',
    includeIconClass = true,
    timestamp,
    copyButton,
    expanded = false,
  } = options;
  const iconClasses = includeIconClass
    ? `codicon icon ${iconClass}`
    : `codicon ${iconClass}`;
  const toggleIconClass = expanded ? CHEVRON_DOWN_CLASS : CHEVRON_RIGHT_CLASS;
  // prettier-ignore
  return html`<summary class="details-summary"><i class="${toggleIconClass} toggle-icon"></i> <i class=${iconClasses}></i> <span class=${labelClass}>${label}</span>${timestamp
        ? html` <span class="timestamp" title=${timestamp.tooltip}>${timestamp.display}</span>`
        : ''}${copyButton ? buildCopyButton(copyButton.title, copyButton.hidden) : ''}</summary>`;
}

/** Build rendered templates for file list. */
export function buildFileListRender(files: FileListEntry[]): {
  items: TemplateResult;
  summary: string;
} | null {
  if (!Array.isArray(files)) return null;

  // prettier-ignore
  const items = html`${files.map((file) => {
    const icon = file.ok ? 'codicon-check' : 'codicon-warning';
    const filePath = file.path;
    const fileName = getBasename(filePath);

    const source = file.source ?? 'unknown';
    const showSource = source !== 'unknown';
    const sourceDisplay = file.sourceDisplay ?? source;
    const sourceText = file.internal
      ? `${sourceDisplay}, internal`
      : sourceDisplay;

    // prettier-ignore
    return html`<li class="detail-item" title=${filePath}><i class=${`codicon ${icon}`}></i> <span class="file-link clickable-link" data-file=${filePath}>${fileName}</span>${file.varName ? html` <span class="file-var">[${file.varName}]</span>` : ''}${showSource ? html` <span class="file-source">(${sourceText})</span>` : ''}</li>`;
  })}`;

  const loadedFiles = files.filter((file) => file.ok).length;
  const failedFiles = files.length - loadedFiles;
  const failedSuffix = failedFiles > 0 ? `, ${failedFiles} not found` : '';
  const summary = `Files (${loadedFiles}/${files.length} loaded${failedSuffix})`;

  return { items, summary };
}

/** Build file link template. */
export function buildFileLink(
  filePath: string,
  displayName: string,
): TemplateResult {
  if (!filePath) {
    return html`<span>${displayName}</span>`;
  }
  return html`<span class="file-link clickable-link" data-file=${filePath}
    >${displayName}</span
  >`;
}

/** Get appropriate icon class for a tool. */
export function getToolIconClass(toolName: string, isError = false): string {
  if (isError) return 'codicon-error';
  return TOOL_ICON_MAP[toolName] ?? 'codicon-wrench';
}

// ============================================================================
// Syntax Highlighting
// ============================================================================

/** Human-readable labels for language badges */
const LANGUAGE_LABELS: Record<string, string> = {
  bash: 'Bash',
  json: 'JSON',
  yaml: 'YAML',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  plaintext: 'Text',
};

/** Get display label for a language. */
const getLanguageLabel = (language: string): string =>
  LANGUAGE_LABELS[language] ?? (language || 'Text');

/** Apply syntax highlighting to code if language is supported. Returns HTML string for unsafeHTML. */
function highlightCode(text: string, language: string): string {
  const isHighlightable = language && language !== 'plaintext';
  if (!isHighlightable || !hljs.getLanguage(language)) {
    // Return plain text - will be escaped by Lit
    return text;
  }
  try {
    // Returns HTML with syntax highlighting spans
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return text;
  }
}

/** Build a code block with optional syntax highlighting, language badge, and copy button. */
export function buildCodeBlock(
  text: string,
  options: {
    language?: string;
    className?: string;
    showLanguage?: boolean;
    showCopy?: boolean;
  } = {},
): TemplateResult {
  const {
    language = 'plaintext',
    className = '',
    showLanguage = false,
    showCopy = false,
  } = options;

  const preClasses = { hljs: true, [className]: Boolean(className) };
  const highlighted = highlightCode(text, language);
  const isHighlighted = highlighted !== text;

  return html`
    <div class="code-block" data-language=${language}>
      ${showLanguage || showCopy
        ? html`
            <div class="code-block-header">
              ${showLanguage
                ? html`<span class="code-block-language"
                    >${getLanguageLabel(language)}</span
                  >`
                : ''}
              ${showCopy
                ? html`<button
                    class="code-block-copy"
                    title="Copy to clipboard"
                  >
                    <i class="codicon codicon-copy"></i>
                  </button>`
                : ''}
            </div>
          `
        : ''}
      <pre class=${classMap(preClasses)}>
<code>${isHighlighted ? unsafeHTML(highlighted) : text}</code></pre>
    </div>
  `;
}

// ============================================================================
// File Links with Line Numbers
// ============================================================================

/** Build a file link with optional line number for VS Code navigation. */
export function buildFileLinkWithLines(
  filePath: string,
  options: { startLine?: number; endLine?: number } = {},
): TemplateResult {
  if (!filePath) return html``;

  const { startLine, endLine } = options;
  const fileName = getBasename(filePath) || filePath;

  // Build line info string
  let lineInfo = '';
  if (startLine && endLine && startLine !== endLine) {
    lineInfo = `:${startLine}-${endLine}`;
  } else if (startLine) {
    lineInfo = `:${startLine}`;
  }

  const displayText = fileName + lineInfo;

  // prettier-ignore
  return html`<span class="file-link clickable-link" data-file=${filePath} data-file-line=${ifDefined(startLine)}><i class="codicon codicon-file"></i> ${displayText}</span>`;
}

// ============================================================================
// Edit Diff Display (Inline Word-Level Diff)
// ============================================================================

/** Build edit diff section showing old_string to new_string with inline highlighting. */
export function buildEditDiffSection(
  oldString: string,
  newString: string,
): TemplateResult {
  return html`
    <div class="edit-diff-container">
      <pre class="diff-inline-view">
${generateInlineDiff(oldString, newString)}</pre
      >
    </div>
  `;
}
