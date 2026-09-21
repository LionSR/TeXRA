// Third-party imports
import { css, html, nothing, type CSSResult, type TemplateResult } from 'lit';

export type MetaPart = string | TemplateResult;

/** Render a compact one-line metadata strip with parts joined by " · ". */
export function renderDotMeta(parts: readonly MetaPart[]): TemplateResult {
  return html`${parts.map(
    (part, i) => html`${i > 0 ? html` · ` : nothing}${part}`,
  )}`;
}

export const metaStripStyles: CSSResult = css`
  .meta-strip {
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
    margin-top: var(--wa-space-3xs);
    display: flex;
    flex-wrap: wrap;
    gap: var(--wa-space-3xs) 0;
    align-items: center;
  }
`;
