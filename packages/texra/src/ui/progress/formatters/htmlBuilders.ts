/**
 * Lit template utilities for progress view formatters.
 * These functions create reusable Lit templates from normalized data.
 */

// Third-party imports
import { formatResultCount, getBasename } from '@texra-ai/harness/schemas';
import { html, nothing, type TemplateResult } from 'lit';
import { classMap, type ClassInfo } from 'lit/directives/class-map.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { diffWordsWithSpace } from 'diff';
import { Duration } from 'effect';

import { highlightSpans } from '@ui/highlighting/highlightCode';
import type { IconName } from '@ui/wa/iconNames';

// Local imports - shared utilities
import { waSpinner } from '@ui/wa/spinner';
import { renderStatusBadge } from '@ui/wa/statusIcons';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { formatMediaLabel } from '@ui/copy/format';
import { fileLoadTone, statusGlyph } from '@ui/copy/runStatus';

// Side-effect import - register the <copy-button> element drawn below
import '@ui/progress/components/CopyButton';

// Local imports - formatter helpers
import type { FileListRow } from '@texra-ai/harness/transcript';

// Threshold constants for diff detection heuristics
const DIFF_DETECTION_LINE_LIMIT = 20;
const DIFF_MARKER_THRESHOLD = 2;

/**
 * Upper bound on the inline word diff, which runs synchronously inside Lit's
 * render on the webview's main thread over LLM-authored edit text.
 *
 * Deliberately far below `unifiedDiff`'s 5s Node-side bound rather than shared
 * with it: this budget is the frame the user is waiting on, so the two are
 * different policies for different threads, not one value written twice.
 */
const INLINE_DIFF_TIMEOUT_MS = 250;

/** Build a tool-use section template. Empty label omits the label element. */
export function buildToolUseSection(
  label: string,
  content: TemplateResult | typeof nothing,
): TemplateResult {
  // prettier-ignore
  return html`<div class="tool-use-section">${label ? html`<span class="tool-use-sublabel">${label}</span>` : nothing}${content}</div>`;
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
  );
  return diffMarkers.length >= DIFF_MARKER_THRESHOLD;
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

/** The labeled Copy button of a message header. */
export function buildCopyButton(
  title: string,
  content: string,
): TemplateResult {
  // prettier-ignore
  return html`<copy-button .text=${content} .label=${title} .look=${'labeled'}></copy-button>`;
}

/** A `<wa-icon>`, or a `<wa-spinner>` in its place while `running`. */
function renderIconOrSpinner(
  running: boolean,
  iconName: IconName,
  className?: string,
): TemplateResult {
  return running ? waSpinner(className) : waIcon(iconName, { className });
}

/** Build a neutral filled badge with a leading icon, a spinner while `running`. */
export function buildStatusBadge(
  iconName: IconName,
  label: string,
  running = false,
): TemplateResult {
  return renderStatusBadge({
    icon: renderIconOrSpinner(running, iconName),
    label,
    appearance: 'badge',
  });
}

/** Options for building a details summary header. */
interface DetailsSummaryOptions {
  /** The icon shown when not running. */
  iconName: IconName;
  /** Show a spinner in place of the icon. */
  running?: boolean;
  label: string;
  labelClass?: string;
  timestamp?: { display: string; tooltip: string };
  copyButton?: {
    title: string;
    content: string;
  };
  /** Extra Lit template content rendered after the label (e.g. a live timer). */
  extraContent?: TemplateResult;
}

/** The summary-slot header of {@link buildDetailsCard}: icon, label, and
 *  optional extras. */
function buildDetailsSummary(options: DetailsSummaryOptions): TemplateResult {
  const {
    iconName,
    running = false,
    label,
    labelClass = 'label',
    timestamp,
    copyButton,
    extraContent,
  } = options;
  const iconTemplate = renderIconOrSpinner(running, iconName, 'icon');
  // prettier-ignore
  const timestampTemplate = timestamp
    ? html` <span class="timestamp" title=${timestamp.tooltip}><bdi dir="ltr">${timestamp.display}</bdi></span>`
    : nothing;
  const copyTemplate = copyButton
    ? html`<copy-button
        .text=${copyButton.content}
        .label=${copyButton.title}
      ></copy-button>`
    : nothing;
  const extraTemplate = extraContent ?? nothing;
  // prettier-ignore
  return html`<div slot="summary" class="details-summary">${iconTemplate} <span class=${labelClass} dir="auto">${label}</span>${extraTemplate}${timestampTemplate}${copyTemplate}</div>`;
}

/**
 * A collapsible transcript card: a plain `<wa-details>` with its toggle
 * icon at the start, the summary header, and `body` below it. Every
 * card of the transcript draws its disclosure through this one shell.
 */
export function buildDetailsCard(opts: {
  summary: DetailsSummaryOptions;
  body: TemplateResult;
  open?: boolean;
  classes?: ClassInfo;
}): TemplateResult {
  const classes = { 'banner-details': true, ...opts.classes };
  // prettier-ignore
  return html`<wa-details appearance="plain" icon-placement="start" class=${classMap(classes)} ?open=${opts.open ?? false}>${buildDetailsSummary(opts.summary)}${opts.body}</wa-details>`;
}

/**
 * Build the clickable file-path span the webview's delegated click handler
 * turns into an editor navigation. `content` is the visible label; pass
 * `startLine` to target a line within the file.
 */
export function buildFileLinkSpan(
  filePath: string,
  content: unknown,
  options: { startLine?: number } = {},
): TemplateResult {
  const lineSuffix = options.startLine ? `:${options.startLine}` : '';
  const accessibleName = `Open ${filePath}${lineSuffix}`;
  // prettier-ignore
  return html`<span class="file-link clickable-link" data-file=${filePath} data-file-line=${ifDefined(options.startLine)} role="button" tabindex="0" aria-label=${accessibleName} dir="auto">${content}</span>`;
}

/** Build a file's `+3 -1` chip: the counts for the eye, the sentence for a
 *  screen reader. */
export function buildLineChangeStats(changes: {
  readonly added: number;
  readonly removed: number;
}): TemplateResult {
  // prettier-ignore
  return html`<span class="file-stats"><span class="visually-hidden">${formatResultCount(changes.added, 'line')} added, ${formatResultCount(changes.removed, 'line')} removed</span><span class="added" aria-hidden="true">+${changes.added}</span><span class="removed" aria-hidden="true">-${changes.removed}</span></span>`;
}

/** Build the `<li>` rows for a file-list banner. The summary line above them
 *  is the row's (`FileListRow.summary`), not derived here. A file that
 *  reached the model as an image or audio clip carries its `media`, and
 *  reports its kind and size beside its name. */
export function buildFileListRender(
  files: FileListRow['files'],
): TemplateResult {
  // prettier-ignore
  return html`${files.map((file) => {
    const tone = fileLoadTone(file.ok);
    const filePath = file.path;
    const fileName = getBasename(filePath);
    const loaded = file.media;

    // The one rule for a loaded file's source label, shared with the CLI
    // (transcriptRowLines): paint `sourceDisplay`, nothing else — an entry
    // worth labelling sets `sourceDisplay`, so no host needs a fallback to
    // spell it out.
    // prettier-ignore
    return html`<li class="detail-item" title=${filePath}>${waIcon(statusGlyph({ tone }), { className: `file-load-icon tone-${tone}` })} ${buildFileLinkSpan(filePath, html`<bdi dir="auto">${fileName}</bdi>`)}${file.varName ? html` <span class="file-var">[<bdi dir="auto">${file.varName}</bdi>]</span>` : ''}${file.sourceDisplay ? html` <span class="file-source">(<bdi dir="auto">${file.sourceDisplay}</bdi>)</span>` : ''}${loaded ? html` <span class="file-media"><bdi dir="ltr">${formatMediaLabel(loaded)}</bdi></span>` : ''}</li>`;
  })}`;
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

/** Build a code block with syntax highlighting, a language badge and a copy button. */
export function buildCodeBlock(
  text: string,
  language: string,
  className = '',
): TemplateResult {
  const preClasses = { hljs: true, [className]: Boolean(className) };
  // `null` means unsupported or failed: render the code as plain text.
  const highlighted =
    language === 'plaintext' ? null : highlightSpans(text, language);
  // prettier-ignore
  const languageBadge = html`<span class="code-block-language">${LANGUAGE_LABELS[language] ?? language}</span>`;
  // prettier-ignore
  const copyButton = html`<copy-button .text=${text} .label=${'Copy code'} .look=${'code'}></copy-button>`;
  // prettier-ignore
  const codeTemplate = html`<pre class=${classMap(preClasses)} dir="ltr"><code>${highlighted === null ? text : unsafeHTML(highlighted)}</code></pre>`;
  // prettier-ignore
  return html`<div class="code-block" data-language=${language}><div class="code-block-header">${languageBadge}${copyButton}</div>${codeTemplate}</div>`;
}

// ============================================================================
// Edit Diff Display (Inline Word-Level Diff)
// ============================================================================

/**
 * Generate inline diff template showing changes between old and new text.
 *
 * Word-level rather than character-level: whole-word runs are what a reader
 * can scan, and they come from the same engine as every other diff in the
 * product. The webview highlights inline spans while the terminal renders
 * unified hunks — two correct paints of one payload for two media.
 *
 * Bounded because this runs inside Lit's render on the main thread: on
 * timeout jsdiff returns `undefined`, and the fallback paints the edit as a
 * whole replacement — "all of it changed" is true, if verbose, where an
 * unbounded run would freeze the panel instead.
 */
function generateInlineDiff(oldText: string, newText: string): TemplateResult {
  const parts = diffWordsWithSpace(oldText, newText, {
    timeout: INLINE_DIFF_TIMEOUT_MS,
  });

  if (!parts) {
    console.warn(
      `[progressView] Inline diff exceeded ${Duration.format(Duration.millis(INLINE_DIFF_TIMEOUT_MS))} ` +
        `(${oldText.length} → ${newText.length} chars); ` +
        `painting it as a whole replacement.`,
    );
    // prettier-ignore
    return html`<del class="diff-inline-del" dir="auto">${oldText}</del><ins class="diff-inline-add" dir="auto">${newText}</ins>`;
  }

  return html`${parts.map((part) => {
    if (part.removed) {
      return html`<del class="diff-inline-del" dir="auto">${part.value}</del>`;
    }
    if (part.added) {
      return html`<ins class="diff-inline-add" dir="auto">${part.value}</ins>`;
    }
    return part.value;
  })}`;
}

/** Build edit diff section showing old_string to new_string with inline highlighting. */
export function buildEditDiffSection(
  oldString: string,
  newString: string,
): TemplateResult {
  const diffContent = generateInlineDiff(oldString, newString);
  // prettier-ignore
  return html`<div class="edit-diff-container"><pre class="diff-inline-view" dir="auto">${diffContent}</pre></div>`;
}
