/**
 * The one request card every pending request renders as: a one-sentence ask,
 * the evidence the decision needs, and the same action row on every kind.
 *
 *   primary (y)  ·  optional ▾ "Approve all <kind> in this run" (a)
 *   ·  kind-specific secondaries  ·  Reject / Skip / Stop task (n)  ·  Add a note…
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
import { property, query } from 'lit/decorators.js';
import { live } from 'lit/directives/live.js';

// Side-effect imports - register WA components used by the card
import '@awesome.me/webawesome/dist/components/button-group/button-group.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import WaTextarea from '@awesome.me/webawesome/dist/components/textarea/textarea.js';

// Local imports - shared schemas
import {
  approvalDecisionDelivery,
  APPROVE_SESSION_ACTION,
  declineDecision,
  REQUEST_ACTIONS,
  type SurfaceDecision,
} from '@texra/shared/session/surfaceDecision';
import type { RequestDraft, Surface } from '@texra/shared/session/surface';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import type { IconName } from '@ui/wa/iconNames';
import { isSendChord } from '@ui/wa/keyActivation';
import {
  commonViewStyles,
  designTokens,
  requestPanelSharedStyles,
} from '@ui/styles';
import {
  renderLabeledActionButton,
  renderLabeledActionButtonParts,
} from '@ui/wa/actionButtons';
import {
  renderSplitButtonMenuParts,
  splitButtonTriggerStyles,
} from '@ui/wa/splitButton';
import {
  offeredGrant,
  type AnsweredBy,
  type RequestPayload,
  type RuntimeCommand,
} from '@texra-ai/harness/schemas';
import {
  DELEGATION_APPROVAL_COPY,
  runGrantLabel,
} from '@ui/copy/delegationApproval';
import {
  requestDeclineLabel,
  requestPrimaryLabel,
} from '@ui/copy/requestCards';

/** A run-scoped grant the primary's ▾ menu offers: approve this request and
 *  stop asking about its kind for the rest of the run. */
export interface RunGrant {
  readonly label: string;
  /** What else the grant turns on, when the label alone undersells it. */
  readonly scope?: string;
  /** What the grant sends, when it carries more than the run grant itself
   *  (an agent proposal's picked model). */
  readonly decision?: SurfaceDecision;
}

/** Card chrome shared by every panel; a panel appends its own rules. */
const requestCardHostStyles: CSSResult = css`
  :host {
    display: block;
  }
`;

const EMPTY_DRAFT: RequestDraft = Object.freeze({});

export abstract class BaseRequestPanel<
  K extends RequestPayload['kind'] = RequestPayload['kind'],
> extends LitElement {
  static override styles: CSSResultGroup = [
    designTokens,
    commonViewStyles,
    splitButtonTriggerStyles,
    requestPanelSharedStyles,
    requestCardHostStyles,
  ];

  @property({ attribute: false }) permission!: Extract<
    RequestPayload,
    { kind: K }
  >;

  /** Who answers the request, as it opened (`PendingRequest.answeredBy`):
   *  the grant the primary's ▾ menu offers, none for a person's. */
  @property({ attribute: false }) answeredBy: AnsweredBy = 'person';

  /** The surface whose `requestDrafts` keeps what is entered on this card
   *  and not yet sent, so a run switch does not lose it. */
  @property({ attribute: false }) surface: Surface | null = null;

  /** What is entered on this card and not yet sent. */
  protected get draft(): RequestDraft {
    return (
      this.surface?.requestDrafts.get(this.permission.data.requestId) ??
      EMPTY_DRAFT
    );
  }

  /** Store the card's draft; an empty one is none. */
  protected writeDraft(draft: RequestDraft): void {
    this.dispatchEvent(
      SessionUiEvents.surface({
        kind: 'requestDraft',
        key: this.permission.data.requestId,
        draft: Object.keys(draft).length === 0 ? null : draft,
      }),
    );
  }

  /** Whether the optional note for the decline is open. */
  private get noteOpen(): boolean {
    return this.draft.note !== undefined;
  }

  @query('[data-note-input]')
  private noteInput?: HTMLElementTagNameMap['wa-textarea'];

  // ---------------------------------------------------------------------------
  // What a card declares
  // ---------------------------------------------------------------------------

  /** The one sentence at the top: what the agent wants, object named. */
  protected abstract renderAsk(): TemplateResult | string;

  protected get primaryIcon(): IconName {
    return 'check';
  }

  /** Do the primary action (bound to y and the primary button): the
   *  kind's `y` answer, unless the card builds its answer from a form. */
  protected submitPrimary(): void {
    const actions = REQUEST_ACTIONS[this.permission.kind];
    if ('y' in actions) this.emitAction(actions.y);
  }

  /** The note box's label: what the agent should hear. */
  protected get notePrompt(): string {
    return 'What should the agent change?';
  }

  /** The run-scoped grant on the primary's ▾ menu: the one that answers the
   *  request (`offeredGrant`), none when a person answers it. The
   *  delegated-work grant's scope names the edits and commands it also
   *  turns on. */
  protected get grant(): RunGrant | null {
    const kind = offeredGrant(this);
    if (kind === null) return null;
    return {
      label: runGrantLabel(kind),
      ...(kind === 'superYolo' && {
        scope: DELEGATION_APPROVAL_COPY.progressViewToggle,
      }),
    };
  }

  /** Kind-specific keys (d, s, r, k …). */
  protected handleExtraKey(_key: string): boolean {
    return false;
  }

  // ---------------------------------------------------------------------------
  // Decisions
  // ---------------------------------------------------------------------------

  /** Send a decision. The draft stays until the runtime accepts it
   *  (`applyRuntimeAnswer`), so a send that fails can be sent again. */
  protected emitAction(decision: SurfaceDecision): void {
    const delivery = approvalDecisionDelivery(
      { payload: this.permission, answeredBy: this.answeredBy },
      decision,
    );
    if ('host' in delivery)
      this.dispatchEvent(SessionUiEvents.host(delivery.host));
    else this.sendRuntimeDecision(delivery.runtime);
  }

  /**
   * Send a decision's runtime request. A panel whose host answers it with a verb
   * of its own (the tool-edit panel's approve) overrides this instead of
   * re-implementing `emitAction`'s read-only check and host dispatch.
   */
  protected sendRuntimeDecision(runtime: RuntimeCommand): void {
    this.dispatchEvent(SessionUiEvents.runtime(runtime));
  }

  private sendDecline(): void {
    const feedback = this.draft.note?.trim() || undefined;
    this.emitAction(declineDecision(this.permission.kind, feedback));
  }

  /** Handle a keyboard shortcut routed from the container. True if handled. */
  handleKeyboardShortcut(key: string): boolean {
    switch (key) {
      case 'y':
        this.submitPrimary();
        return true;
      case 'a': {
        const grant = this.noteOpen ? null : this.grant;
        if (!grant) return false;
        this.emitAction(grant.decision ?? { action: APPROVE_SESSION_ACTION });
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

  /** Set when the person opens the note: the field takes focus once the
   *  surface's draft has opened it here. */
  private focusNote = false;

  private openNote(): void {
    this.focusNote = true;
    this.writeDraft({ ...this.draft, note: '' });
  }

  protected override updated(): void {
    const note = this.noteInput;
    if (this.focusNote && note) {
      this.focusNote = false;
      void note.updateComplete.then(() => note.focus());
    }
  }

  private closeNote(): void {
    const { note: _closed, ...rest } = this.draft;
    this.writeDraft(rest);
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
    } else if (isSendChord(event)) {
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
    const grant = this.noteOpen ? null : this.grant;
    // A native title, not a wa-tooltip: a new card focuses this button, and
    // a focus-shown tooltip would cover the evidence above it.
    const primaryLabel = requestPrimaryLabel(this.permission.kind);
    const button = {
      icon: this.primaryIcon,
      text: primaryLabel,
      title: `${primaryLabel} (y)`,
      action: 'primary',
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
      tooltip: `${grant.scope ?? grant.label} (a)`,
      items: [
        {
          label: grant.label,
          activate: () =>
            this.emitAction(
              grant.decision ?? { action: APPROVE_SESSION_ACTION },
            ),
        },
      ],
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
    const label = requestDeclineLabel(this.permission.kind);
    // A decline that stops the run carries no note the agent would read.
    const takesNote = REQUEST_ACTIONS[this.permission.kind].n !== 'stop';
    return html`
      ${renderLabeledActionButton({
        icon: 'xmark',
        text: label,
        title: `${label} (n)`,
        action: 'decline',
        onClick: () => this.sendDecline(),
      })}
      ${
        takesNote && !this.noteOpen
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
    const label = requestDeclineLabel(this.permission.kind);
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
        .value=${live(this.draft.note ?? '')}
        @input=${(event: Event) => {
          const field = event.currentTarget;
          if (field instanceof WaTextarea) {
            this.writeDraft({ ...this.draft, note: field.value ?? '' });
          }
        }}
        @keydown=${this.handleNoteKeydown}
      ></wa-textarea>
    `;
  }
}
