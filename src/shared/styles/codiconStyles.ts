import { css, unsafeCSS, type CSSResult } from 'lit';

import codiconCss from '@vscode/codicons/dist/codicon.css?inline';

const iconClassesCss = codiconCss.replaceAll(/@font-face\s*\{[^}]+\}/g, '');

function getCodiconFontUri(): string {
  if (typeof window === 'undefined') return '';
  return (
    (window as { __CODICON_FONT_URI__?: string }).__CODICON_FONT_URI__ ?? ''
  );
}

export const codiconStyles: CSSResult = css`
  @font-face {
    font-family: 'codicon';
    font-display: block;
    src: url('${unsafeCSS(getCodiconFontUri())}') format('truetype');
  }
  ${unsafeCSS(iconClassesCss)}
`;

/**
 * Alias for codiconStyles — kept for backward compatibility.
 * The @font-face is harmless if duplicated (browsers deduplicate).
 */
export const codiconIconClasses: CSSResult = codiconStyles;
