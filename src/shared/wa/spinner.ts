// Registers <wa-spinner> and stops both of its animations under
// prefers-reduced-motion. The spin lives on the svg (::part(base)); the dash
// stroke morph lives on the inner .indicator circle, which is not a part, so
// a host stylesheet cannot reach it. A Lit directive injects one style into
// the spinner shadow after its first render.

import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import { nothing } from 'lit';
import { Directive, directive, type ElementPart } from 'lit/directive.js';

const REDUCED_MOTION_STYLE_ATTR = 'data-texra-reduced-motion';
const REDUCED_MOTION_CSS = `@media (prefers-reduced-motion: reduce) {
  svg,
  .indicator {
    animation: none !important;
  }
}`;

function adoptReducedMotion(host: Element): void {
  const root = host.shadowRoot;
  if (
    root == null ||
    root.querySelector(`style[${REDUCED_MOTION_STYLE_ATTR}]`)
  ) {
    return;
  }
  const style = document.createElement('style');
  style.setAttribute(REDUCED_MOTION_STYLE_ATTR, '');
  style.textContent = REDUCED_MOTION_CSS;
  root.append(style);
}

function scheduleAdopt(host: Element): void {
  const pending = (host as { updateComplete?: Promise<unknown> })
    .updateComplete;
  if (pending) {
    void pending.then(() => adoptReducedMotion(host));
    return;
  }
  queueMicrotask(() => adoptReducedMotion(host));
}

class StopSpinnerMotionDirective extends Directive {
  render(): typeof nothing {
    return nothing;
  }

  override update(part: ElementPart): typeof nothing {
    scheduleAdopt(part.element);
    return nothing;
  }
}

/** Attach to every `<wa-spinner>` so its dash animation honors reduced motion. */
export const stopSpinnerMotion = directive(StopSpinnerMotionDirective);
