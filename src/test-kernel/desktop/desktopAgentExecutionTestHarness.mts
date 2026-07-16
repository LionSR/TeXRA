// Third-party imports
import { onTestFinished } from 'vitest';

// Local imports - desktop types
import type { DesktopAgentExecutionHost } from '@desktop/main/desktopAgentExecutionHost';

// Local imports - shared schemas
import type { RunOutcome } from '@shared/schemas';
import type { OutputFileSummary } from '@shared/schemas/output';

export type DesktopAgentExecutionModule =
  typeof import('@desktop/main/desktopAgentExecution');

export type RunExecutionRequest = (
  request: unknown,
  options: {
    openWorkflowOutput(result: {
      outcome: RunOutcome;
      outputs: Array<Pick<OutputFileSummary, 'absolutePath' | 'round'>>;
    }): Promise<void>;
    // This window's SessionHandle. The onboarding run-completion test drives a
    // terminal `result` event through it via `attachRunTrace`.
    session: {
      attachRunTrace(
        trace: {
          subscribe(fn: (event: unknown) => void): unknown;
        },
        streamId: string,
      ): () => void;
    };
    runtimeUnavailableTools?: readonly string[];
  },
) => Promise<void>;

export function disposeAfterTest<T extends { dispose(): void }>(value: T): T {
  onTestFinished(() => value.dispose());
  return value;
}

export function createStubDesktopAgentExecutionHost(
  overrides: Partial<DesktopAgentExecutionHost> = {},
): DesktopAgentExecutionHost {
  return {
    openPath: async () => undefined,
    openBuildDisplay: async () => undefined,
    openDiff: async (original, proposed, title) => ({
      original,
      proposed,
      title,
    }),
    confirmAcceptFile: async () => true,
    showErrorMessage: async () => undefined,
    showInfoMessage: async () => undefined,
    onRunCompleted: () => undefined,
    ...overrides,
  };
}

/** Minimal AgentTrace stand-in for bridging terminal results into a session. */
export function makeFakeTrace(): {
  subscribe(fn: (event: unknown) => void): () => void;
  emit(event: unknown): void;
} {
  const subscribers = new Set<(event: unknown) => void>();
  return {
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    emit(event) {
      for (const fn of subscribers) fn(event);
    },
  };
}
