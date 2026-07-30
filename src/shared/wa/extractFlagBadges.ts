// Third-party imports
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared
import type { ToolConfig } from '@shared/schemas/toolConfig';

// Local imports - Web Awesome
import { waIcon } from './webAwesomeIcons';

/**
 * Render the badge row for a workflow proposal's media-extraction flags.
 * Returns `nothing` when no flag is set; callers wrap the badges in their
 * own container element for component-specific layout classes.
 */
export function renderWorkflowExtractFlagBadges(
  toolConfig: ToolConfig,
): TemplateResult | typeof nothing {
  const flags: string[] = [];
  if (toolConfig.autoExtractFigure) flags.push('Extract Figures');
  if (toolConfig.autoExtractTikzFigure) flags.push('Extract TikZ');
  if (flags.length === 0) return nothing;
  return html`${repeat(
    flags,
    (flag) => flag,
    (flag) =>
      html`<wa-badge variant="neutral" appearance="filled"
        >${waIcon('image')} ${flag}</wa-badge
      >`,
  )}`;
}
