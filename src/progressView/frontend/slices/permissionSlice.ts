/**
 * Permission handlers: UPDATE_PERMISSION, UPDATE_BYPASS.
 *
 * Owns resolvedProposalIds, addPermission, upsertProposalPermission,
 * and removePrompt helpers.
 */

import { create } from 'mutative';

import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

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

// ============================================================
// Helpers (exported for use by eventHandlers.ts)
// ============================================================

function addPermission(
  ctx: MessageHandlerContext,
  permission: PermissionState,
): void {
  // Prepend newest permissions so keyboard shortcuts target the latest request.
  ctx.setPermissions([permission, ...ctx.getPermissions()]);
}

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
        });
      } else {
        addPermission(ctx, {
          kind: permission.kind,
          data: permission.data,
        } as PermissionState);
      }
      return;
    }

    const { kind, id } = data;
    if (kind === PERMISSION_KIND.TOOL_EDIT || kind === PERMISSION_KIND.BASH) {
      removePrompt(ctx, kind, 'requestId', id);
      return;
    }
    if (kind === PERMISSION_KIND.RETRY) {
      removePrompt(ctx, PERMISSION_KIND.RETRY, 'streamId', id);
      return;
    }

    const removed = removePrompt(
      ctx,
      PERMISSION_KIND.PROPOSAL,
      'proposalId',
      id,
    );
    if (!removed) {
      resolvedProposalIds.add(id);
    }
  },
};
