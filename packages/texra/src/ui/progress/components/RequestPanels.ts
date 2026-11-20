/**
 * The run's pending requests, one card each, oldest first.
 *
 * A run usually has one pending request, but several can wait at once.
 * Every card answers its own keys: single-character shortcuts
 * (y, a, n, d, …) fire only while focus is inside a card (WCAG 2.1.4), and
 * act on that card. So the shortcuts are reachable, a newly appeared request
 * moves focus to its primary action unless the user is typing elsewhere.
 */

// Third-party imports
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { html as staticHtml, literal } from 'lit/static-html.js';

// Local imports - shared schemas
import {
  type PendingRequest,
  type RequestPayload,
} from '@texra-ai/harness/schemas';
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import type { Surface } from '@texra/shared/session/surface';
import type { RunView } from '@texra-ai/harness/schemas';

// Local imports - progress view component types
import type { BaseRequestPanel } from './BaseRequestPanel';

// Side-effect imports to register the cards
import './ToolEditRequestPanel';
import './BashRequestPanel';
import './RetryRequestPanel';
import './ProposalRequestPanel';
import './PlanApprovalRequestPanel';
import './UserQuestionPanel';
import './PluginTrustRequestPanel';

type CardTag = ReturnType<typeof literal>;

/** The card element for each request kind. */
const CARD_TAG: Record<RequestPayload['kind'], CardTag> = {
  toolEdit: literal`tool-edit-request-panel`,
  bash: literal`bash-request-panel`,
  retry: literal`retry-request-panel`,
  proposal: literal`proposal-request-panel`,
  planApproval: literal`plan-approval-request-panel`,
  userQuestion: literal`user-question-panel`,
  pluginTrust: literal`plugin-trust-request-panel`,
};

/** Marks every rendered card so keyboard routing can find it. */
const CARD_MARKER = 'data-request-panel';

/** A pending request's identity: its id, a retry's as any other's. */
const requestKey = (request: PendingRequest): string => request.requestId;

/** A select and its listbox options: their keys (typeahead, arrows)
 *  pick an option, never a card shortcut. */
const CHOOSER = /^wa-(select|option)$/;

/** True for a text field, looking through open shadow roots. */
function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return true;
  }
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  const tagName = el.tagName.toLowerCase();
  if (tagName.includes('textarea') || tagName.includes('input')) return true;
  return isTextInput(el.shadowRoot?.activeElement ?? null);
}

@customElement('request-panels')
export class RequestPanels extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--wa-space-xs);
      margin-block: var(--wa-space-xs);
    }
  `;

  @property({ attribute: false }) requests: readonly PendingRequest[] = [];

  /** The run asking: each card reads whether this window can answer it. */
  @property({ attribute: false }) run: RunView | null = null;

  /** For every card's unsent answer (`Surface.requestDrafts`). */
  @property({ attribute: false }) surface: Surface | null = null;

  /** For the proposal card's agent and model pickers. */
  @property({ attribute: false }) host: HostSnapshot | null = null;

  /** Pending keys seen after the previous update — drives first-appearance focus. */
  private seenKeys = new Set<string>();

  constructor() {
    super();
    // Keyboard events are composed, so one listener on the host hears every
    // key pressed inside any card's shadow tree, and only those.
    this.addEventListener('keydown', this.handleKeydown);
  }

  override render(): TemplateResult | typeof nothing {
    if (this.requests.length === 0) return nothing;
    return html`${repeat(this.requests, requestKey, (request) => {
      const permission = request.payload;
      const tag = CARD_TAG[permission.kind];
      return staticHtml`<${tag}
        data-request-panel
        .permission=${permission}
        .answeredBy=${request.answeredBy}
        .surface=${this.surface}
        .host=${this.host}
        .run=${this.run}
      ></${tag}>`;
    })}`;
  }

  /** Route a key to the card that holds focus; text fields and choosers
   *  keep their keys. */
  private handleKeydown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const path = event.composedPath();
    const [origin] = path;
    if (isTextInput(origin instanceof Element ? origin : null)) return;
    if (path.some((t) => t instanceof Element && CHOOSER.test(t.localName)))
      return;
    const card = path.find(
      (target): target is BaseRequestPanel =>
        target instanceof Element && target.hasAttribute(CARD_MARKER),
    );
    if (card?.handleKeyboardShortcut(event.key.toLowerCase())) {
      event.preventDefault();
    }
  };

  /**
   * Move keyboard focus to a newly appeared request's primary action, once
   * per pending key. Never while the user is typing in a text control
   * elsewhere, and never when focus is already inside a card (a second
   * arrival must not yank focus away mid-decision).
   */
  protected override updated(): void {
    const previousKeys = this.seenKeys;
    this.seenKeys = new Set(this.requests.map(requestKey));
    const firstNew = this.requests.find(
      (request) => !previousKeys.has(requestKey(request)),
    );
    if (!firstNew) return;
    const card = [
      ...this.renderRoot.querySelectorAll<BaseRequestPanel>(`[${CARD_MARKER}]`),
    ].find((element) => element.permission === firstNew.payload);
    if (!card) return;
    // The card was just connected in this render pass; its first Lit update
    // is a microtask that cannot run until this `updated()` returns.
    void card.updateComplete.then(() => {
      if (isTextInput(document.activeElement)) return;
      if (this.matches(':focus-within')) return;
      const target =
        card.shadowRoot?.querySelector<HTMLElement>(
          '[data-action="primary"]',
        ) ?? card;
      if (target === card) card.tabIndex = -1;
      target.focus();
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'request-panels': RequestPanels;
  }
}
