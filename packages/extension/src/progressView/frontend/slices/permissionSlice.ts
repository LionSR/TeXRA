/**
 * Permission handlers: UPDATE_PERMISSION, UPDATE_BYPASS.
 *
 * Owns resolvedProposalIds, upsertProposalPermission,
 * and removePrompt helpers.
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  PermissionPayload,
  ProgressViewOutboundHandlerRegistry,
} from '@shared/schemas';
import { deriveGoalState } from '@shared/schemas';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { createBoundedIdSet } from '@utils/core/boundedIdSet';

import { clearInquiryDraft } from './inquiryDraftState';
import { permissions$ } from '../progressState';
import { goalToStateFields, updateToolUseState } from '../stateUtils';
import { permissionId } from '../permissionState';

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
 * Upsert a proposal permission. If one with the same requestId already exists
 * (e.g., a model-options update after the initial show), replace it in-place
 * to preserve ordering. Otherwise prepend as a new permission.
 */
function upsertProposalPermission(
  permission: Extract<PermissionPayload, { kind: 'proposal' }>,
): void {
  const permissions = permissions$.get();
  const idx = permissions.findIndex(
    (p) =>
      p.kind === PERMISSION_KIND.PROPOSAL &&
      p.data.requestId === permission.data.requestId,
  );
  if (idx < 0) {
    permissions$.set([permission, ...permissions]);
    return;
  }
  const updated = [...permissions];
  updated[idx] = permission;
  permissions$.set(updated);
}

export function removePrompt(
  kind: PermissionPayload['kind'],
  idValue: string,
): boolean {
  const current = permissions$.get();
  const next = current.filter(
    (p) => p.kind !== kind || permissionId(p) !== idValue,
  );
  permissions$.set(next);
  return next.length !== current.length;
}

// ============================================================
// Handlers
// ============================================================

// Registry contract: every outbound command needs a handler or
// `unsupported(...)`; exhaustiveness is enforced at the composed spread in
// messageDispatcher.ts. This slice only owns a subset.
export const permissionHandlers = {
  [PROGRESS_VIEW_COMMANDS.UPDATE_BYPASS]: (data) => {
    updateToolUseState(data.stream, (prev) =>
      create(prev, (draft) => {
        switch (data.type) {
          case 'bash':
            draft.bashBypass = data.bypassActive;
            break;
          case 'toolEdit':
            draft.toolEditBypass = data.bypassActive;
            break;
          case 'superYolo':
            draft.superYoloBypass = data.bypassActive;
            break;
        }
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.GOAL_ACTIVE_UPDATED]: (data) => {
    const goal = deriveGoalState({
      goalActive: data.active,
      goalStatus: data.status,
      goalObjective: data.objective,
    });
    updateToolUseState(data.stream, (prev) =>
      create(prev, (draft) => {
        Object.assign(draft, goalToStateFields(goal));
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION]: (data) => {
    if (data.action === 'show') {
      const { permission } = data;
      if (permission.kind === PERMISSION_KIND.PROPOSAL) {
        // Drop if this proposal was already resolved (out-of-order messages)
        if (resolvedProposalIds.delete(permission.data.requestId)) return;
        upsertProposalPermission(permission);
      } else {
        // Prepend newest permissions so keyboard shortcuts target the latest request.
        // Deduplicate by id to prevent duplicate UI when replay() re-sends
        // pending items (e.g., on view visibility change).
        const id = permissionId(permission);
        const existing = permissions$.get();
        const alreadyPresent = existing.some(
          (p) => p.kind === permission.kind && permissionId(p) === id,
        );
        if (alreadyPresent) return;
        permissions$.set([permission, ...existing]);
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
        removePrompt(kind, id);
        break;
      case PERMISSION_KIND.EXTERNAL_INQUIRY:
        removePrompt(kind, id);
        clearInquiryDraft(id);
        break;
      default: {
        const removed = removePrompt(PERMISSION_KIND.PROPOSAL, id);
        if (!removed) addResolvedProposalId(id);
      }
    }
  },
} satisfies Partial<ProgressViewOutboundHandlerRegistry>;
