import type { ToolEditPermission } from '@shared/schemas';

/**
 * Host interaction and approval UI requests emitted by runtime/tool code.
 *
 * These are not progress facts. Some hosts still route a subset of them through
 * their progress-view UI adapter for compatibility, but the vocabulary is
 * interaction-owned rather than part of the frozen progress fact map.
 */
export interface RuntimeInteractionEventPayloads {
  showToolEditPermission: ToolEditPermission;
  resolveToolEditPermission: { requestId: string };
}
