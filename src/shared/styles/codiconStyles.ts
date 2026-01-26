/**
 * Codicon styles for Lit shadow DOM components.
 *
 * This module provides codicon icon styles that can be used in Lit components
 * with shadow DOM encapsulation. The font URI is dynamically injected by the
 * webview provider via window.__CODICON_FONT_URI__.
 *
 * @example
 * import { codiconStyles } from '@shared/styles/codiconStyles';
 *
 * class MyComponent extends LitElement {
 *   static styles = [codiconStyles, css`...`];
 * }
 */

import { css, unsafeCSS, type CSSResult } from 'lit';

// Import the full codicon CSS as string
import codiconCss from '@vscode/codicons/dist/codicon.css?inline';

// Declare the global font URI injected by the webview HTML
declare global {
  interface Window {
    __CODICON_FONT_URI__?: string;
  }
}

/**
 * Get the codicon font URI from the webview context.
 * Falls back to empty string if not available.
 */
function getCodiconFontUri(): string {
  return typeof window !== 'undefined' ? (window.__CODICON_FONT_URI__ ?? '') : '';
}

/**
 * Strip the @font-face declaration from the codicon CSS.
 * We provide our own with the correct webview URI.
 */
function stripFontFace(cssText: string): string {
  return cssText.replaceAll(/@font-face\s*\{[^}]+\}/g, '');
}

/**
 * Create the codicon styles with the correct font URI.
 * This is called once when the module loads.
 */
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
 * Codicon styles for use in Lit components with shadow DOM.
 * Includes the font-face declaration and all icon class definitions.
 */
export const codiconStyles: CSSResult = createCodiconStyles();

/**
 * Just the codicon icon classes without font-face.
 * Use this when the font is already loaded at the document level
 * (e.g., in light DOM or when sharing styles).
 */
export const codiconIconClasses: CSSResult = css`
  ${unsafeCSS(stripFontFace(codiconCss))}
`;
