/**
 * Data-style formatter for file lists.
 * Uses Lit templates for declarative DOM construction.
 */

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/details/details.js';

// Third-party imports - Lit template utilities
import { html } from 'lit';

// Local imports - shared schemas and utilities
import { buildDetailsCard, buildFileListRender } from '../htmlBuilders';
import type { FileListRow } from '@texra-ai/worldline/transcript';

// Local imports - formatter helpers
import type { FormatResult } from '../baseLogFormatter';

/** Format file list entry as TemplateResult: an icon/label summary over a
 *  `<ul>` of file rows. */
export function formatFileListTemplate(row: FileListRow): FormatResult {
  return buildDetailsCard({
    summary: {
      iconName: 'file',
      label: row.summary,
      labelClass: 'summary-text',
    },
    // prettier-ignore
    body: html`<ul class="file-list-content">${buildFileListRender(row.files)}</ul>`,
    classes: { 'file-list-details': true },
  });
}
