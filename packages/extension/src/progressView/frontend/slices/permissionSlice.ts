/**
 * Permission handlers: UPDATE_PERMISSION, UPDATE_BYPASS.
 *
 * Owns resolvedProposalIds, upsertProposalPermission,
 * and removePrompt helpers.
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { createBoundedIdSet } from '@utils/core/boundedIdSet';

import { clearInquiryDraft } from '../components/ExternalInquiryPanel';
import { updateToolUseState } from '../stateUtils';
import { permissionId, type PermissionState } from '../permissionState';
import type {
  HandlerRegistry,
  MessageHandlerContext,
} from '../messageHandlerTypes';

// ============================================================
// Module state
// ============================================================

/** Maximum entries before evicting oldest resolved IDs. */
const RESOLVED_PROPOSAL_IDS_CAP = 200;

/** Proposal IDs resolved before a show message arrives (out-of-order guard). */
const resolvedProposalIds = createBoundedIdSet(RESOLVED_PROPOSAL_IDS_CAP);

/** Clear all resolved proposal IDs (called on stream delete / delete-all). */
export function clearResolvedProposalIds(): void {
  resolvedProposalIds.clear();
}

/** Add a resolved proposal ID, evicting the oldest entry if over cap. */
export function addResolvedProposalId(id: string): void {
  resolvedProposalIds.add(id);
}

// ============================================================
// Helpers (exported for use by eventHandlers.ts)
// ============================================================

/**
 * Upsert a proposal permission. If one with the same proposalId already exists
 * (e.g., a model-options update after the initial show), replace it in-place
 * to preserve ordering. Otherwise prepend as a new permission.
 */
function upsertProposalPermission(
  ctx: MessageHandlerContext,
  permission: PermissionState & { kind: typeof PERMISSION_KIND.PROPOSAL },
): void {
  const permissions = ctx.getPermissions();
  const idx = permissions.findIndex(
    (p) =>
      p.kind === PERMISSION_KIND.PROPOSAL &&
      p.data.proposalId === permission.data.proposalId,
  );
  if (idx >= 0) {
    const updated = [...permissions];
    updated[idx] = permission;
    ctx.setPermissions(updated);
  } else {
    ctx.setPermissions([permission, ...permissions]);
  }
}

export function removePrompt(
  ctx: MessageHandlerContext,
  kind: PermissionState['kind'],
  idValue: string,
): boolean {
  const current = ctx.getPermissions();
  const next = current.filter(
    (p) => p.kind !== kind || permissionId(p) !== idValue,
  );
  ctx.setPermissions(next);
  return next.length !== current.length;
}

// ============================================================
// Handlers
// ============================================================

// `HandlerRegistry` is now exhaustive (every ProgressView outbound command
// needs a real handler or `unsupported(...)` — see `@shared/utils/dispatcher`).
// This slice only owns a subset, so it's typed as a `satisfies Partial<...>`
// subset rather than the full registry; `messageDispatcher.ts` spreads all
// slices together and is the actual exhaustiveness checkpoint TypeScript
// enforces.
export const permissionHandlers = {
  [PROGRESS_VIEW_COMMANDS.UPDATE_BYPASS]: (data, ctx) => {
    updateToolUseState(ctx, data.stream, (prev) =>
      create(prev, (draft) => {
        if (data.type === 'toolEdit') {
          draft.toolEditBypass = data.bypassActive;
        } else {
          draft.superYoloBypass = data.bypassActive;
        }
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.GOAL_ACTIVE_UPDATED]: (data, ctx) => {
    updateToolUseState(ctx, data.stream, (prev) =>
      create(prev, (draft) => {
        draft.goalActive = data.active;
        draft.goalStatus = data.active ? (data.status ?? undefined) : undefined;
        draft.goalObjective = data.active
          ? (data.objective ?? undefined)
          : undefined;
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION]: (data, ctx) => {
    if (data.action === 'show') {
      const { permission } = data;
      if (permission.kind === PERMISSION_KIND.PROPOSAL) {
        // Drop if this proposal was already resolved (out-of-order messages)
        if (resolvedProposalIds.delete(permission.data.proposalId)) return;
        upsertProposalPermission(ctx, {
          kind: PERMISSION_KIND.PROPOSAL,
          data: permission.data,
          modelOptions: permission.modelOptionsData,
          agentOptions: permission.agentOptionsData,
        });
      } else {
        // Prepend newest permissions so keyboard shortcuts target the latest request.
        // Deduplicate by id to prevent duplicate UI when replay() re-sends
        // pending items (e.g., on view visibility change).
        const entry = {
          kind: permission.kind,
          data: permission.data,
        } as PermissionState;
        const id = permissionId(entry);
        const existing = ctx.getPermissions();
        const alreadyPresent = existing.some(
          (p) => p.kind === permission.kind && permissionId(p) === id,
        );
        if (alreadyPresent) return;
        ctx.setPermissions([entry, ...existing]);
      }
      return;
    }

    const { kind, id } = data;
    switch (kind) {
      case PERMISSION_KIND.TOOL_EDIT:
      case PERMISSION_KIND.BASH:
      case PERMISSION_KIND.RETRY:
      case PERMISSION_KIND.PLAN_APPROVAL:
      case PERMISSION_KIND.USER_QUESTION:
        removePrompt(ctx, kind, id);
        break;
      case PERMISSION_KIND.EXTERNAL_INQUIRY:
        removePrompt(ctx, kind, id);
        clearInquiryDraft(id);
        break;
      default: {
        const removed = removePrompt(ctx, PERMISSION_KIND.PROPOSAL, id);
        if (!removed) addResolvedProposalId(id);
      }
    }
  },
} satisfies Partial<HandlerRegistry>;
