/**
 * Lightweight container for permission request panels.
 *
 * Groups permissions by kind and renders section headers with
 * individual panel components. Manages keyboard shortcuts
 * (y=approve, n=reject, d=diff, r=retry, s=setup, Esc=dismiss)
 * by delegating to the panel matching the newest permission in the queue.
 * Single-character shortcuts fire only while focus is inside this component
 * (WCAG 2.1.4); see handleGlobalKeydown for the rationale. So those
 * shortcuts are actually reachable, a newly appeared request moves keyboard
 * focus to its primary action unless the user is typing elsewhere
 * (`updated` → `focusPanel`).
 */

// Third-party imports
import {
  LitElement,
  css,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { consume } from '@lit/context';
import { customElement, property, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import { repeat } from 'lit/directives/repeat.js';
import { html as staticHtml, literal } from 'lit/static-html.js';

// Side-effect imports - register WA icon, button, and tooltip components
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared styles
import {
  commonViewStyles,
  designTokens,
  requestPanelSharedStyles,
} from '@shared/styles';

// Local imports - shared schemas
import type { PermissionPayload, StreamTabId } from '@shared/schemas';

// Local imports - shared utilities
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

// Local imports - progress view helpers
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { groupBy } from '@utils/core';
import { isTextInput, selectExternalInquiryKey } from './RequestPanelsState';
import { getPermissionKey } from '../permissionState';
import { streamDisplayLabel } from '../utils';

// Local imports - progress view contexts
import {
  EMPTY_STREAM_BY_ID,
  permissionsContext,
  streamByIdContext,
  type StreamByIdMap,
} from '../streamContexts';

// Local imports - progress view component types
import type { ApproveSplitButton } from './ApproveSplitButton';
import type { BaseRequestPanel } from './BaseRequestPanel';

// Side-effect imports to register sub-panel custom elements
import './ToolEditRequestPanel';
import './BashRequestPanel';
import './RetryRequestPanel';
import './ProposalRequestPanel';
import './PlanApprovalRequestPanel';
import './ExternalInquiryPanel';
import './UserQuestionPanel';

/** One section per permission kind: its chrome and the element rendering it. */
interface SectionConfig {
  readonly kind: PermissionPayload['kind'];
  readonly tag: ReturnType<typeof literal>;
  readonly cssClass: string;
  readonly icon: TeXRAIconName;
  readonly title: string;
}

/** Sections in render order — one row per permission kind. */
const SECTIONS: readonly SectionConfig[] = [
  {
    kind: PERMISSION_KIND.TOOL_EDIT,
    tag: literal`tool-edit-request-panel`,
    cssClass: 'approval-requests',
    icon: 'code-compare',
    title: 'Tool edit approval',
  },
  {
    kind: PERMISSION_KIND.BASH,
    tag: literal`bash-request-panel`,
    cssClass: 'bash-approval-requests',
    icon: 'terminal',
    title: 'Command approval',
  },
  {
    kind: PERMISSION_KIND.RETRY,
    tag: literal`retry-request-panel`,
    cssClass: 'retry-requests',
    icon: 'rotate-right',
    title: 'Retry request',
  },
  {
    kind: PERMISSION_KIND.PROPOSAL,
    tag: literal`proposal-request-panel`,
    cssClass: 'workflow-proposals',
    icon: 'rocket',
    title: 'Agent proposal',
  },
  {
    kind: PERMISSION_KIND.PLAN_APPROVAL,
    tag: literal`plan-approval-request-panel`,
    cssClass: 'plan-approval-requests',
    icon: 'list-check',
    title: 'Plan approval',
  },
  {
    kind: PERMISSION_KIND.EXTERNAL_INQUIRY,
    tag: literal`external-inquiry-panel`,
    cssClass: 'external-inquiry-requests',
    icon: 'globe',
    title: 'External inquiry',
  },
  {
    kind: PERMISSION_KIND.USER_QUESTION,
    tag: literal`user-question-panel`,
    cssClass: 'user-question-requests',
    icon: 'circle-question',
    title: 'Question',
  },
];

/**
 * Marks every rendered panel so keyboard delegation can find them without a
 * second list of element names to keep in sync with `SECTIONS`.
 */
const PANEL_MARKER_SELECTOR = '[data-request-panel]';

function externalInquiryKeys(
  permissions: readonly PermissionPayload[],
): string[] {
  return permissions
    .filter(
      (permission) => permission.kind === PERMISSION_KIND.EXTERNAL_INQUIRY,
    )
    .map(getPermissionKey);
}

@customElement('request-panels')
export class RequestPanels extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    requestPanelSharedStyles,
    css`
      /* Run caption above each request, only rendered when approvals span
         more than one run (see renderRequest). */
      .request-run-group__label {
        margin-block-end: var(--wa-space-3xs);
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
      }
    `,
  ];

  @property({ attribute: false }) permissions: PermissionPayload[] = [];

  /** Canonical selection for the external-inquiry carousel. */
  @state() private selectedExternalInquiryKey: string | null = null;

  /** Run metadata for captioning requests when several runs wait at once. */
  @consume({ context: streamByIdContext, subscribe: true })
  @state()
  private streamById: StreamByIdMap = EMPTY_STREAM_BY_ID;

  /**
   * All pending permissions across streams. `permissions` is already scoped to
   * the active stream, so multi-run captions must read this unfiltered list —
   * otherwise `runIds.size > 1` can never become true.
   */
  @consume({ context: permissionsContext, subscribe: true })
  @state()
  private allPermissions: PermissionPayload[] = [];

  /** Memoized permission groups - recomputed in willUpdate() when permissions change. */
  private permissionsByKind: ReadonlyMap<
    PermissionPayload['kind'],
    PermissionPayload[]
  > = new Map();

  /** True when pending requests belong to more than one identified run. */
  private multiRunPending = false;

  /** Pending keys seen after the previous update — drives first-appearance focus. */
  private seenPermissionKeys = new Set<string>();

  protected override willUpdate(changedProperties: PropertyValues): void {
    if (changedProperties.has('permissions')) {
      const previousKeys = externalInquiryKeys(
        (changedProperties.get('permissions') as
          PermissionPayload[] | undefined) ?? [],
      );
      this.permissionsByKind = groupBy(this.permissions, (p) => p.kind);
      this.selectedExternalInquiryKey = selectExternalInquiryKey(
        this.selectedExternalInquiryKey,
        previousKeys,
        externalInquiryKeys(this.permissions),
      );
    }

    if (
      changedProperties.has('permissions') ||
      changedProperties.has('allPermissions')
    ) {
      // Captions key off every pending run, not the stream-filtered prop.
      const runIds = new Set<StreamTabId>();
      for (const permission of this.allPermissions) {
        if (permission.data.streamId) runIds.add(permission.data.streamId);
      }
      this.multiRunPending = runIds.size > 1;
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this.handleGlobalKeydown);
  }

  override disconnectedCallback(): void {
    document.removeEventListener('keydown', this.handleGlobalKeydown);
    super.disconnectedCallback();
  }

  /**
   * The request the y/n accelerators will act on.
   *
   * Single source of truth: `handleGlobalKeydown` resolves the DOM node from
   * this via `findPanelFor`, and the renderers mark that same permission
   * `data-armed`. Deriving the two separately let them disagree — the newest
   * permission is not the target while the external-inquiry carousel is
   * active, so an indicator keyed off `permissions[0]` would ring a panel the
   * carousel does not even render, while the keypress landed on the visible
   * one.
   */
  private get armedPermission(): PermissionPayload | null {
    const newest = this.permissions[0];
    if (!newest) return null;
    return (
      (this.externalInquiryCarouselActive
        ? this.externalInquiries[this.externalInquiryIndex]
        : newest) ?? null
    );
  }

  private armedPermissionKey(): string | null {
    const armed = this.armedPermission;
    return armed ? getPermissionKey(armed) : null;
  }

  override render(): TemplateResult | typeof nothing {
    if (this.permissions.length === 0) return nothing;

    return html`
      ${SECTIONS.map((section) => {
        const permissions = this.permissionsFor(section.kind);
        return section.kind === PERMISSION_KIND.EXTERNAL_INQUIRY
          ? this.renderExternalInquirySection(section, permissions)
          : this.renderSection(section, permissions);
      })}
    `;
  }

  private permissionsFor(kind: PermissionPayload['kind']): PermissionPayload[] {
    return this.permissionsByKind.get(kind) ?? [];
  }

  // ===========================================================================
  // Section rendering
  // ===========================================================================

  private renderSectionHeader(
    config: SectionConfig,
    extra: TemplateResult | typeof nothing = nothing,
  ): TemplateResult {
    // A heading element rather than a styled span, because that is what a
    // section title is. Visual weight is unchanged — the shared header rule
    // already sets font-weight and colour, and the h2 reset in
    // requestPanelSharedStyles strips the UA margin and size.
    return html`
      <div class="${config.cssClass}__header">
        ${waIcon(config.icon)}
        <h2>${config.title}</h2>
        ${extra}
      </div>
    `;
  }

  private renderSection(
    config: SectionConfig,
    permissions: PermissionPayload[],
  ): TemplateResult | typeof nothing {
    if (permissions.length === 0) return nothing;

    const armedKey = this.armedPermissionKey();
    return html`
      <section class=${config.cssClass}>
        ${this.renderSectionHeader(config)}
        <div class="${config.cssClass}__list">
          ${repeat(
            permissions,
            (p) => getPermissionKey(p),
            (p) =>
              this.renderRequest(config, p, getPermissionKey(p) === armedKey),
          )}
        </div>
      </section>
    `;
  }

  /**
   * One request panel, captioned with its originating run's label when
   * approvals from more than one run are pending: sections group by kind,
   * not by run, so the kind title alone cannot say which run is asking.
   * A single pending run keeps the clean chrome.
   */
  private renderRequest(
    config: SectionConfig,
    permission: PermissionPayload,
    armed: boolean,
  ): TemplateResult {
    // `armed` marks the panel the y/n accelerators will act on. Sections render
    // in a fixed kind order while the accelerators target the newest request,
    // so with mixed kinds pending the top panel on screen is not the one a
    // keypress hits. Without a visible mark that divergence is invisible, and
    // the action it triggers can be executing a shell command.
    const panel = staticHtml`<${config.tag}
      data-request-panel
      ?data-armed=${armed}
      .permission=${permission}
    ></${config.tag}>`;
    if (!this.multiRunPending) return panel;
    const streamId = permission.data.streamId;
    if (!streamId) return panel;
    // If the run's tab was evicted, skip the group caption rather than
    // show the raw `agent#executionId` handle.
    const label = streamDisplayLabel(this.streamById.get(streamId));
    if (!label) return panel;
    return html`
      <div class="request-run-group">
        <div class="request-run-group__label">${label}</div>
        ${panel}
      </div>
    `;
  }

  // ===========================================================================
  // External inquiry carousel
  // ===========================================================================

  /**
   * Render external inquiries as a carousel when multiple are pending.
   * Shows one panel at a time with (1/N) counter and prev/next navigation.
   */
  private renderExternalInquirySection(
    config: SectionConfig,
    perms: PermissionPayload[],
  ): TemplateResult | typeof nothing {
    if (perms.length === 0) return nothing;

    // Single inquiry — render normally, no carousel chrome
    if (perms.length === 1) {
      return this.renderSection(config, perms);
    }

    const index = this.externalInquiryIndex;
    const current = perms[index];
    const nav = html`
      <div class="external-inquiry-requests__nav">
        <wa-button
          id="ei-prev-btn"
          appearance="plain"
          size="s"
          ?disabled=${index === 0}
          @click=${this.showPreviousInquiry}
        >
          ${waIcon('chevron-left')}
        </wa-button>
        <wa-tooltip for="ei-prev-btn">Previous inquiry</wa-tooltip>
        <span class="external-inquiry-requests__counter">
          ${index + 1} / ${perms.length}
        </span>
        <wa-button
          id="ei-next-btn"
          appearance="plain"
          size="s"
          ?disabled=${index === perms.length - 1}
          @click=${this.showNextInquiry}
        >
          ${waIcon('chevron-right')}
        </wa-button>
        <wa-tooltip for="ei-next-btn">Next inquiry</wa-tooltip>
      </div>
    `;

    return html`
      <section class=${config.cssClass}>
        ${this.renderSectionHeader(config, nav)}
        <div class="${config.cssClass}__list">
          ${keyed(
            getPermissionKey(current),
            this.renderRequest(
              config,
              current,
              getPermissionKey(current) === this.armedPermissionKey(),
            ),
          )}
        </div>
      </section>
    `;
  }

  private get externalInquiries(): PermissionPayload[] {
    return this.permissionsFor(PERMISSION_KIND.EXTERNAL_INQUIRY);
  }

  private get externalInquiryIndex(): number {
    const index = this.externalInquiries.findIndex(
      (permission) =>
        getPermissionKey(permission) === this.selectedExternalInquiryKey,
    );
    return Math.max(index, 0);
  }

  /** True when the newest permission is one of several pending inquiries. */
  private get externalInquiryCarouselActive(): boolean {
    return (
      this.permissions[0]?.kind === PERMISSION_KIND.EXTERNAL_INQUIRY &&
      this.externalInquiries.length > 1
    );
  }

  /** Move the carousel selection by `delta`, clamped by the group bounds. */
  private stepExternalInquiry(delta: number): void {
    const permission =
      this.externalInquiries[this.externalInquiryIndex + delta];
    if (permission) {
      this.selectedExternalInquiryKey = getPermissionKey(permission);
    }
  }

  private showPreviousInquiry(): void {
    this.stepExternalInquiry(-1);
  }

  private showNextInquiry(): void {
    this.stepExternalInquiry(1);
  }

  // ===========================================================================
  // Keyboard shortcuts
  // ===========================================================================

  /**
   * Handle keyboard shortcuts for permission actions.
   * Only active when permissions are visible and no text input is focused.
   * Delegates to the panel matching the newest permission (permissions[0]),
   * or the currently visible carousel panel for external inquiries.
   *
   * Left/right arrow keys navigate the external inquiry carousel.
   *
   * WCAG 2.1.4 (Character Key Shortcuts): single-character shortcuts (y, n,
   * d, r, s, k…) additionally require focus inside this component — the
   * compliant mechanism chosen here is "active only on focus" (a settings
   * opt-out would cross into settingsView/shared lanes; remapping is
   * already impossible for hardwired keys). Without the gate, one stray
   * keystroke anywhere in the view could approve or reject a run.
   * Non-character keys (Escape, arrows) are outside 2.1.4's scope and stay
   * global.
   */
  private handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (isTextInput(document.activeElement)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (this.permissions.length === 0) return;

    const key = event.key.toLowerCase();

    // Arrow keys navigate the external inquiry carousel
    if (this.externalInquiryCarouselActive) {
      if (key === 'arrowleft') {
        this.showPreviousInquiry();
        event.preventDefault();
        return;
      }
      if (key === 'arrowright') {
        this.showNextInquiry();
        event.preventDefault();
        return;
      }
    }

    if (key.length === 1 && !event.composedPath().includes(this)) return;

    const armed = this.armedPermission;
    const panel = armed ? this.findPanelFor(armed) : null;
    if (!panel) return;

    if (panel.handleKeyboardShortcut(key)) {
      event.preventDefault();
    }
  };

  /**
   * Rendered panel node for a permission. We match by reference rather than
   * querying DOM order, which follows fixed section ordering
   * (approval → bash → retry → proposal) and would target the wrong panel
   * when mixed kinds are pending.
   */
  private findPanelFor(permission: PermissionPayload): BaseRequestPanel | null {
    const panels = this.renderRoot.querySelectorAll<BaseRequestPanel>(
      PANEL_MARKER_SELECTOR,
    );
    for (const panel of panels) {
      if (panel.permission === permission) return panel;
    }
    return null;
  }

  // ===========================================================================
  // Focus management
  // ===========================================================================

  /**
   * Move keyboard focus to a newly appeared request's primary action, once
   * per pending key. The WCAG 2.1.4 gate in handleGlobalKeydown makes
   * single-char shortcuts fire only while focus is inside this component, so
   * without this the y/n accelerators are unreachable until the user happens
   * to Tab here. Two focus-stealing guards: never while the user is typing
   * in a text control elsewhere, and never when focus is already inside this
   * component (e.g. mid-decision on an earlier request — a second arrival
   * must not yank focus away).
   */
  protected override updated(): void {
    const previousKeys = this.seenPermissionKeys;
    this.seenPermissionKeys = new Set(this.permissions.map(getPermissionKey));
    // Queue order is newest-first, so this is the newest request that just
    // appeared.
    const firstNew = this.permissions.find(
      (permission) => !previousKeys.has(getPermissionKey(permission)),
    );
    if (!firstNew) return;
    if (isTextInput(document.activeElement)) return;
    if (this.matches(':focus-within')) return;

    const panel = this.findPanelFor(firstNew);
    if (!panel) return;
    // The panel (and nested <approve-split-button>) was just connected in this
    // render pass — its first Lit update is a microtask that cannot run until
    // this `updated()` returns. Wait like LogList does for TaskGroupList.
    void panel.updateComplete.then(() => {
      if (isTextInput(document.activeElement)) return;
      if (this.matches(':focus-within')) return;
      void this.focusPanel(panel);
    });
  }

  /**
   * Focus a panel's primary action: the Approve button where one exists
   * (it lives one shadow level down inside <approve-split-button>), else the
   * panel's first control, else the panel container itself as a focusable
   * landmark.
   */
  private async focusPanel(panel: BaseRequestPanel): Promise<void> {
    await panel.updateComplete;
    const root = panel.shadowRoot;
    if (!root) {
      panel.tabIndex = -1;
      panel.focus();
      return;
    }

    const split = root.querySelector<ApproveSplitButton>(
      'approve-split-button',
    );
    if (split) {
      await split.updateComplete;
      const approveButton =
        split.shadowRoot?.querySelector<HTMLElement>('wa-button');
      if (approveButton) {
        approveButton.focus();
        return;
      }
    }

    const control = root.querySelector<HTMLElement>(
      'wa-button, wa-radio-group, wa-checkbox, wa-textarea, wa-input, button, input, textarea, select',
    );
    if (control) {
      control.focus();
      return;
    }

    panel.tabIndex = -1;
    panel.focus();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'request-panels': RequestPanels;
  }
}
