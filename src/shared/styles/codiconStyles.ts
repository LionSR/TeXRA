import { css, unsafeCSS, type CSSResult } from 'lit';

import codiconCss from '@vscode/codicons/dist/codicon.css?inline';

declare global {
  interface Window {
    __CODICON_FONT_URI__?: string;
  }
}

function getCodiconFontUri(): string {
  return typeof window !== 'undefined'
    ? (window.__CODICON_FONT_URI__ ?? '')
    : '';
}

function stripFontFace(cssText: string): string {
  return cssText.replaceAll(/@font-face\s*\{[^}]+\}/g, '');
}

function createCodiconStyles(): CSSResult {
  const fontUri = getCodiconFontUri();
  const iconClasses = stripFontFace(codiconCss);

  return css`
    @font-face {
      font-family: 'codicon';
      font-display: block;
      src: url('${unsafeCSS(fontUri)}') format('truetype');
    }
    ${unsafeCSS(iconClasses)}
  `;
}

/**
 * Codicon styles with font-face for shadow DOM components.
 */
export const codiconStyles: CSSResult = createCodiconStyles();

/**
 * Codicon icon classes without font-face (for light DOM usage).
 */
export const codiconIconClasses: CSSResult = css`
  ${unsafeCSS(stripFontFace(codiconCss))}
`;
