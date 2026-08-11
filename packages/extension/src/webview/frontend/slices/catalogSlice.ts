/**
 * Catalog slice: model/agent option pushes from the host.
 */

// Local imports - shared IPC and schemas
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { AgentOptionData, MainViewHandlerRegistry } from '@shared/schemas';
import { agentName } from '@shared/schemas/agent';
import { PREFERRED_TOOL_USE_AGENTS } from '@shared/constants/agents';
// Constants-only module: safe for the webview bundle (no platform imports).

// Local imports - main view
import {
  agent$,
  agentOptions$,
  sessionModelOptions$,
  teamOptions$,
  workingDirectory$,
  workspaceRootOptions$,
} from '../mainViewState';
import {
  enterToolUseSession,
  refreshModelSelectionForActiveSession,
  validateTeamSelection,
} from '../mainViewActions';

/**
 * Exact value match first, then plain-name match (source changes and
 * plain-name defaults), then the caller's preferred fallback list. With no
 * fallback list (workflow), an unresolvable agent keeps the stale value so
 * the dropdown shows no selection and execution errors explicitly.
 */
function validateAgentSelection(
  options: AgentOptionData[],
  currentValue: string,
  preferredFallback: readonly string[] = [],
): string {
  // Exact match, then match by name: handles source changes, plain-name
  // defaults, and remote rows whose value still carries legacy decorated
  // storage names.
  const match = findAgentSelection(options, currentValue);
  if (match) return match;
  for (const preferred of preferredFallback) {
    const fallbackMatch = options.find(
      (opt) => agentName(opt.value) === preferred,
    );
    if (fallbackMatch) return fallbackMatch.value;
  }
  // No match — keep stale value so the UI shows no selection.
  // Execution will error with "unknown agent" if the user proceeds.
  return currentValue;
}

function findAgentSelection(
  options: AgentOptionData[],
  candidate: string,
): string | undefined {
  const exact = options.find((opt) => opt.value === candidate);
  if (exact) return exact.value;
  const name = agentName(candidate);
  return options.find((opt) => agentName(opt.value) === name)?.value;
}

// `satisfies Partial<...>` (not `: MainViewHandlerRegistry`): this slice
// owns only catalog commands; see bannerSlice.ts for why (registry is now
// exhaustive, messageDispatcher.ts is the real coverage checkpoint).
export const catalogHandlers = {
  [MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS]: (message) => {
    sessionModelOptions$.set({
      workflow: message.optionsDataByCategory.workflow,
      toolUse: message.optionsDataByCategory.toolUse,
    });
    refreshModelSelectionForActiveSession();
  },

  [MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS]: (message) => {
    const optionsData = message.optionsData ?? {};

    if (optionsData.workflow) {
      agentOptions$.set({
        ...agentOptions$.get(),
        workflow: optionsData.workflow,
      });
      agent$.set({
        ...agent$.get(),
        workflow: validateAgentSelection(
          optionsData.workflow,
          agent$.get().workflow,
        ),
      });
    }

    if (optionsData.toolUse) {
      agentOptions$.set({
        ...agentOptions$.get(),
        toolUse: optionsData.toolUse,
      });
      const selectedToolUseAgent = message.selectedToolUseAgent
        ? findAgentSelection(optionsData.toolUse, message.selectedToolUseAgent)
        : undefined;
      agent$.set({
        ...agent$.get(),
        toolUse:
          selectedToolUseAgent ??
          validateAgentSelection(
            optionsData.toolUse,
            agent$.get().toolUse,
            // State 2 sanity (PRD: agent-native onboarding): a persisted agent
            // that no longer resolves (e.g. BYOK user with the sign-in-only
            // 'orchestrator' default) falls back along the preferred list
            // instead of leaving the dropdown with no selection.
            PREFERRED_TOOL_USE_AGENTS,
          ),
      });
      if (selectedToolUseAgent) {
        enterToolUseSession();
      }
    }
  },

  [MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS]: (message) => {
    teamOptions$.set(message.optionsData);
    // Only now that the resolved options have arrived can a restored team
    // selection be checked — the initially empty async list is not proof
    // the team vanished.
    validateTeamSelection();
  },

  [MAIN_VIEW_COMMANDS.SET_WORKSPACE_ROOTS]: (message) => {
    workspaceRootOptions$.set(message.optionsData);
    const selectedRoot = workingDirectory$.get();
    if (message.optionsData.some((option) => option.value === selectedRoot)) {
      return;
    }
    workingDirectory$.set(message.optionsData.at(0)?.value ?? '');
  },
} satisfies Partial<MainViewHandlerRegistry>;
