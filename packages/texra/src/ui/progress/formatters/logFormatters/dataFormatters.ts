/**
 * Data-style formatter for file lists.
 * Uses Lit templates for declarative DOM construction.
 */

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/details/details.js';

// Third-party imports - Lit template utilities
import { html } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';

// Local imports - shared schemas and utilities
import { buildDetailsCard, buildFileListRender } from '../htmlBuilders';
import type { FileListRow } from '@texra-ai/harness/transcript';

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
    body: html`<ul class="file-list-content" data-log-id=${ifDefined(row.id)}>${buildFileListRender(row.files)}</ul>`,
    classes: { 'file-list-details': true },
  });
}
