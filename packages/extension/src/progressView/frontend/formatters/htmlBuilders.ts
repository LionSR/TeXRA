/**
 * Lit template utilities for progress view formatters.
 * These functions create reusable Lit templates from normalized data.
 *
 * IMPORTANT: Lit templates preserve whitespace literally. Multi-line templates with
 * indentation will render with unwanted spaces in the output. Always use single-line
 * templates with `// prettier-ignore` to prevent whitespace issues.
 */

// Third-party imports - use optimized hljs with only TeXRA-relevant languages
import type { FileListEntry } from '@shared/schemas';
import { hljs } from '@shared/highlighting/hljs';

// Local imports - shared utilities
import { TEXRA_ICON_LIBRARY, waIcon } from '@shared/wa/webAwesomeIcons';
import { getBasename } from '@utils/core';

// Local imports - Lit template utilities
import {
  html,
  unsafeHTML,
  classMap,
  ifDefined,
  nothing,
  type TemplateResult,
} from './litTemplates';

// Local imports - formatter helpers
import {
  TOOL_ICON_MAP,
  DIFF_DETECTION_LINE_LIMIT,
  DIFF_MARKER_THRESHOLD,
} from './constants';
import { generateInlineDiff } from './wordDiff';
import { registerCopyContent } from './copyContentStore';

/** Build a tool-use section template. Empty label omits the label element. */
export function buildToolUseSection(
  label: string,
  content: TemplateResult | typeof nothing,
): TemplateResult {
  // prettier-ignore
  return html`<div class="tool-use-section"><div class="tool-use-subsection">${label ? html`<span class="tool-use-sublabel">${label}</span>` : nothing}${content}</div></div>`;
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

/** Build line info suffix for file links. */
function buildLineInfo(startLine?: number, endLine?: number): string {
  if (!startLine) return '';
  if (endLine && endLine !== startLine) {
    return `:${startLine}-${endLine}`;
  }
  return `:${startLine}`;
}

/** Wrap text in a pre element with optional class and diff highlighting. */
export function wrapInPre(text: string, className = ''): TemplateResult {
  if (!isDiffContent(text)) {
    return html`<pre class=${ifDefined(className || undefined)}>${text}</pre>`;
  }

  // Apply diff highlighting
  const lines = text.split('\n');
  const content = lines.map((line, i) => {
    const diffClass = getDiffLineClass(line);
    const suffix = i < lines.length - 1 ? '\n' : '';
    return diffClass
      ? html`<span class=${diffClass}>${line}</span>${suffix}`
      : html`${line}${suffix}`;
  });
  // prettier-ignore
  return html`<pre class=${ifDefined(className || undefined)}>${content}</pre>`;
}

/**
 * Stop an Enter/Space keydown on a control slotted into a `<wa-details>`
 * summary from also toggling the details panel.
 *
 * `<wa-details>`'s own `handleSummaryClick` excludes interactive descendants
 * (`<a>`, `<button>`, form-associated custom elements like `<wa-button>`)
 * from triggering its toggle, but its `handleSummaryKeyDown` has no such
 * check — every Enter/Space keydown that bubbles up to the `<summary>` calls
 * `preventDefault()` and toggles, regardless of where it originated. Left
 * unhandled, that ancestor `preventDefault()` also suppresses the focused
 * control's own native keyboard activation (a button's Enter/Space normally
 * synthesizes a `click`), so the control silently stops responding to the
 * keyboard entirely — it only toggles the panel.
 *
 * Calling `stopPropagation()` here, on a listener bound directly to the
 * control, runs before the event can reach `<summary>` and prevents both the
 * unwanted toggle and the swallowed activation. It intentionally does not
 * call `preventDefault()`, so the control's own native click synthesis for
 * Enter/Space (and the click event that produces) is unaffected and still
 * bubbles normally to any delegated click handler further up the tree.
 */
export function stopSummaryToggleKeydown(event: Event): void {
  if (!(event instanceof KeyboardEvent)) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.stopPropagation();
}

/** Build a copy button for banner content. */
function buildCopyButton(
  title: string,
  options: { hidden?: boolean; content?: string; contentId?: string } = {},
): TemplateResult {
  const { hidden = false, content, contentId } = options;
  const copyId = content != null ? registerCopyContent(content, contentId) : '';
  // prettier-ignore
  return html`<wa-button class="action-icon-button banner-content-copy" appearance="plain" variant="neutral" size="small" type="button" title=${title} aria-label=${title} data-default-title=${title} data-success-title="Copied!" data-copy-id=${ifDefined(copyId || undefined)} data-copy-type="banner" ?hidden=${hidden} @keydown=${stopSummaryToggleKeydown}>${waIcon('copy')}</wa-button>`;
}

/**
 * Sentinel value for {@link DetailsSummaryOptions.iconName} that renders an
 * inline `<wa-spinner>` instead of a `<wa-icon>`. Used for in-progress states.
 */
export const SPINNER_ICON_NAME = '__spinner__';

/** Options for building a details summary header. */
export interface DetailsSummaryOptions {
  /** wa-icon name (codicon-style aliases supported), or {@link SPINNER_ICON_NAME}. */
  iconName: string;
  label: string;
  labelClass?: string;
  timestamp?: { display: string; tooltip: string };
  copyButton?: {
    title: string;
    hidden?: boolean;
    content?: string;
    contentId?: string;
  };
  /** Extra Lit template content rendered after the label (e.g. a live timer). */
  extraContent?: TemplateResult;
}

/**
 * Build a `<wa-details>` summary-slot header with icon, label, and optional
 * extras. The caller must render it inside a `<wa-details>` and rely on its
 * built-in toggle icon.
 */
export function buildDetailsSummary(
  options: DetailsSummaryOptions,
): TemplateResult {
  const {
    iconName,
    label,
    labelClass = 'label',
    timestamp,
    copyButton,
    extraContent,
  } = options;
  // prettier-ignore
  const iconTemplate = iconName === SPINNER_ICON_NAME
    ? html`<wa-spinner class="icon"></wa-spinner>`
    : html`<wa-icon library=${TEXRA_ICON_LIBRARY} name=${iconName} class="icon" aria-hidden="true"></wa-icon>`;
  // prettier-ignore
  const timestampTemplate = timestamp
    ? html` <span class="timestamp" title=${timestamp.tooltip}>${timestamp.display}</span>`
    : nothing;
  const copyTemplate = copyButton
    ? buildCopyButton(copyButton.title, copyButton)
    : nothing;
  const extraTemplate = extraContent ?? nothing;
  // prettier-ignore
  return html`<div slot="summary" class="details-summary">${iconTemplate} <span class=${labelClass}>${label}</span>${extraTemplate}${timestampTemplate}${copyTemplate}</div>`;
}

/** Build rendered templates for file list. */
export function buildFileListRender(files: FileListEntry[]): {
  items: TemplateResult;
  summary: string;
} | null {
  if (!Array.isArray(files)) return null;

  // prettier-ignore
  const items = html`${files.map((file) => {
    const iconName = file.ok ? 'check' : 'warning';
    const filePath = file.path;
    const fileName = getBasename(filePath);

    const source = file.source ?? 'unknown';
    const showSource = source !== 'unknown';
    const sourceText = file.sourceDisplay ?? source;

    // prettier-ignore
    return html`<li class="detail-item" title=${filePath}><wa-icon library=${TEXRA_ICON_LIBRARY} name=${iconName} aria-hidden="true"></wa-icon> <span class="file-link clickable-link" data-file=${filePath} role="button" tabindex="0">${fileName}</span>${file.varName ? html` <span class="file-var">[${file.varName}]</span>` : ''}${showSource ? html` <span class="file-source">(${sourceText})</span>` : ''}</li>`;
  })}`;

  const loadedFiles = files.filter((file) => file.ok).length;
  const failedFiles = files.length - loadedFiles;
  const failedSuffix = failedFiles > 0 ? `, ${failedFiles} not found` : '';
  const summary = `Files (${loadedFiles}/${files.length} loaded${failedSuffix})`;

  return { items, summary };
}

/** Get appropriate wa-icon name for a tool. */
export function getToolIconName(toolName: string, isError = false): string {
  if (isError) return 'error';
  return TOOL_ICON_MAP[toolName] ?? 'wrench';
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
function getLanguageLabel(language: string): string {
  return LANGUAGE_LABELS[language] ?? (language || 'Text');
}

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
  const showHeader = showLanguage || showCopy;

  // IMPORTANT: Lit templates preserve whitespace literally. Multi-line templates cause
  // unwanted spaces in rendered output. Use single-line templates with prettier-ignore.
  // Build modular template parts to keep individual lines readable.
  // prettier-ignore
  const languageBadge = showLanguage ? html`<span class="code-block-language">${getLanguageLabel(language)}</span>` : nothing;
  // prettier-ignore
  const copyButton = showCopy ? html`<wa-button class="code-block-copy" appearance="plain" variant="neutral" size="small" type="button" title="Copy to clipboard" aria-label="Copy to clipboard" data-copy-id=${registerCopyContent(text)} data-copy-type="code-block"><wa-icon library=${TEXRA_ICON_LIBRARY} name="copy" aria-hidden="true"></wa-icon></wa-button>` : nothing;
  // prettier-ignore
  const codeTemplate = html`<pre class=${classMap(preClasses)}><code>${isHighlighted ? unsafeHTML(highlighted) : text}</code></pre>`;
  // prettier-ignore
  const headerTemplate = showHeader ? html`<div class="code-block-header">${languageBadge}${copyButton}</div>` : nothing;
  // prettier-ignore
  return html`<div class="code-block" data-language=${language}>${headerTemplate}${codeTemplate}</div>`;
}

// ============================================================================
// File Links with Line Numbers
// ============================================================================

/** Build a file link with optional line number for VS Code navigation. */
export function buildFileLinkWithLines(
  filePath: string,
  options: { startLine?: number; endLine?: number } = {},
): TemplateResult | typeof nothing {
  if (!filePath) return nothing;

  const { startLine, endLine } = options;
  const fileName = getBasename(filePath) || filePath;
  const lineInfo = buildLineInfo(startLine, endLine);
  const displayText = fileName + lineInfo;

  // prettier-ignore
  return html`<span class="file-link clickable-link" data-file=${filePath} data-file-line=${ifDefined(startLine)} role="button" tabindex="0"><wa-icon library=${TEXRA_ICON_LIBRARY} name="file" aria-hidden="true"></wa-icon> ${displayText}</span>`;
}

// ============================================================================
// Memory Path Display (non-clickable, virtual paths)
// ============================================================================

/** Build a memory path display with database icon. Memory paths are virtual (/memories/...) and not directly openable in the editor. */
export function buildMemoryPathDisplay(
  memoryPath: string,
): TemplateResult | typeof nothing {
  if (!memoryPath) return nothing;
  const fileName = getBasename(memoryPath) || memoryPath;
  // prettier-ignore
  return html`<span class="memory-path"><wa-icon library=${TEXRA_ICON_LIBRARY} name="database" aria-hidden="true"></wa-icon> ${fileName} <span class="file-source">(${memoryPath})</span></span>`;
}

// ============================================================================
// Executions Path Display (non-clickable, virtual paths)
// ============================================================================

/** Build an executions path display with history icon. Execution paths are virtual (/executions/...) and not directly openable in the editor. */
export function buildExecutionsPathDisplay(
  execPath: string,
): TemplateResult | typeof nothing {
  if (!execPath) return nothing;
  // prettier-ignore
  return html`<span class="memory-path"><wa-icon library=${TEXRA_ICON_LIBRARY} name="history" aria-hidden="true"></wa-icon> ${execPath}</span>`;
}

// ============================================================================
// Edit Diff Display (Inline Word-Level Diff)
// ============================================================================

/** Build edit diff section showing old_string to new_string with inline highlighting. */
export function buildEditDiffSection(
  oldString: string,
  newString: string,
): TemplateResult {
  const diffContent = generateInlineDiff(oldString, newString);
  // prettier-ignore
  return html`<div class="edit-diff-container"><pre class="diff-inline-view">${diffContent}</pre></div>`;
}
