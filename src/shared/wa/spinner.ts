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
  const pending = (host as { updateComplete?: Promise<unknown> })
    .updateComplete;
  if (pending) {
    void pending.then(
      () => adoptReducedMotion(host),
      (error: unknown) => {
        console.warn(
          'Failed to adopt reduced-motion style for wa-spinner',
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

/** Attach to every `<wa-spinner>` so its dash animation honors reduced motion. */
export const stopSpinnerMotion = directive(StopSpinnerMotionDirective);
