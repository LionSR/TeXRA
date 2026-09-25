/**
 * The run's pending requests, one card each, oldest first.
 *
 * A run usually has one pending request, but an external inquiry does not
 * block the run, so an inquiry (or several) can wait beside a later
 * approval. Every card answers its own keys: single-character shortcuts
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
import type { PermissionPayload } from '@shared/schemas';
import {
  requestAnswerability,
  type RunView,
} from '@shared/session/sessionView';
import type { Surface } from '@shared/session/surface';

// Local imports - progress view component types
import type { BaseRequestPanel } from './BaseRequestPanel';

// Side-effect imports to register the cards
import './ToolEditRequestPanel';
import './BashRequestPanel';
import './RetryRequestPanel';
import './ProposalRequestPanel';
import './PlanApprovalRequestPanel';
import './ExternalInquiryPanel';
import './UserQuestionPanel';

/** The card element for each request kind. */
const CARD_TAG: Record<
  PermissionPayload['kind'],
  ReturnType<typeof literal>
> = {
  toolEdit: literal`tool-edit-request-panel`,
  bash: literal`bash-request-panel`,
  retry: literal`retry-request-panel`,
  proposal: literal`proposal-request-panel`,
  planApproval: literal`plan-approval-request-panel`,
  externalInquiry: literal`external-inquiry-panel`,
  userQuestion: literal`user-question-panel`,
};

/** Marks every rendered card so keyboard routing can find it. */
const CARD_MARKER = 'data-request-panel';

/**
 * Stable identity key for a pending request. Retry is keyed by `runId`
 * instead of `requestId`: one pending retry per run, a new one replaces it.
 */
function requestKey(permission: PermissionPayload): string {
  const id =
    permission.kind === 'retry'
      ? permission.data.runId
      : permission.data.requestId;
  return `${permission.kind}:${id}`;
}

/** True for a text field, looking through open shadow roots. */
function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return true;
  }
  if ((el as HTMLElement).isContentEditable) return true;
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

  @property({ attribute: false }) permissions: PermissionPayload[] = [];

  /** The run asking: each card reads whether this window can answer it. */
  @property({ attribute: false }) run: RunView | null = null;

  /** For the inquiry cards' drafts (`Surface.inquiryDrafts`). */
  @property({ attribute: false }) surface: Surface | null = null;

  /** Pending keys seen after the previous update — drives first-appearance focus. */
  private seenKeys = new Set<string>();

  constructor() {
    super();
    // Keyboard events are composed, so one listener on the host hears every
    // key pressed inside any card's shadow tree, and only those.
    this.addEventListener('keydown', this.handleKeydown);
  }

  override render(): TemplateResult | typeof nothing {
    if (this.permissions.length === 0) return nothing;
    return html`${repeat(
      this.permissions,
      requestKey,
      (permission) => staticHtml`<${CARD_TAG[permission.kind]}
        data-request-panel
        .permission=${permission}
        .answerability=${
          this.run ? requestAnswerability(this.run, permission) : 'readOnly'
        }
        .surface=${this.surface}
      ></${CARD_TAG[permission.kind]}>`,
    )}`;
  }

  /** Route a key to the card that holds focus; text fields keep their keys. */
  private handleKeydown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const path = event.composedPath();
    if (isTextInput((path[0] as Element | undefined) ?? null)) return;
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
    this.seenKeys = new Set(this.permissions.map(requestKey));
    const firstNew = this.permissions.find(
      (permission) => !previousKeys.has(requestKey(permission)),
    );
    if (!firstNew) return;
    const card = [
      ...this.renderRoot.querySelectorAll<BaseRequestPanel>(`[${CARD_MARKER}]`),
    ].find((element) => element.permission === firstNew);
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
