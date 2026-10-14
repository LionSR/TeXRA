/**
 * Data-style formatter for file lists.
 * Uses Lit templates for declarative DOM construction.
 *
 * IMPORTANT: Lit templates preserve whitespace literally. Multi-line templates with
 * indentation will render with unwanted spaces in the output. Always use single-line
 * templates with `// prettier-ignore` to prevent whitespace issues.
 */

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/details/details.js';

// Third-party imports - Lit template utilities
import { html } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';

// Local imports - shared schemas and utilities
import type { FileListRow } from '@shared/transcript';

// Local imports - formatter helpers
import { buildDetailsSummary, buildFileListRender } from '../htmlBuilders';
import type { FormatResult } from '../baseLogFormatter';

/** Format file list entry as TemplateResult: an icon/label summary over a
 *  `<ul>` of file rows. */
export function formatFileListTemplate(row: FileListRow): FormatResult {
  // prettier-ignore
  return html`<wa-details appearance="plain" icon-placement="start" class="banner-details file-list-details">${buildDetailsSummary({
    iconName: 'file',
    label: row.summary,
    labelClass: 'summary-text',
  })}<ul class="file-list-content" data-log-id=${ifDefined(row.id)}>${buildFileListRender(row.files, row.media)}</ul></wa-details>`;
}
