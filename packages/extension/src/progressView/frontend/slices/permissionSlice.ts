/**
 * Permission handlers: UPDATE_PERMISSION, UPDATE_BYPASS.
 *
 * Owns resolvedProposalIds, upsertProposalPermission,
 * and removePrompt helpers.
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

import { clearInquiryDraft } from '../components/ExternalInquiryPanel';
import { updateToolUseState } from '../stateUtils';
import type { PermissionState } from '../components/PermissionCard';
import type {
  HandlerRegistry,
  MessageHandlerContext,
} from '../messageDispatcher';

// ============================================================
// Module state
// ============================================================

/** Proposal IDs resolved before a show message arrives (out-of-order guard). */
export const resolvedProposalIds = new Set<string>();

/** Maximum entries before evicting oldest resolved IDs. */
const RESOLVED_PROPOSAL_IDS_CAP = 200;

/** Clear all resolved proposal IDs (called on stream delete / delete-all). */
export function clearResolvedProposalIds(): void {
  resolvedProposalIds.clear();
}

/** Add a resolved proposal ID, evicting the oldest entry if over cap. */
export function addResolvedProposalId(id: string): void {
  resolvedProposalIds.add(id);
  if (resolvedProposalIds.size > RESOLVED_PROPOSAL_IDS_CAP) {
    // Set iteration order is insertion order — first value is oldest
    const oldest = resolvedProposalIds.values().next().value;
    if (oldest !== undefined) resolvedProposalIds.delete(oldest);
  }
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
  idField: string,
  idValue: string,
): boolean {
  const current = ctx.getPermissions();
  const next = current.filter((p) => {
    if (p.kind !== kind) return true;
    const data = p.data as Record<string, unknown>;
    return data[idField] !== idValue;
  });
  ctx.setPermissions(next);
  return next.length !== current.length;
}

// ============================================================
// Handlers
// ============================================================

export const permissionHandlers: HandlerRegistry = {
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

  [PROGRESS_VIEW_COMMANDS.ODYSSEY_ACTIVE_UPDATED]: (data, ctx) => {
    updateToolUseState(ctx, data.stream, (prev) =>
      create(prev, (draft) => {
        draft.odysseyActive = data.active;
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
        // Deduplicate by requestId to prevent duplicate UI when replay() re-sends
        // pending items (e.g., on view visibility change).
        const entry = {
          kind: permission.kind,
          data: permission.data,
        } as PermissionState;
        const idField =
          permission.kind === PERMISSION_KIND.RETRY ? 'streamId' : 'requestId';
        const id = (permission.data as Record<string, unknown>)[idField];
        const existing = ctx.getPermissions();
        const alreadyPresent =
          id != null &&
          existing.some(
            (p) =>
              p.kind === permission.kind &&
              (p.data as Record<string, unknown>)[idField] === id,
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
        removePrompt(ctx, kind, 'requestId', id);
        break;
      case PERMISSION_KIND.RETRY:
        removePrompt(ctx, kind, 'streamId', id);
        break;
      case PERMISSION_KIND.PLAN_APPROVAL:
        removePrompt(ctx, kind, 'approvalId', id);
        break;
      case PERMISSION_KIND.EXTERNAL_INQUIRY:
        removePrompt(ctx, kind, 'requestId', id);
        clearInquiryDraft(id);
        break;
      case PERMISSION_KIND.USER_QUESTION:
        removePrompt(ctx, kind, 'requestId', id);
        break;
      default: {
        const removed = removePrompt(
          ctx,
          PERMISSION_KIND.PROPOSAL,
          'proposalId',
          id,
        );
        if (!removed) addResolvedProposalId(id);
      }
    }
  },
};
