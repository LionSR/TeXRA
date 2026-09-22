// Utilities for registering newly created agents

// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { createWorkspaceAgentRosterController, refresh } from '@agent/index';
import type { SessionHandle } from '@agent/runtime';
import { emitAppSignal } from '@eventBus/AppSignals';
import { withLogChannel } from '@logger/effectLog';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type { AgentSource } from '@shared/schemas';

const CHANNEL = 'AgentRegister';

export const promptToAddAgentToConfig = Effect.fnUntraced(function* (
  agentName: string,
  source: AgentSource,
  category: 'workflow' | 'toolUse',
  session: SessionHandle,
) {
  // The extension host holds one session; its roots are the workspace the
  // agent-creator wrote into.
  const roster = createWorkspaceAgentRosterController(session.roots);
  const alreadyVisible = (yield* roster.getVisibleAgents(category)).some(
    (entry) => entry.name === agentName,
  );

  if (alreadyVisible) {
    yield* Effect.logDebug(
      `Agent "${agentName}" already in configuration`,
    ).pipe(withLogChannel(CHANNEL));
    return;
  }

  const choice = yield* Effect.tryPromise({
    try: async () =>
      vscode.window.showInformationMessage(
        `Agent "${agentName}" was created or modified. Show it in the agent dropdown?`,
        'Add Agent',
        'Cancel',
      ),
    catch: (cause: unknown) => cause,
  });
  if (choice !== 'Add Agent') return;

  yield* roster.setAgentEnabled({
    category,
    source,
    name: agentName,
    enabled: true,
  });
  // Reload the catalog here rather than leaning on `refreshAllOptions`:
  // that command returns early when the main webview is closed, so the
  // reload it performs is conditional on an unrelated view being open. The
  // agent-creator just wrote this YAML, so a listener posting against the
  // stale cache would render a roster missing the agent it was told about.
  yield* refresh();
  // The write above rewrites the selection as `custom`, retiring any applied
  // team, so an open settings view needs the same notice `apply_team` sends.
  emitAppSignal('agentRosterChanged', undefined);
  yield* ProgressViewProvider.getInstance()?.refreshCatalogs({
    agentCatalogAlreadyFresh: true,
  }) ?? Effect.void;
  vscode.window.showInformationMessage(`Agent "${agentName}" is now visible`);
});
