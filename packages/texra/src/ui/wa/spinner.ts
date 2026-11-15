// Registers <wa-spinner> and stops both of its animations under
// prefers-reduced-motion. The spin lives on the svg (::part(base)); the dash
// stroke morph lives on the inner .indicator circle, which is not a part, so
// a host stylesheet cannot reach it. A Lit directive injects one style into
// the spinner shadow after its first render; `waSpinner()` is the only
// template that writes the element, so no spinner renders without it.

import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import { html, LitElement, nothing, type TemplateResult } from 'lit';
import { Directive, directive, type ElementPart } from 'lit/directive.js';
import { ifDefined } from 'lit/directives/if-defined.js';

const REDUCED_MOTION_STYLE_ATTR = 'data-texra-reduced-motion';
const REDUCED_MOTION_CSS = `@media (prefers-reduced-motion: reduce) {
  svg,
  .indicator {
    animation: none !important;
  }
}`;

function hasReducedMotionStyle(host: Element): boolean {
  return (
    host.shadowRoot?.querySelector(`style[${REDUCED_MOTION_STYLE_ATTR}]`) !=
    null
  );
}

function adoptReducedMotion(host: Element): void {
  const root = host.shadowRoot;
  if (root == null || hasReducedMotionStyle(host)) {
    return;
  }
  const style = document.createElement('style');
  style.setAttribute(REDUCED_MOTION_STYLE_ATTR, '');
  style.textContent = REDUCED_MOTION_CSS;
  root.append(style);
}

function scheduleAdopt(host: Element): void {
  if (host instanceof LitElement) {
    void host.updateComplete.then(
      () => adoptReducedMotion(host),
      (error: unknown) => {
        console.warn(
          '[spinner] Failed to adopt reduced-motion style for wa-spinner',
          error,
        );
      },
    );
    return;
  }
  queueMicrotask(() => adoptReducedMotion(host));
}

class StopSpinnerMotionDirective extends Directive {
  render(): typeof nothing {
    return nothing;
  }

  override update(part: ElementPart): typeof nothing {
    // The style marker is visible as soon as it is adopted. Skip the
    // updateComplete hop on later host commits so we do not request a
    // fresh spinner update on every progress-view re-render.
    if (!hasReducedMotionStyle(part.element)) {
      scheduleAdopt(part.element);
    }
    return nothing;
  }
}

const stopSpinnerMotion = directive(StopSpinnerMotionDirective);

/**
 * The one `<wa-spinner>` template: its dash animation honors reduced motion,
 * and it is hidden from assistive technology like a decorative `waIcon()`,
 * because every spinner stands beside the words that say what is running.
 */
export function waSpinner(className?: string): TemplateResult {
  // prettier-ignore
  return html`<wa-spinner class=${ifDefined(className)} aria-hidden="true" ${stopSpinnerMotion()}></wa-spinner>`;
}
