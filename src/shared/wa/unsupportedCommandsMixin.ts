/**
 * Lit mixin that declares the host capability-broadcast property used by
 * progress/settings UI to hide controls the active host cannot act on.
 *
 * Lives next to the other Lit UI helpers under `@shared/wa/`, not in
 * `@shared/utils/dispatcher`. The dispatcher is imported by schema modules
 * (host-neutral message routing); putting a value import of `lit` there
 * loads Lit into every `@shared/schemas` consumer — including Node unit tests
 * that install a jsdom `HTMLElement` only later. Custom-element classes then
 * extend the wrong-realm `HTMLElement` and `document.createElement` fails.
 */
import type { LitElement } from 'lit';
import { property } from 'lit/decorators.js';

/**
 * Declares the `unsupportedCommands` Lit property on a component: the set of
 * commands the active host's registry reports as `unsupported(...)` (see
 * `unsupportedCommands` in `@shared/utils/dispatcher`), threaded down once at
 * webview-ready. `null` before that broadcast arrives — checked via
 * `isKnownUnsupported`, which treats "not yet known" as unsupported so a
 * control never flashes visible then hidden.
 *
 * Every component that gates a control off the host's capability broadcast
 * declares this property; it lives here once instead of being copy-pasted
 * across components so the contract and its docstring cannot drift.
 */
type LitElementConstructor = new (...args: any[]) => LitElement;

export function UnsupportedCommandsMixin<T extends LitElementConstructor>(
  superClass: T,
) {
  class UnsupportedCommandsElement extends superClass {
    @property({ attribute: false })
    unsupportedCommands: ReadonlySet<string> | null = null;
  }
  return UnsupportedCommandsElement as T &
    (new (...args: any[]) => InstanceType<T> & {
      unsupportedCommands: ReadonlySet<string> | null;
    });
}
