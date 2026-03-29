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
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import {
  codiconIconClasses,
  commonViewStyles,
  designTokens,
  requestPanelStyles,
} from '@shared/styles';

// Local imports - shared utilities
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

// Local imports - progress view component types
import type { PermissionState } from './PermissionCard';
import type { BaseRequestPanel } from './BaseRequestPanel';

// Side-effect imports to register sub-panel custom elements
import './ToolEditRequestPanel';
import './BashRequestPanel';
import './RetryRequestPanel';
import './ProposalRequestPanel';
import './PlanApprovalRequestPanel';
import './ExternalInquiryPanel';

/** Selector to find any sub-panel in shadow DOM */
const PANEL_SELECTOR =
  'tool-edit-request-panel, bash-request-panel, retry-request-panel, proposal-request-panel, plan-approval-request-panel, external-inquiry-panel';

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
      html`<external-inquiry-panel
        .permission=${p}
      ></external-inquiry-panel>`,
  },
};

/**
 * Check if an element is a text-editable element, traversing shadow DOM as needed.
 * Handles native inputs, contentEditable, and custom web components.
 */
function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
    return true;
  if ((el as HTMLElement)?.isContentEditable) return true;

  // Check custom element tags that contain text inputs
  const tagName = el.tagName?.toLowerCase() ?? '';
  if (tagName.includes('textarea') || tagName.includes('input')) return true;

  // Recursively check shadow root for focused text inputs
  const shadowRoot = el.shadowRoot;
  if (shadowRoot?.activeElement) {
    return isTextInput(shadowRoot.activeElement);
  }
  return false;
}

@customElement('request-panels')
export class RequestPanels extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconIconClasses,
    requestPanelStyles,
  ];

  @property({ attribute: false }) permissions: PermissionState[] = [];

  /** Memoized permission groups - recomputed in willUpdate() when permissions change */
  private approvalPermissions: PermissionState[] = [];
  private bashPermissions: PermissionState[] = [];
  private retryPermissions: PermissionState[] = [];
  private proposalPermissions: PermissionState[] = [];
  private planApprovalPermissions: PermissionState[] = [];
  private externalInquiryPermissions: PermissionState[] = [];

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (!changedProperties.has('permissions')) return;

    this.approvalPermissions = this.permissions.filter(
      (p) => p.kind === PERMISSION_KIND.TOOL_EDIT,
    );
    this.bashPermissions = this.permissions.filter(
      (p) => p.kind === PERMISSION_KIND.BASH,
    );
    this.retryPermissions = this.permissions.filter(
      (p) => p.kind === PERMISSION_KIND.RETRY,
    );
    this.proposalPermissions = this.permissions.filter(
      (p) => p.kind === PERMISSION_KIND.PROPOSAL,
    );
    this.planApprovalPermissions = this.permissions.filter(
      (p) => p.kind === PERMISSION_KIND.PLAN_APPROVAL,
    );
    this.externalInquiryPermissions = this.permissions.filter(
      (p) => p.kind === PERMISSION_KIND.EXTERNAL_INQUIRY,
    );
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

    return html`
      ${this.renderSection(SECTION_CONFIGS.approval, this.approvalPermissions)}
      ${this.renderSection(SECTION_CONFIGS.bash, this.bashPermissions)}
      ${this.renderSection(SECTION_CONFIGS.retry, this.retryPermissions)}
      ${this.renderSection(SECTION_CONFIGS.proposal, this.proposalPermissions)}
      ${this.renderSection(
        SECTION_CONFIGS.planApproval,
        this.planApprovalPermissions,
      )}
      ${this.renderSection(
        SECTION_CONFIGS.externalInquiry,
        this.externalInquiryPermissions,
      )}
    `;
  }

  // ===========================================================================
  // Section rendering
  // ===========================================================================

  private renderSection(
    config: SectionConfig,
    permissions: PermissionState[],
  ): TemplateResult | typeof nothing {
    if (permissions.length === 0) return nothing;

    return html`
      <section class=${config.cssClass}>
        <div class="${config.cssClass}__header">
          <i class="codicon codicon-${config.icon}"></i>
          <span>${config.title}</span>
        </div>
        <div class="${config.cssClass}__list">
          ${repeat(
            permissions,
            (p) => this.getPermissionKey(p),
            (p) => config.renderPanel(p),
          )}
        </div>
      </section>
    `;
  }

  // ===========================================================================
  // Keyboard shortcuts
  // ===========================================================================

  /**
   * Handle global keyboard shortcuts for permission actions.
   * Only active when permissions are visible and no text input is focused.
   * Delegates to the panel matching the newest permission (permissions[0]).
   */
  private handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (isTextInput(document.activeElement)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (this.permissions.length === 0) return;

    const key = event.key.toLowerCase();
    const panel = this.getNewestPanel();
    if (!panel) return;

    if (panel.handleKeyboardShortcut(key)) {
      event.preventDefault();
    }
  };

  /**
   * Find the panel for the newest permission (first in the queue).
   *
   * Permissions are prepended so index 0 is always the latest request.
   * We match by reference rather than querying DOM order, which follows
   * fixed section ordering (approval → bash → retry → proposal) and
   * would target the wrong panel when mixed kinds are pending.
   */
  private getNewestPanel(): BaseRequestPanel | null {
    const newest = this.permissions[0];
    const panels =
      this.renderRoot.querySelectorAll<BaseRequestPanel>(PANEL_SELECTOR);
    for (const panel of panels) {
      if (panel.permission === newest) return panel;
    }
    return null;
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private getPermissionKey(permission: PermissionState): string {
    let id: string;
    switch (permission.kind) {
      case PERMISSION_KIND.RETRY:
        id = permission.data.streamId;
        break;
      case PERMISSION_KIND.PROPOSAL:
        id = permission.data.proposalId;
        break;
      case PERMISSION_KIND.PLAN_APPROVAL:
        id = permission.data.approvalId;
        break;
      default:
        id = permission.data.requestId;
        break;
    }
    return `${permission.kind}:${id}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'request-panels': RequestPanels;
  }
}
