/**
 * The one request card every pending request renders as: a one-sentence ask,
 * the evidence the decision needs, and the same action row on every kind.
 *
 *   primary (y)  ·  optional ▾ "Approve all <kind> in this run" (a)
 *   ·  kind-specific secondaries  ·  Reject / Skip / Stop run (n)  ·  Add a note…
 *
 * The negative answers in one click; "Add a note…" opens an optional note
 * that rides on the same decision. Esc only closes that note: it never
 * answers a request.
 */

// Third-party imports
import {
  css,
  html,
  LitElement,
  nothing,
  type CSSResult,
  type CSSResultGroup,
  type TemplateResult,
} from 'lit';
import { property, query, state } from 'lit/decorators.js';

// Side-effect imports - register WA components used by the card
import '@awesome.me/webawesome/dist/components/button-group/button-group.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';

// Local imports - shared schemas
import type { PermissionPayload } from '@shared/schemas';
import {
  approvalDecisionArms,
  type SurfaceDecision,
} from '@shared/session/approvalDecision';
import type { RuntimeRequest } from '@shared/session/runtimeRequest';
import { SessionUiEvents } from '@shared/session/uiEvents';
import {
  commonViewStyles,
  designTokens,
  requestPanelSharedStyles,
} from '@ui/styles';
import type { TeXRAIconName } from '@ui/wa/iconNames';
import {
  renderLabeledActionButton,
  renderLabeledActionButtonParts,
} from '@ui/wa/actionButtons';
import {
  renderSplitButtonMenuParts,
  splitButtonTriggerStyles,
} from '@ui/wa/splitButton';

/** The three ways a card declines, each with its one word. */
const DECLINE_LABEL = {
  reject: 'Reject',
  skip: 'Skip',
  stop: 'Stop run',
} as const;

type Decline = keyof typeof DECLINE_LABEL;

/** A run-scoped grant the primary's ▾ menu offers: approve this request and
 *  stop asking about its kind for the rest of the run. */
export interface RunGrant {
  readonly label: string;
  /** What else the grant turns on, when the label alone undersells it. */
  readonly scope?: string;
  readonly decision: SurfaceDecision;
}

/** Card chrome shared by every panel; a panel appends its own rules. */
const requestCardHostStyles: CSSResult = css`
  :host {
    display: block;
  }
`;

export abstract class BaseRequestPanel<
  K extends PermissionPayload['kind'] = PermissionPayload['kind'],
> extends LitElement {
  static override styles: CSSResultGroup = [
    designTokens,
    commonViewStyles,
    splitButtonTriggerStyles,
    requestPanelSharedStyles,
    requestCardHostStyles,
  ];

  @property({ attribute: false }) permission!: Extract<
    PermissionPayload,
    { kind: K }
  >;

  /**
   * The stream's `readOnly` (PRD 5.2): another live owner holds it, it is
   * unreadable, or the surface is an archived export with no backend for a
   * decision to reach. The single chokepoint every action and keyboard
   * shortcut calls through (`emitAction`) no-ops here.
   */
  @property({ type: Boolean }) readOnly = false;

  /** Whether the optional note for the decline is open. */
  @state() protected noteOpen = false;

  @query('[data-note-input]')
  private noteInput?: HTMLElementTagNameMap['wa-textarea'];

  // ---------------------------------------------------------------------------
  // What a card declares
  // ---------------------------------------------------------------------------

  /** The one sentence at the top: what the agent wants, object named. */
  protected abstract renderAsk(): TemplateResult | string;

  /** The primary action's word: Approve, Submit, or Retry. */
  protected get primaryLabel(): string {
    return 'Approve';
  }

  protected get primaryIcon(): TeXRAIconName {
    return 'check';
  }

  /** Do the primary action (bound to y and the primary button). */
  protected abstract submitPrimary(): void;

  /** The negative's kind; its word comes from {@link DECLINE_LABEL}. */
  protected get decline(): Decline {
    return 'reject';
  }

  /** Whether the decline can carry a note the agent reads. */
  protected get declineTakesNote(): boolean {
    return this.decline !== 'stop';
  }

  /** The note box's label: what the agent should hear. */
  protected get notePrompt(): string {
    return 'What should the agent change?';
  }

  /** The run-scoped grant on the primary's ▾ menu, if the kind has one. */
  protected get grant(): RunGrant | null {
    return null;
  }

  /** Kind-specific keys (d, s, r, k …). */
  protected handleExtraKey(_key: string): boolean {
    return false;
  }

  // ---------------------------------------------------------------------------
  // Decisions
  // ---------------------------------------------------------------------------

  protected emitAction(decision: SurfaceDecision): void {
    if (this.readOnly) return;
    for (const arm of approvalDecisionArms(this.permission, decision)) {
      if ('host' in arm) this.dispatchEvent(SessionUiEvents.host(arm.host));
      else this.emitRuntimeArm(arm.runtime);
    }
  }

  /**
   * One runtime arm of a decision. A panel whose host answers a runtime arm
   * with a verb of its own (the tool-edit panel's approve/reject) overrides
   * this instead of re-implementing the loop and its gate above.
   */
  protected emitRuntimeArm(runtime: RuntimeRequest): void {
    this.dispatchEvent(SessionUiEvents.runtime(runtime));
  }

  private sendDecline(): void {
    const trimmed = this.noteOpen ? (this.noteInput?.value ?? '').trim() : '';
    const feedback = trimmed ? { feedback: trimmed } : {};
    this.noteOpen = false;
    switch (this.decline) {
      case 'reject':
        this.emitAction({ action: 'reject', ...feedback });
        return;
      case 'skip':
        this.emitAction({ action: 'skip', ...feedback });
        return;
      case 'stop':
        this.emitAction({ action: 'cancel' });
        return;
    }
  }

  /** Handle a keyboard shortcut routed from the container. True if handled. */
  handleKeyboardShortcut(key: string): boolean {
    if (this.readOnly) return false;
    switch (key) {
      case 'y':
        this.submitPrimary();
        return true;
      case 'a': {
        const grant = this.noteOpen ? null : this.grant;
        if (!grant) return false;
        this.emitAction(grant.decision);
        return true;
      }
      case 'n':
        this.sendDecline();
        return true;
      case 'escape':
        if (!this.noteOpen) return false;
        this.closeNote();
        return true;
      default:
        return this.handleExtraKey(key);
    }
  }

  // ---------------------------------------------------------------------------
  // The note
  // ---------------------------------------------------------------------------

  private openNote(): void {
    this.noteOpen = true;
    void this.updateComplete.then(() => this.noteInput?.focus());
  }

  private closeNote(): void {
    this.noteOpen = false;
    void this.updateComplete.then(() =>
      this.renderRoot
        .querySelector<HTMLElement>('wa-button[data-action="decline"]')
        ?.focus(),
    );
  }

  private handleNoteKeydown(event: KeyboardEvent): void {
    // The container ignores keys typed into a text field, so the field
    // handles its own two: Esc closes the note, Ctrl/Cmd+Enter sends it.
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.closeNote();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.sendDecline();
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  /**
   * The card: ask, details, one action row, and the note when open.
   * `secondary` holds the kind's own actions, which leave the request
   * pending unless their label says otherwise.
   */
  protected renderCard(
    details: TemplateResult | typeof nothing,
    secondary: TemplateResult | typeof nothing = nothing,
  ): TemplateResult {
    return html`
      <div class="request-card">
        <h3 class="request-card__ask">${this.renderAsk()}</h3>
        ${
          details === nothing
            ? nothing
            : html`<div class="request-card__details">${details}</div>`
        }
        <div class="request-card__actions">
          ${this.renderPrimary()} ${secondary} ${this.renderDecline()}
        </div>
        ${this.renderNote()}
      </div>
    `;
  }

  private renderPrimary(): TemplateResult {
    const grant = this.readOnly || this.noteOpen ? null : this.grant;
    // A native title, not a wa-tooltip: a new card focuses this button, and
    // a focus-shown tooltip would cover the evidence above it.
    const button = {
      icon: this.primaryIcon,
      text: this.primaryLabel,
      title: `${this.primaryLabel} (y)`,
      action: 'primary',
      disabled: this.readOnly,
      onClick: () => this.submitPrimary(),
    };
    if (!grant)
      return renderLabeledActionButton({ ...button, kind: 'primary' });

    const main = renderLabeledActionButtonParts({
      ...button,
      nativeChrome: true,
      appearance: 'accent',
      variant: 'brand',
    });
    const { menu, tooltip } = renderSplitButtonMenuParts({
      classPrefix: 'request-grant',
      triggerId: 'request-grant-trigger',
      triggerAriaLabel: 'More approve options',
      triggerAppearance: 'accent',
      triggerVariant: 'brand',
      tooltip: `${grant.scope ?? grant.label} (a)`,
      items: html`<wa-dropdown-item value="grant"
        >${grant.label}</wa-dropdown-item
      >`,
      onSelect: (value) => {
        if (value === 'grant') this.emitAction(grant.decision);
      },
    });
    return html`
      <wa-button-group
        class="request-card__primary split-group"
        label="Approve"
      >
        ${main.button} ${menu}
      </wa-button-group>
      ${tooltip}
    `;
  }

  private renderDecline(): TemplateResult {
    const label = DECLINE_LABEL[this.decline];
    return html`
      ${renderLabeledActionButton({
        icon: 'xmark',
        text: label,
        title: `${label} (n)`,
        action: 'decline',
        disabled: this.readOnly,
        onClick: () => this.sendDecline(),
      })}
      ${
        this.declineTakesNote && !this.noteOpen && !this.readOnly
          ? renderLabeledActionButton({
              text: 'Add a note…',
              kind: 'link',
              action: 'note',
              onClick: () => this.openNote(),
            })
          : nothing
      }
    `;
  }

  private renderNote(): TemplateResult | typeof nothing {
    if (!this.noteOpen) return nothing;
    const label = DECLINE_LABEL[this.decline];
    return html`
      <wa-textarea
        class="request-card__note"
        name="decline-note"
        label=${this.notePrompt}
        hint=${`Optional. Sent to the agent when you press ${label}.`}
        rows="2"
        resize="vertical"
        autocomplete="off"
        spellcheck="true"
        data-note-input
        @keydown=${this.handleNoteKeydown}
      ></wa-textarea>
    `;
  }
}
