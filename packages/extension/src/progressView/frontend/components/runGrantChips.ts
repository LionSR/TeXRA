import '@awesome.me/webawesome/dist/components/tag/tag.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import { css, html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';

import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import { RUN_GRANT_COPY, RUN_GRANT_ORDER } from '@ui/copy/delegationApproval';
import { waIcon } from '@ui/wa/webAwesomeIcons';

function grantChip(
  id: string,
  kinds: readonly ApprovalBypassKind[],
  label: string,
  revoke: () => void,
): TemplateResult {
  const tooltip = RUN_GRANT_COPY.tooltip(kinds);
  return html`<wa-tag
      id=${id}
      class="run-grant"
      size="s"
      variant="warning"
      with-remove
      tabindex="0"
      role="button"
      aria-label=${`${label}. ${tooltip}`}
      aria-keyshortcuts="Delete Backspace"
      @wa-remove=${revoke}
      @keydown=${(event: KeyboardEvent) => {
        // The tag's own × is pointer-only (tabindex -1), so the focused
        // chip revokes from the keyboard.
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          revoke();
        }
      }}
      >${waIcon('check-double')} ${label}</wa-tag
    >
    <wa-tooltip for=${id}>${tooltip}</wa-tooltip>`;
}

/**
 * The header's grants: read-only, one chip per grant that is on, each with
 * a remove button that revokes it. Granting has one home, the approval
 * card's Approve ▾; the header shows what was granted and takes it back.
 * A narrow header shows one "Auto" chip whose remove revokes them all, so
 * Stop and the menu keep their place on the row.
 */
export function renderRunGrantChips(
  active: (kind: ApprovalBypassKind) => boolean,
  revoke: (kind: ApprovalBypassKind) => void,
): TemplateResult | typeof nothing {
  const on = RUN_GRANT_ORDER.filter(active);
  if (on.length === 0) return nothing;
  return html`<div class="run-grants" role="group">
    <span class="run-grants-wide">
      ${repeat(
        on,
        (kind) => kind,
        (kind) =>
          grantChip(
            `runGrant-${kind}`,
            [kind],
            RUN_GRANT_COPY.label(kind),
            () => revoke(kind),
          ),
      )}
    </span>
    <span class="run-grants-narrow">
      ${grantChip('runGrant-all', on, RUN_GRANT_COPY.compactLabel, () => {
        for (const kind of on) revoke(kind);
      })}
    </span>
  </div>`;
}

export const runGrantStyles = css`
  .run-grants,
  .run-grants-wide {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    gap: var(--wa-space-3xs);
    white-space: nowrap;
  }
  .run-grants-narrow {
    display: none;
  }
  @container (max-width: 640px) {
    .run-grants-wide {
      display: none;
    }
    .run-grants-narrow {
      display: inline-flex;
    }
  }
`;
