/**
 * Painter for the structured tool sections a `ToolRowModel` carries.
 *
 * Which sections a call produces — its file links, diffs, agent identifiers,
 * MCP structured content, and the generic input fallback — is decided once in
 * `@texra-ai/harness/transcript` (`toolRowModel`). This module only turns those data
 * sections into Lit templates, and picks the two presentation details the
 * model deliberately leaves to a host: the highlight language behind the
 * `file`/`shell` hints, and the glyph on a badge. The code and terminal
 * section builders here are also what the tool-use formatter paints its
 * input and output with.
 */

import { absurd } from 'effect';
import { html, nothing, type TemplateResult } from 'lit';

import { getBasename } from '@texra-ai/harness/schemas';
import {
  buildToolUseSection,
  wrapInPre,
  buildCodeBlock,
  buildFileLinkSpan,
  buildEditDiffSection,
  buildStatusBadge,
  buildLineChangeStats,
} from '@ui/progress/formatters/htmlBuilders';
import { formatLineRange } from '@ui/copy/format';
import { highlightLanguageForPath } from '@ui/highlighting/languageForPath';
import { statusGlyph, TOOL_STATUS } from '@ui/copy/runStatus';
import { waIcon } from '@ui/wa/webAwesomeIcons';

import type {
  ToolFileGroupsSection,
  ToolFileListSection,
  ToolFileSection,
  ToolSection,
} from '@texra-ai/harness/transcript';

// Side-effect import to register <terminal-output> custom element
import '@ui/progress/components/TerminalOutput';

type ToolSectionOptions = {
  language?: string;
  extraClass?: string;
};

/** Build a tool section, highlighted in `language` unless it is plaintext. */
export function buildToolSection(
  label: string,
  text: string,
  options: ToolSectionOptions = {},
): TemplateResult {
  const { language = 'plaintext', extraClass = '' } = options;
  const shouldHighlight = language !== 'plaintext';

  const content = shouldHighlight
    ? buildCodeBlock(text, language, extraClass)
    : wrapInPre(text, extraClass);

  return buildToolUseSection(label, content);
}

/** Build a read-only terminal section for shell output. */
export function buildTerminalSection(
  label: string,
  text: string,
): TemplateResult {
  return buildToolUseSection(
    label,
    html`<terminal-output
      class="tool-output-terminal"
      .text=${text}
    ></terminal-output>`,
  );
}

/** Line count past which a text section becomes a fixed-height scroll box. */
const TEXT_SECTION_SCROLL_LINES = 20;

/**
 * Resolve the highlight language for a code section. `file` and `shell` are
 * the model's two deferred hints: the first means "whatever this file is",
 * the second a shell command, highlighted as bash.
 */
function codeLanguage(language: string, filePath: string): string {
  if (language === 'file') return highlightLanguageForPath(filePath);
  if (language === 'shell') return 'bash';
  return language;
}

/**
 * A code section carrying the call's own source — a shell command or a
 * script — wraps instead of scrolling sideways, so a long one-liner
 * stays readable inside the card.
 */
function isCommandInput(language: string): boolean {
  return language === 'shell' || language === 'javascript';
}

/** The one list shell the file and file-group sections share. */
function renderDetailList(label: string, items: unknown): TemplateResult {
  // prettier-ignore
  return buildToolUseSection(label, html`<ul class="detail-list">${items}</ul>`);
}

/**
 * The path of a file section. A workspace file is a link to the file (and
 * its line range); a run path is virtual, so it is shown, not linked.
 */
function renderFilePath(section: ToolFileSection): TemplateResult {
  switch (section.namespace) {
    case 'run':
      // prettier-ignore
      return html`<span class="memory-path">${waIcon('clock-rotate-left')} <bdi dir="auto">${section.path}</bdi></span>`;
    case 'workspace': {
      const { startLine, endLine } = section;
      const range = formatLineRange(startLine, endLine);
      const name = getBasename(section.path) || section.path;
      return buildFileLinkSpan(
        section.path,
        html`${waIcon('file')} <bdi dir="auto">${name}${range}</bdi>`,
        { startLine },
      );
    }
    default:
      return absurd(section.namespace);
  }
}

function renderFileGroupsSection(
  section: ToolFileGroupsSection,
): TemplateResult {
  // prettier-ignore
  const fileItems = html`${section.groups.flatMap((group) => group.files.map((file) => html`<li class="detail-item">${waIcon('file')} ${group.clickable ? buildFileLinkSpan(file, html`<bdi dir="auto">${file}</bdi>`) : html`<span class="file-label"><bdi dir="auto">${file}</bdi></span>`} <span class="file-source">(<bdi dir="auto">${group.label}</bdi>)</span></li>`))}`;
  return renderDetailList(section.label, fileItems);
}

function renderFileListSection(section: ToolFileListSection): TemplateResult {
  // prettier-ignore
  const fileItems = html`${section.files.map((file) => {
    const diffStats = file.lineChanges
      ? html` ${buildLineChangeStats(file.lineChanges)}`
      : nothing;
    // prettier-ignore
    return html`<li class="detail-item">${waIcon('file')} ${buildFileLinkSpan(file.path, html`<bdi dir="auto">${file.path}</bdi>`)}${file.from ? html` <span class="file-source">(from <bdi dir="auto">${file.from}</bdi>)</span>` : nothing}${file.note ? html` <span class="file-source">(<bdi dir="auto">${file.note}</bdi>)</span>` : nothing}${diffStats}</li>`;
  })}`;
  return renderDetailList(section.label, fileItems);
}

/** Paint one tool section. `filePath` is the most recent file section's path,
 *  used to resolve the `file` language hint on a following code section. */
function renderToolSection(
  section: ToolSection,
  filePath: string,
): TemplateResult {
  switch (section.kind) {
    case 'text':
      // The model measured the untruncated text; this surface turns a long
      // one (an MCP `Result:`, a multi-paragraph instruction) into a scroll
      // box rather than letting it push the rest of the card off screen.
      return buildToolUseSection(
        section.label,
        wrapInPre(
          section.text.full,
          section.text.lineCount > TEXT_SECTION_SCROLL_LINES
            ? 'tool-output-full'
            : '',
        ),
      );
    case 'code':
      return buildToolSection(section.label, section.text.full, {
        language: codeLanguage(section.language, filePath),
        ...(isCommandInput(section.language)
          ? { extraClass: 'tool-command-input' }
          : {}),
      });
    case 'identifier': {
      // prettier-ignore
      const note = section.note ? html` <span class="file-source">(<bdi dir="auto">${section.note}</bdi>)</span>` : nothing;
      // prettier-ignore
      return buildToolUseSection(section.label, html`<code class="run-id" dir="ltr">${section.value}</code>${note}`);
    }
    case 'file':
      return buildToolUseSection(section.label, renderFilePath(section));
    case 'fileGroups':
      return renderFileGroupsSection(section);
    case 'fileList':
      return renderFileListSection(section);
    case 'diff':
      return buildToolUseSection(
        section.label,
        buildEditDiffSection(section.oldText, section.newText),
      );
    case 'badges':
      // prettier-ignore
      return buildToolUseSection(section.label, html`${section.badges.map((badge) => buildStatusBadge('image', badge))}`);
    case 'status': {
      const status = TOOL_STATUS[section.status];
      return buildToolUseSection(
        section.label,
        buildStatusBadge(
          statusGlyph(status),
          status.word,
          section.status === 'in_progress',
        ),
      );
    }
    default:
      return absurd(section);
  }
}

/** Paint every section of a tool row, in model order. */
export function renderToolSections(
  sections: readonly ToolSection[],
): TemplateResult[] {
  let filePath = '';
  return sections.map((section) => {
    if (section.kind === 'file') filePath = section.path;
    return renderToolSection(section, filePath);
  });
}
