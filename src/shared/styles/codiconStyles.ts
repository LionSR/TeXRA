/**
 * Codicon styles for Lit shadow DOM components.
 *
 * The codicon font is loaded at document level via VS Code's webview URI system.
 * This module provides the icon class definitions that can be used in shadow DOM
 * components. The font-family inherits from the document level.
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

/**
 * Strip the @font-face declaration from the codicon CSS.
 * The font is loaded at document level, so we don't need it in shadow DOM.
 */
function stripFontFace(cssText: string): string {
  return cssText.replaceAll(/@font-face\s*\{[^}]+\}/g, '');
}

/**
 * Codicon styles for use in Lit components with shadow DOM.
 *
 * Includes:
 * - Font-face that inherits from document level (or uses fallback URI)
 * - All icon class definitions (.codicon, .codicon-*, etc.)
 *
 * The font is loaded at document level by the webview HTML, so shadow DOM
 * components can reference it by font-family name.
 */
export const codiconStyles: CSSResult = css`
  /*
   * Font-face declaration for shadow DOM.
   * Uses the same font-family name as the document-level font.
   * The browser will use the already-loaded font from document level.
   */
  @font-face {
    font-family: 'codicon';
    font-display: block;
    /* Inherit from document - browser finds the font loaded at document level */
    src: local('codicon');
  }
  ${unsafeCSS(stripFontFace(codiconCss))}
`;

/**
 * Just the codicon icon classes without font-face.
 * Use this when the font is already loaded at the document level
 * and you want minimal CSS in shadow DOM.
 */
export const codiconIconClasses: CSSResult = css`
  ${unsafeCSS(stripFontFace(codiconCss))}
`;
