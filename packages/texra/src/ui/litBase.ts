// The base classes every webview component extends, so a component names
// only its own rules. Both hosts (the extension webview, the desktop
// renderer) and the trace viewer mount these components, and each one adopts
// the design-token sheet and the common view chrome; composing them once here
// is the one home for that shared sheet and for any behaviour every component
// should share. A subclass adds its own styles with
// `static override styles = [TexraElement.styles, css\`…\`]` — Lit flattens the
// nested group, so the adopted stylesheets are the token sheet, the common
// view chrome, then the component's own, exactly as spelling the three out did.

// Third-party imports
import { SignalWatcher } from '@lit-labs/signals';
import { LitElement, type CSSResultGroup } from 'lit';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@ui/styles';

/** The token sheet and common view chrome every component adopts. */
const baseStyles: CSSResultGroup = [designTokens, commonViewStyles];

/** Base for a webview component: adopts the shared token and view sheets. */
export class TexraElement extends LitElement {
  static override styles: CSSResultGroup = baseStyles;
}

/** `TexraElement` that also re-renders when a signal it reads changes. */
export class TexraSignalElement extends SignalWatcher(TexraElement) {}
