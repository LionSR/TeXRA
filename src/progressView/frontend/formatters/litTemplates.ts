/**
 * Lit-native template rendering utilities.
 *
 * These utilities allow formatters to use declarative Lit templates
 * instead of manual DOM manipulation, while still supporting the
 * streaming append pattern used by LogList.
 */

import { html, render, nothing, type TemplateResult } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { styleMap } from 'lit/directives/style-map.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { when } from 'lit/directives/when.js';

// Re-export directives for use in formatter templates
export {
  html,
  nothing,
  render,
  classMap,
  ifDefined,
  styleMap,
  unsafeHTML,
  when,
};
export type { TemplateResult };

/**
 * Render a Lit template to a detached HTMLElement.
 *
 * This bridges Lit's declarative templates with the imperative
 * append pattern used for streaming log content.
 *
 * @param template - A Lit TemplateResult
 * @returns The rendered HTMLElement, or null if rendering failed
 */
export function renderToElement(template: TemplateResult): HTMLElement | null {
  const container = document.createElement('div');
  render(template, container);
  const element = container.firstElementChild;
  return element instanceof HTMLElement ? element : null;
}

/**
 * Render a Lit template to a DocumentFragment.
 *
 * Use this when the template contains multiple root elements
 * or when you need to append multiple elements at once.
 *
 * @param template - A Lit TemplateResult
 * @returns A DocumentFragment containing the rendered content
 */
export function renderToFragment(template: TemplateResult): DocumentFragment {
  const container = document.createElement('div');
  render(template, container);
  const fragment = document.createDocumentFragment();
  while (container.firstChild) {
    fragment.appendChild(container.firstChild);
  }
  return fragment;
}
