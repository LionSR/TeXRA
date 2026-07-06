import type { AgentEvent } from '@agent/trace';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';

import {
  emitLegacySessionFactOnHost,
  type SessionEventHub,
} from './SessionEventHub';

function emitLegacyRunEvent(
  runtimeHost: AgentRuntimeHost,
  streamId: StreamTabId,
  event: AgentEvent,
): void {
  if (event.type === 'stage.start') {
    if (event.kind !== 'round') return;
    runtimeHost.emit('updateRoundStage', {
      streamId,
      roundStage: {
        index: event.index ?? 0,
        ...(event.total !== undefined && event.total > 0
          ? { total: event.total }
          : {}),
      },
    });
    return;
  }

  if (event.type === 'child.activity') {
    if (event.kind === 'subagents') {
      runtimeHost.emit('updateActiveSubagents', {
        parentStreamId: event.parentStreamId,
        children: [...event.children],
      });
      return;
    }
    if (event.kind === 'processes') {
      runtimeHost.emit('updateActiveProcesses', {
        parentStreamId: event.parentStreamId,
        processes: [...event.processes],
      });
      return;
    }
    runtimeHost.emit('setParentStream', {
      childStreamId: event.childStreamId,
      parentStreamId: event.parentStreamId,
    });
    return;
  }

  if (event.type === 'process.output') {
    runtimeHost.emit('updateProcessOutput', {
      parentStreamId: event.parentStreamId,
      executionId: event.executionId,
      stdout: event.stdout,
      stderr: event.stderr,
    });
  }
}

/**
 * Temporary Stage 3a bridge from the new session-owned fact plane to the old
 * ProgressEventPayloads surface. It is intentionally finite and one-way:
 * SessionEventHub remains the source of truth for the migrated facts, while
 * legacy hosts keep their byte-identical payload names until their consumers
 * move to the session plane.
 */
export function attachLegacyProgressEventProjection(
  events: SessionEventHub,
  runtimeHost: AgentRuntimeHost,
): () => void {
  const detachSessionFacts = events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope === 'session') {
        emitLegacySessionFactOnHost(runtimeHost, sessionEvent.event);
      }
    },
    { scope: 'session' },
  );
  const detachRunFacts = events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'run') return;
      emitLegacyRunEvent(
        runtimeHost,
        sessionEvent.streamId,
        sessionEvent.event,
      );
    },
    {
      scope: 'run',
      types: ['stage.start', 'child.activity', 'process.output'],
    },
  );

  return () => {
    detachRunFacts();
    detachSessionFacts();
  };
}
