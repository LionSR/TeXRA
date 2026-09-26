import '@awesome.me/webawesome/dist/components/switch/switch.js';
import {
  css,
  html,
  nothing,
  type ReactiveController,
  type ReactiveControllerHost,
  type TemplateResult,
} from 'lit';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';

import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import {
  DELEGATION_APPROVAL_COPY,
  RUN_GRANT_NOUN,
} from '@ui/copy/delegationApproval';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';

/** The run header's order: edits, commands, agent work. */
const SWITCH_KINDS = [
  'toolEdit',
  'bash',
  'superYolo',
] as const satisfies readonly ApprovalBypassKind[];

/** The full sentence behind each switch. */
const SWITCH_TOOLTIP: Record<ApprovalBypassKind, string> = {
  toolEdit: 'Auto-approve file edits in this run',
  bash: 'Auto-approve shell commands in this run',
  superYolo: DELEGATION_APPROVAL_COPY.progressViewToggle,
};

/** Below this width the switches move into the run's ⋯ menu. */
const WIDE_HEADER_MIN_PX = 720;

/**
 * Whether the run header is wide enough for its auto-approve switches.
 * A render decision, not a CSS one: a hidden menu item would still take
 * keyboard focus and indent its neighbours for a check mark.
 */
export class WideHeaderController implements ReactiveController {
  wide = true;
  private readonly observer = new ResizeObserver(([entry]) => {
    const wide = (entry?.contentRect.width ?? 0) >= WIDE_HEADER_MIN_PX;
    if (wide === this.wide) return;
    this.wide = wide;
    this.host.requestUpdate();
  });

  constructor(private readonly host: ReactiveControllerHost & Element) {
    host.addController(this);
  }

  hostConnected(): void {
    this.observer.observe(this.host);
  }

  hostDisconnected(): void {
    this.observer.disconnect();
  }
}

/**
 * The header row's part: one switch per grant when wide; when narrow, a
 * read-only "Auto" tag while any grant is on (the switches are in ⋯).
 */
export function renderAutoApproveRow(
  wide: boolean,
  active: (kind: ApprovalBypassKind) => boolean,
  set: (kind: ApprovalBypassKind, enabled: boolean) => void,
): TemplateResult | typeof nothing {
  if (!wide) {
    const on = SWITCH_KINDS.filter(active);
    if (on.length === 0) return nothing;
    const nouns = on.map((kind) => RUN_GRANT_NOUN[kind]).join(', ');
    return html`<wa-tag
        id="autoApproveTag"
        class="auto-approve-tag"
        size="s"
        variant="warning"
        >${waIcon('check-double')} Auto</wa-tag
      >
      <wa-tooltip for="autoApproveTag"
        >Auto-approving ${nouns}. Turn off in the ⋯ menu.</wa-tooltip
      >`;
  }
  return html`<div
    class="auto-approve"
    role="group"
    aria-label="Auto-approve in this run"
  >
    <span class="auto-approve-label" aria-hidden="true">Auto:</span>
    ${repeat(
      SWITCH_KINDS,
      (kind) => kind,
      (kind) =>
        html`<wa-switch
            id=${`autoApprove-${kind}`}
            size="s"
            .checked=${live(active(kind))}
            aria-label=${`Auto-approve ${RUN_GRANT_NOUN[kind]}`}
            @change=${(event: Event) =>
              set(kind, (event.currentTarget as WaSwitch).checked)}
            >${RUN_GRANT_NOUN[kind]}</wa-switch
          >
          <wa-tooltip for=${`autoApprove-${kind}`}
            >${SWITCH_TOOLTIP[kind]}</wa-tooltip
          >`,
    )}
  </div>`;
}

/** The same switches as checkable ⋯ menu items, for the narrow header. */
export function renderAutoApproveMenu(
  active: (kind: ApprovalBypassKind) => boolean,
): TemplateResult {
  return html`${repeat(
      SWITCH_KINDS,
      (kind) => kind,
      (kind) =>
        html`<wa-dropdown-item
          type="checkbox"
          value=${`autoApprove-${kind}`}
          data-bypass=${kind}
          .checked=${live(active(kind))}
          >Auto-approve ${RUN_GRANT_NOUN[kind]}</wa-dropdown-item
        >`,
    )}<wa-divider></wa-divider>`;
}

export const autoApproveStyles = css`
  .auto-approve {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    gap: var(--wa-space-s);
    white-space: nowrap;
  }
  .auto-approve wa-switch {
    font-size: var(--font-size-sm);
  }
  .auto-approve-tag {
    flex-shrink: 0;
  }
`;
