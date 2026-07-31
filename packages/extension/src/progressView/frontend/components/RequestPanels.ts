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

// Local imports - shared utilities
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

// Local imports - progress view helpers
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import {
  getPermissionKey,
  isTextInput,
  selectExternalInquiryKey,
} from './RequestPanelsState';

// Local imports - progress view component types
import type { BaseRequestPanel } from './BaseRequestPanel';
import type { PermissionState } from '../permissionState';

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
  readonly kind: PermissionState['kind'];
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

function renderPanel(
  section: SectionConfig,
  permission: PermissionState,
): TemplateResult {
  return staticHtml`<${section.tag}
    data-request-panel
    .permission=${permission}
  ></${section.tag}>`;
}

/**
 * One pass over the queue. A kind with no section (malformed IPC data) lands
 * in a bucket nothing renders, so it is dropped rather than throwing.
 */
function groupByKind(
  permissions: readonly PermissionState[],
): ReadonlyMap<PermissionState['kind'], PermissionState[]> {
  const groups = new Map<PermissionState['kind'], PermissionState[]>();
  for (const permission of permissions) {
    const existing = groups.get(permission.kind);
    if (existing) existing.push(permission);
    else groups.set(permission.kind, [permission]);
  }
  return groups;
}

function externalInquiryKeys(
  permissions: readonly PermissionState[],
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
  ];

  @property({ attribute: false }) permissions: PermissionState[] = [];

  /** Canonical selection for the external-inquiry carousel. */
  @state() private selectedExternalInquiryKey: string | null = null;

  /** Memoized permission groups - recomputed in willUpdate() when permissions change. */
  private permissionsByKind: ReadonlyMap<
    PermissionState['kind'],
    PermissionState[]
  > = new Map();

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (!changedProperties.has('permissions')) return;

    const previousKeys = externalInquiryKeys(
      changedProperties.get('permissions') ?? [],
    );
    this.permissionsByKind = groupByKind(this.permissions);
    this.selectedExternalInquiryKey = selectExternalInquiryKey(
      this.selectedExternalInquiryKey,
      previousKeys,
      externalInquiryKeys(this.permissions),
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
      ${SECTIONS.map((section) => {
        const permissions = this.permissionsFor(section.kind);
        return section.kind === PERMISSION_KIND.EXTERNAL_INQUIRY
          ? this.renderExternalInquirySection(section, permissions)
          : this.renderSection(section, permissions);
      })}
    `;
  }

  private permissionsFor(kind: PermissionState['kind']): PermissionState[] {
    return this.permissionsByKind.get(kind) ?? [];
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
        ${waIcon(config.icon)}
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
            (p) => renderPanel(config, p),
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
    config: SectionConfig,
    perms: PermissionState[],
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
          ${keyed(getPermissionKey(current), renderPanel(config, current))}
        </div>
      </section>
    `;
  }

  private get externalInquiries(): PermissionState[] {
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
    const newest = this.permissions[0];
    if (!newest) return null;

    const target = this.externalInquiryCarouselActive
      ? this.externalInquiries[this.externalInquiryIndex]
      : newest;
    if (!target) return null;

    const panels = this.renderRoot.querySelectorAll<BaseRequestPanel>(
      PANEL_MARKER_SELECTOR,
    );
    for (const panel of panels) {
      if (panel.permission === target) return panel;
    }
    return null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'request-panels': RequestPanels;
  }
}
