import { SessionStores } from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { releaseStreamResources } from '@tools/approval';
import { GoalStore } from '@tools/goal';

/**
 * The stores for a session, wired the one way every host wires them: goal
 * entries and stream resources are released against the session that owns the
 * transcripts.
 *
 * Hosts differ in *when* they build this — the extension from its presentation,
 * the desktop and CLI from their process owner — never in how, so the wiring is
 * not theirs to restate. It lives here rather than as a `SessionStores` factory
 * because `@agent/storage` sits underneath the tool layer these hooks come
 * from; reaching back up from there closes an import cycle that leaves the
 * default session uninitialized at load.
 */
export function createSessionStores(session: SessionHandle): SessionStores {
  return new SessionStores({
    streamLogs: session.transcripts,
    snapshots: session.snapshots,
    goalEntries: {
      forget: (stream) => GoalStore.forget(stream, session),
      forgetMany: (streams) => GoalStore.forgetMany(streams, session),
    },
    onCanonicalStreamDeleted: (stream) => {
      session.status.clearStream(stream);
      releaseStreamResources(stream, session);
    },
    onChildrenDetached: (parent, children) => {
      const activeChildren = new Set(
        session.executions
          .getActiveChildren(parent)
          .map(({ childStreamId }) => childStreamId),
      );
      session.executions.detachActiveChildren(parent);
      for (const child of children) {
        if (activeChildren.has(child)) continue;
        session.events.emit({
          scope: 'session',
          event: {
            type: 'setParentStream',
            payload: { childStreamId: child, parentStreamId: null },
          },
        });
      }
    },
  });
}
