/**
 * Shared main-view fixtures: the `SessionContextValue`/`TeamOptionData`
 * literals and the jsdom mount harness for `<instruction-panel>`.
 *
 * The session literal carries every field of the context value, so keeping one
 * copy here is what stops the three main-view suites from drifting apart when
 * the schema grows a field.
 */

// Local imports - shared schemas
import type { SessionContextValue, TeamOptionData } from '@shared/schemas';

// Local imports - component type and context
import type { InstructionPanel } from '@webview/frontend/components/InstructionPanel';
import type { sessionContext } from '@webview/frontend/mainViewContexts';
import type { ContextProvider } from '@lit/context';

// @lit/context's request/provider event classes capture the global `Event`
// constructor at module-evaluation time, so every import that transitively
// pulls it in (the context definition, ContextProvider) must stay dynamic —
// evaluated only inside `loadInstructionPanelModules`, after the jsdom globals
// are installed.
let ContextProviderCtor: typeof ContextProvider;
let mainViewSessionContext: typeof sessionContext;

const sessionProviders = new WeakMap<
  InstructionPanel,
  { setValue(value: SessionContextValue): void }
>();

/**
 * Imports @lit/context, the main-view session context and the panel component.
 * Call from `useLitComponentTestDom`, which runs it after installing the DOM
 * globals those modules capture.
 */
export async function loadInstructionPanelModules(): Promise<void> {
  ({ ContextProvider: ContextProviderCtor } = await import('@lit/context'));
  ({ sessionContext: mainViewSessionContext } =
    await import('@webview/frontend/mainViewContexts'));
  await import('@webview/frontend/components/InstructionPanel');
}

export function makeSession(
  overrides: Partial<SessionContextValue> = {},
): SessionContextValue {
  return {
    sessionType: 'toolUse',
    launchTarget: 'agent',
    selectedTeamId: '',
    instruction: '',
    placeholder: 'Describe the edit…',
    agent: { workflow: 'copy-editor', toolUse: 'assistant' },
    model: 'model-a',
    agentOptions: { workflow: [], toolUse: [] },
    modelOptions: [],
    teamOptions: [],
    workspaceRootOptions: [],
    workingDirectory: '',
    isRecording: false,
    isPolishing: false,
    debugMode: false,
    isOrchestratorSelected: false,
    statusAnnouncement: '',
    ...overrides,
  };
}

export function teamOption(
  value: string,
  overrides: Partial<TeamOptionData> = {},
): TeamOptionData {
  return {
    value,
    label: value,
    icon: 'bookmark',
    source: 'built-in',
    description: '',
    unavailableMembers: [],
    rootAgentName: null,
    ...overrides,
  };
}

/** Mount `<instruction-panel>` under a session-context provider. */
export async function mountInstructionPanel(
  session: SessionContextValue,
  {
    desktopHost = false,
    showSessionHint = true,
  }: { desktopHost?: boolean; showSessionHint?: boolean } = {},
): Promise<InstructionPanel> {
  const wrapper = document.createElement('div');
  const provider = new ContextProviderCtor(wrapper, {
    context: mainViewSessionContext,
    initialValue: session,
  });
  // ContextProvider treats plain elements as dumb hosts: the context-request
  // listener is only attached on hostConnected(), which nothing calls for us.
  provider.hostConnected();

  const element = document.createElement(
    'instruction-panel',
  ) as InstructionPanel;
  element.desktopHost = desktopHost;
  element.showSessionHint = showSessionHint;
  wrapper.append(element);
  document.body.append(wrapper);
  sessionProviders.set(element, provider);
  await element.updateComplete;
  return element;
}

/** Push a new session value through the provider a panel was mounted with. */
export async function updateInstructionPanelSession(
  element: InstructionPanel,
  session: SessionContextValue,
): Promise<void> {
  sessionProviders.get(element)?.setValue(session);
  await element.updateComplete;
}
