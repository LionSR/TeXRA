/**
 * Lightweight container for permission request panels.
 *
 * Groups permissions by kind and renders section headers with
 * individual panel components. Manages global keyboard shortcuts
 * (y=approve, n=reject, d=diff, r=retry, s=setup, Esc=dismiss)
 * by delegating to the panel matching the newest permission in the queue.
 */

// Third-party imports
import {
  LitElement,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import { repeat } from 'lit/directives/repeat.js';

// Side-effect imports - register WA icon and button components
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/button/button.js';

// Local imports - shared styles
import {
  commonViewStyles,
  designTokens,
  requestPanelStyles,
} from '@shared/styles';

// Local imports - progress view helpers
import {
  createEmptyPermissionGroups,
  findPanelForPermission,
  getActivePermission,
  getPermissionKey,
  groupPermissions,
  isActiveExternalInquiryCarousel,
  isTextInput,
  resolveExternalInquiryIndex,
  type PermissionGroups,
} from './RequestPanelsState';

// Local imports - progress view component types
import type { BaseRequestPanel } from './BaseRequestPanel';
import type { PermissionState } from './PermissionCard';

// Side-effect imports to register sub-panel custom elements
import './ToolEditRequestPanel';
import './BashRequestPanel';
import './RetryRequestPanel';
import './ProposalRequestPanel';
import './PlanApprovalRequestPanel';
import './ExternalInquiryPanel';
import './UserQuestionPanel';

/** Section configuration for rendering permission groups */
interface SectionConfig {
  cssClass: string;
  icon: string;
  title: string;
  renderPanel: (p: PermissionState) => TemplateResult;
}

const SECTION_CONFIGS: Record<string, SectionConfig> = {
  approval: {
    cssClass: 'approval-requests',
    icon: 'diff',
    title: 'Tool edit approval',
    renderPanel: (p) =>
      html`<tool-edit-request-panel
        .permission=${p}
      ></tool-edit-request-panel>`,
  },
  bash: {
    cssClass: 'bash-approval-requests',
    icon: 'terminal',
    title: 'Command approval',
    renderPanel: (p) =>
      html`<bash-request-panel .permission=${p}></bash-request-panel>`,
  },
  retry: {
    cssClass: 'retry-requests',
    icon: 'refresh',
    title: 'Retry request',
    renderPanel: (p) =>
      html`<retry-request-panel .permission=${p}></retry-request-panel>`,
  },
  proposal: {
    cssClass: 'workflow-proposals',
    icon: 'rocket',
    title: 'Agent proposal',
    renderPanel: (p) =>
      html`<proposal-request-panel .permission=${p}></proposal-request-panel>`,
  },
  planApproval: {
    cssClass: 'plan-approval-requests',
    icon: 'checklist',
    title: 'Plan approval',
    renderPanel: (p) =>
      html`<plan-approval-request-panel
        .permission=${p}
      ></plan-approval-request-panel>`,
  },
  externalInquiry: {
    cssClass: 'external-inquiry-requests',
    icon: 'globe',
    title: 'External inquiry',
    renderPanel: (p) =>
      html`<external-inquiry-panel .permission=${p}></external-inquiry-panel>`,
  },
  userQuestion: {
    cssClass: 'user-question-requests',
    icon: 'circle-question',
    title: 'Question',
    renderPanel: (p) =>
      html`<user-question-panel .permission=${p}></user-question-panel>`,
  },
};

@customElement('request-panels')
export class RequestPanels extends LitElement {
  static override styles = [designTokens, commonViewStyles, requestPanelStyles];

  @property({ attribute: false }) permissions: PermissionState[] = [];

  /** Currently displayed external inquiry index (carousel). */
  @state() private _eiIndex = 0;

  /** Key of the currently viewed external inquiry, for stable tracking across list changes. */
  private _eiTrackedKey: string | null = null;

  /** Memoized permission groups - recomputed in willUpdate() when permissions change. */
  private permissionGroups: PermissionGroups = createEmptyPermissionGroups();

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (!changedProperties.has('permissions')) return;

    this.permissionGroups = groupPermissions(this.permissions);
    this._eiIndex = resolveExternalInquiryIndex(
      this._eiIndex,
      this.permissionGroups.externalInquiry,
      this._eiTrackedKey,
    );
    this._updateTrackedKey();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this.handleGlobalKeydown);
  }

  override disconnectedCallback(): void {
    document.removeEventListener('keydown', this.handleGlobalKeydown);
    super.disconnectedCallback();
  }

  override render(): TemplateResult | typeof nothing {
    if (this.permissions.length === 0) return nothing;

    const {
      approval,
      bash,
      retry,
      proposal,
      planApproval,
      externalInquiry,
      userQuestion,
    } = this.permissionGroups;

    return html`
      ${this.renderSection(SECTION_CONFIGS.approval, approval)}
      ${this.renderSection(SECTION_CONFIGS.bash, bash)}
      ${this.renderSection(SECTION_CONFIGS.retry, retry)}
      ${this.renderSection(SECTION_CONFIGS.proposal, proposal)}
      ${this.renderSection(SECTION_CONFIGS.planApproval, planApproval)}
      ${this.renderExternalInquirySection(externalInquiry)}
      ${this.renderSection(SECTION_CONFIGS.userQuestion, userQuestion)}
    `;
  }

  // ===========================================================================
  // Section rendering
  // ===========================================================================

  private renderSectionHeader(
    config: SectionConfig,
    extra: TemplateResult | typeof nothing = nothing,
  ): TemplateResult {
    return html`
      <div class="${config.cssClass}__header">
        <wa-icon
          library="texra"
          name=${config.icon}
          aria-hidden="true"
        ></wa-icon>
        <span>${config.title}</span>
        ${extra}
      </div>
    `;
  }

  private renderSection(
    config: SectionConfig,
    permissions: PermissionState[],
  ): TemplateResult | typeof nothing {
    if (permissions.length === 0) return nothing;

    return html`
      <section class=${config.cssClass}>
        ${this.renderSectionHeader(config)}
        <div class="${config.cssClass}__list">
          ${repeat(
            permissions,
            (p) => getPermissionKey(p),
            (p) => config.renderPanel(p),
          )}
        </div>
      </section>
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
    perms: PermissionState[],
  ): TemplateResult | typeof nothing {
    if (perms.length === 0) return nothing;

    // Single inquiry — render normally, no carousel chrome
    if (perms.length === 1) {
      return this.renderSection(SECTION_CONFIGS.externalInquiry, perms);
    }

    const config = SECTION_CONFIGS.externalInquiry;
    const current = perms[this._eiIndex];
    const nav = html`
      <div class="external-inquiry-requests__nav">
        <wa-button
          appearance="plain"
          size="small"
          title="Previous inquiry"
          ?disabled=${this._eiIndex === 0}
          @click=${this._eiPrev}
        >
          <wa-icon
            library="texra"
            name="chevron-left"
            aria-hidden="true"
          ></wa-icon>
        </wa-button>
        <span class="external-inquiry-requests__counter">
          ${this._eiIndex + 1} / ${perms.length}
        </span>
        <wa-button
          appearance="plain"
          size="small"
          title="Next inquiry"
          ?disabled=${this._eiIndex === perms.length - 1}
          @click=${this._eiNext}
        >
          <wa-icon
            library="texra"
            name="chevron-right"
            aria-hidden="true"
          ></wa-icon>
        </wa-button>
      </div>
    `;

    return html`
      <section class=${config.cssClass}>
        ${this.renderSectionHeader(config, nav)}
        <div class="${config.cssClass}__list">
          ${keyed(getPermissionKey(current), config.renderPanel(current))}
        </div>
      </section>
    `;
  }

  private _updateTrackedKey(): void {
    const ei = this.permissionGroups.externalInquiry;
    this._eiTrackedKey =
      ei.length > 0 ? getPermissionKey(ei[this._eiIndex]) : null;
  }

  private _eiPrev(): void {
    if (this._eiIndex > 0) {
      this._eiIndex--;
      this._updateTrackedKey();
    }
  }

  private _eiNext(): void {
    if (this._eiIndex < this.permissionGroups.externalInquiry.length - 1) {
      this._eiIndex++;
      this._updateTrackedKey();
    }
  }

  // ===========================================================================
  // Keyboard shortcuts
  // ===========================================================================

  /**
   * Handle global keyboard shortcuts for permission actions.
   * Only active when permissions are visible and no text input is focused.
   * Delegates to the panel matching the newest permission (permissions[0]),
   * or the currently visible carousel panel for external inquiries.
   *
   * Left/right arrow keys navigate the external inquiry carousel.
   */
  private handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (isTextInput(document.activeElement)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (this.permissions.length === 0) return;

    const key = event.key.toLowerCase();

    // Arrow keys navigate the external inquiry carousel
    if (
      isActiveExternalInquiryCarousel({
        permissions: this.permissions,
        externalInquiryPermissions: this.permissionGroups.externalInquiry,
      })
    ) {
      if (key === 'arrowleft') {
        this._eiPrev();
        event.preventDefault();
        return;
      }
      if (key === 'arrowright') {
        this._eiNext();
        event.preventDefault();
        return;
      }
    }

    const panel = this.getActivePanel();
    if (!panel) return;

    if (panel.handleKeyboardShortcut(key)) {
      event.preventDefault();
    }
  };

  /**
   * Find the panel that should receive keyboard shortcuts.
   *
   * For external inquiry carousel: targets the currently visible panel.
   * For other permission kinds: targets the newest (first in the queue).
   *
   * We match by reference rather than querying DOM order, which follows
   * fixed section ordering (approval → bash → retry → proposal) and
   * would target the wrong panel when mixed kinds are pending.
   */
  private getActivePanel(): BaseRequestPanel | null {
    const target = getActivePermission({
      permissions: this.permissions,
      externalInquiryPermissions: this.permissionGroups.externalInquiry,
      externalInquiryIndex: this._eiIndex,
    });
    return findPanelForPermission(this.renderRoot, target);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'request-panels': RequestPanels;
  }
}
