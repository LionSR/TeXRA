/**
 * Lit-native template rendering utilities.
 *
 * Provides type definitions and re-exports for Lit template usage
 * in progress view formatters.
 */

import { html, nothing, type TemplateResult } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { when } from 'lit/directives/when.js';

/** Result type for formatters that return Lit templates directly. */
export type FormatResult = TemplateResult | null;

// Re-export directives for use in formatter templates
export { html, nothing, classMap, ifDefined, repeat, unsafeHTML, when };
export type { TemplateResult };
