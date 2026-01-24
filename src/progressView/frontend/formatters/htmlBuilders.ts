// Third-party imports
import hljs from 'highlight.js';

// Local imports
import {
  DIFF_DETECTION_LINE_LIMIT,
  DIFF_MARKER_THRESHOLD,
  TOOL_ICON_MAP,
} from './constants';
import { encodeHtml } from './htmlEncoding';
import { generateInlineDiff } from './wordDiff';

export const buildToolUseSection = (label: string, content: string) => `
  <div class="tool-use-section">
    <div class="tool-use-subsection">
      <span class="tool-use-sublabel">${label}</span>
      ${content}
    </div>
  </div>
`;

const DIFF_LINE_PATTERNS = [
  { prefix: '@@', className: 'diff-hunk' },
  { prefix: '+++', className: null },
  { prefix: '---', className: null },
  { prefix: '+', className: 'diff-add' },
  { prefix: '-', className: 'diff-remove' },
];

const getDiffLineClass = (line: string): string | null => {
  for (const { prefix, className } of DIFF_LINE_PATTERNS) {
    if (line.startsWith(prefix)) return className;
  }
  return null;
};

const isDiffContent = (text: string): boolean => {
  const lines = text.split('\n').slice(0, DIFF_DETECTION_LINE_LIMIT);
  const diffMarkers = lines.filter(
    (line) =>
      line.startsWith('@@') || line.startsWith('+++') || line.startsWith('---'),
  ).length;
  return diffMarkers >= DIFF_MARKER_THRESHOLD;
};

export const wrapInPre = (text: string, className = ''): string => {
  const classAttr = className ? ` class="${className}"` : '';

  if (!isDiffContent(text)) {
    return `<pre${classAttr}>${encodeHtml(text)}</pre>`;
  }

  const highlightedLines = text.split('\n').map((line) => {
    const diffClass = getDiffLineClass(line);
    const encoded = encodeHtml(line);
    return diffClass ? `<span class="${diffClass}">${encoded}</span>` : encoded;
  });

  return `<pre${classAttr}>${highlightedLines.join('\n')}</pre>`;
};

export const buildFileListRender = (
  files: Array<{
    filePath: string;
    fileName: string;
    ok: boolean;
    source: string;
    sourceDisplay: string;
    internal: boolean;
    varName: string;
  }>,
): { items: string; summary: string } | null => {
  if (!Array.isArray(files)) return null;

  const items = files
    .map((file) => {
      const icon = file.ok ? 'codicon-check' : 'codicon-warning';
      const escaped = encodeHtml(file.filePath);
      const fileNameEscaped = encodeHtml(file.fileName);

      const metaParts = [];
      if (file.varName) {
        metaParts.push(
          `<span class="file-var">[${encodeHtml(file.varName)}]</span>`,
        );
      }
      if (file.source && file.source !== 'unknown') {
        const sourceDisplay = encodeHtml(file.sourceDisplay);
        const sourceText = file.internal
          ? `${sourceDisplay}, internal`
          : sourceDisplay;
        metaParts.push(`<span class="file-source">(${sourceText})</span>`);
      }

      return `<li class="detail-item" title="${escaped}"><i class="codicon ${icon}"></i> <span class="file-link clickable-link" data-file="${escaped}">${fileNameEscaped}</span> ${metaParts.join(' ')}</li>`;
    })
    .join('');

  const loadedFiles = files.filter((file) => file.ok).length;
  const failedFiles = files.length - loadedFiles;
  const failedSuffix = failedFiles > 0 ? `, ${failedFiles} not found` : '';
  const summary = `Files (${loadedFiles}/${files.length} loaded${failedSuffix})`;

  return { items, summary };
};

export const buildFileLink = (
  filePath: string,
  displayName: string,
): string => {
  if (!filePath) {
    return `<span>${encodeHtml(displayName)}</span>`;
  }
  return `<span class="file-link clickable-link" data-file="${encodeHtml(filePath)}">${encodeHtml(displayName)}</span>`;
};

export const buildDetailItem = (
  iconClass: string,
  content: string,
  options: { title?: string; runId?: string } = {},
): string => {
  const titleAttr = options.title
    ? ` title="${encodeHtml(options.title)}"`
    : '';
  const runAttr = options.runId
    ? ` data-run-id="${encodeHtml(options.runId)}"`
    : '';
  return `<li class="detail-item"${runAttr}><i class="codicon ${iconClass}"${titleAttr}></i> ${content}</li>`;
};

export const getToolIconClass = (toolName: string, isError = false): string => {
  if (isError) return 'codicon-error';
  return TOOL_ICON_MAP[toolName] || 'codicon-wrench';
};

const LANGUAGE_LABELS: Record<string, string> = {
  bash: 'Bash',
  json: 'JSON',
  yaml: 'YAML',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  plaintext: 'Text',
};

const getLanguageLabel = (language: string): string =>
  LANGUAGE_LABELS[language] || language || 'Text';

export const buildCodeBlock = (
  text: string,
  options: {
    language?: string;
    className?: string;
    showLanguage?: boolean;
    showCopy?: boolean;
  } = {},
): string => {
  const {
    language = 'plaintext',
    className = '',
    showLanguage = false,
    showCopy = false,
  } = options;

  const preClasses = ['hljs', className].filter(Boolean).join(' ');

  let codeContent: string;
  const isHighlightable = language && language !== 'plaintext';

  if (isHighlightable && hljs.getLanguage(language)) {
    try {
      const result = hljs.highlight(text, { language, ignoreIllegals: true });
      codeContent = result.value;
    } catch {
      codeContent = encodeHtml(text);
    }
  } else {
    codeContent = encodeHtml(text);
  }

  const headerParts: string[] = [];
  if (showLanguage) {
    const label = getLanguageLabel(language);
    headerParts.push(
      `<span class="code-block-language">${encodeHtml(label)}</span>`,
    );
  }
  if (showCopy) {
    headerParts.push(
      `<button class="code-block-copy" title="Copy to clipboard"><i class="codicon codicon-copy"></i></button>`,
    );
  }

  const header =
    headerParts.length > 0
      ? `<div class="code-block-header">${headerParts.join('')}</div>`
      : '';

  return `<div class="code-block" data-language="${encodeHtml(language)}">${header}<pre class="${preClasses}"><code>${codeContent}</code></pre></div>`;
};

export const buildFileLinkWithLines = (
  filePath: string,
  options: { startLine?: number; endLine?: number } = {},
): string => {
  if (!filePath) return '';

  const { startLine, endLine } = options;
  const fileName = filePath.split('/').pop() || filePath;

  let lineInfo = '';
  if (startLine && endLine && startLine !== endLine) {
    lineInfo = `:${startLine}-${endLine}`;
  } else if (startLine) {
    lineInfo = `:${startLine}`;
  }

  const displayText = fileName + lineInfo;
  const lineAttr = startLine ? ` data-file-line="${startLine}"` : '';

  return `<span class="file-link clickable-link" data-file="${encodeHtml(filePath)}"${lineAttr}><i class="codicon codicon-file"></i> ${encodeHtml(displayText)}</span>`;
};

export const buildEditDiffSection = (
  oldString: string,
  newString: string,
): string => {
  const diffHtml = generateInlineDiff(oldString, newString);
  return `<div class="edit-diff-container"><pre class="diff-inline-view">${diffHtml}</pre></div>`;
};
