/**
 * Painter for the structured tool sections a `ToolRowModel` carries.
 *
 * Which sections a call produces — its file links, diffs, agent identifiers,
 * MCP structured content, and the generic input fallback — is decided once in
 * `@shared/transcript` (`toolRowModel`). This module only turns those data
 * sections into Lit templates, and picks the two presentation details the
 * model deliberately leaves to a host: the highlight language behind the
 * `file`/`shell` hints, and the glyph on a badge.
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
  triStateStatusIcon,
} from '@progressView/frontend/formatters/htmlBuilders';
import {
  TOOL_CODE_LANGUAGES,
  getLanguageFromPath,
} from '@progressView/frontend/formatters/constants';
import type {
  ToolChecklistSection,
  ToolFileGroupsSection,
  ToolFileListSection,
  ToolFileSection,
  ToolSection,
} from '@shared/transcript';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { assertNever } from '@utils/core';

import { buildToolSection } from './helpers';

/** Line count past which a text section becomes a fixed-height scroll box. */
const TEXT_SECTION_SCROLL_LINES = 20;

/**
 * Resolve the highlight language for a code section. `file` and `shell` are
 * the model's two deferred hints: the first means "whatever this file is",
 * the second "this tool's shell dialect".
 */
function codeLanguage(
  language: string,
  toolName: string,
  filePath: string,
): string {
  if (language === 'file') return getLanguageFromPath(filePath);
  if (language === 'shell') return TOOL_CODE_LANGUAGES.get(toolName) ?? 'bash';
  return language;
}

/**
 * A code section carrying the call's own source — a shell command or a
 * workflow script — wraps instead of scrolling sideways, so a long one-liner
 * stays readable inside the card.
 */
function isCommandInput(language: string): boolean {
  return language === 'shell' || language === 'javascript';
}

function renderFileSection(section: ToolFileSection): TemplateResult {
  switch (section.namespace) {
    case 'memory':
      return buildToolUseSection(
        section.label,
        buildMemoryPathDisplay(section.path),
      );
    case 'execution':
      return buildToolUseSection(
        section.label,
        buildExecutionsPathDisplay(section.path),
      );
    case 'workspace':
      return buildToolUseSection(
        section.label,
        buildFileLinkWithLines(section.path, {
          startLine: section.startLine,
          endLine: section.endLine,
        }),
      );
    default:
      return assertNever(section.namespace, 'Unhandled tool file namespace');
  }
}

function renderFileGroupsSection(
  section: ToolFileGroupsSection,
): TemplateResult {
  // prettier-ignore
  const fileItems = html`${section.groups.flatMap((group) => group.files.map((file) => html`<li class="detail-item">${waIcon('file')} <span class="${group.clickable ? 'file-link clickable-link' : 'file-label'}" data-file=${ifDefined(group.clickable ? file : undefined)} role=${ifDefined(group.clickable ? 'button' : undefined)} tabindex=${ifDefined(group.clickable ? '0' : undefined)}>${file}</span> <span class="file-source">(${group.label})</span></li>`))}`;
  // prettier-ignore
  return buildToolUseSection(section.label, html`<ul class="detail-list">${fileItems}</ul>`);
}

function renderFileListSection(section: ToolFileListSection): TemplateResult {
  // prettier-ignore
  const fileItems = html`${section.files.map((file) => {
    const diffStats = file.lineChanges
      ? html` <span class="file-stats"><span class="added">+${file.lineChanges.added}</span><span class="removed">-${file.lineChanges.removed}</span></span>`
      : nothing;
    // prettier-ignore
    return html`<li class="detail-item">${waIcon('file')} ${buildFileLinkSpan(file.path, file.path)}${file.from ? html` <span class="file-source">(from ${file.from})</span>` : nothing}${file.note ? html` <span class="file-source">(${file.note})</span>` : nothing}${diffStats}</li>`;
  })}`;
  // prettier-ignore
  return buildToolUseSection(section.label, html`<ul class="detail-list">${fileItems}</ul>`);
}

function renderChecklistSection(section: ToolChecklistSection): TemplateResult {
  // prettier-ignore
  const items = html`${section.items.map((item) => html`<li class="detail-item">${waIcon(item.done ? 'circle-check' : 'circle')} <span>${item.text}</span></li>`)}`;
  // prettier-ignore
  return buildToolUseSection(section.label, html`<ul class="detail-list">${items}</ul>`);
}

/** Paint one tool section. `filePath` is the most recent file section's path,
 *  used to resolve the `file` language hint on a following code section. */
function renderToolSection(
  section: ToolSection,
  toolName: string,
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
        toolName,
        language: codeLanguage(section.language, toolName, filePath),
        ...(isCommandInput(section.language)
          ? { extraClass: 'tool-command-input' }
          : {}),
      });
    case 'identifier': {
      // prettier-ignore
      const note = section.note ? html` <span class="file-source">(${section.note})</span>` : nothing;
      // prettier-ignore
      return buildToolUseSection(section.label, html`<code class="execution-id">${section.value}</code>${note}`);
    }
    case 'file':
      return renderFileSection(section);
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
    case 'status':
      return buildToolUseSection(
        section.label,
        buildStatusBadge(
          triStateStatusIcon(section.status, 'in_progress'),
          section.status,
        ),
      );
    case 'checklist':
      return renderChecklistSection(section);
    default:
      return assertNever(section, 'Unhandled tool section kind');
  }
}

/** Paint every section of a tool row, in model order. */
export function renderToolSections(
  sections: readonly ToolSection[],
  toolName: string,
): TemplateResult[] {
  let filePath = '';
  return sections.map((section) => {
    if (section.kind === 'file') filePath = section.path;
    return renderToolSection(section, toolName, filePath);
  });
}
