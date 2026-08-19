/**
 * Identity helpers for the pending permission/approval prompts the progress
 * view displays. The prompts themselves are the wire payloads
 * (`PermissionPayload`) — the frontend stores what the backend sent, with no
 * parallel view model to keep in sync.
 *
 * Lives in its own leaf module (not `components/PermissionCard.ts`) so state
 * files (store, contexts, slices, dispatcher) can use them without importing
 * the Lit component and its side-effect imports.
 */
import type { PermissionPayload } from '@shared/schemas';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

/**
 * Every permission kind's wire schema carries `requestId`; retry is the one
 * kind not *keyed* by it — retry is keyed by `streamId` instead (one pending
 * retry per stream, a new request replaces the old one).
 */
export function permissionId(permission: PermissionPayload): string {
  return permission.kind === PERMISSION_KIND.RETRY
    ? permission.data.streamId
    : permission.data.requestId;
}

/** Stable identity key for a pending permission, used for selection/dedup. */
export function getPermissionKey(permission: PermissionPayload): string {
  return `${permission.kind}:${permissionId(permission)}`;
}
