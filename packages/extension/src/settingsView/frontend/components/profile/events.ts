import { createEvent } from '@shared/utils/events';
import type { AgentSourceType } from '@shared/schemas/agent';

export const ProfileViewEvents = {
  setApiAccessMode: (detail: { mode: 'included' | 'personal' }) =>
    createEvent('profile-api-access-mode', detail),
} as const;

export const ModelSelectionEvents = {
  setModelEnabled: (detail: { modelName: string; enabled: boolean }) =>
    createEvent('model-enabled-set', detail),
  setHelperModel: (detail: { modelName: string }) =>
    createEvent('helper-model-set', detail),
  setReasoningLevel: (detail: { modelName: string; level: string | null }) =>
    createEvent('model-reasoning-level-set', detail),
  setPreferShortModelNames: (detail: { enabled: boolean }) =>
    createEvent('prefer-short-model-names-set', detail),
} as const;

export const ProviderKeyEvents = {
  setKey: (detail: { provider: string }) =>
    createEvent('provider-key-set', detail),
  removeKey: (detail: { provider: string }) =>
    createEvent('provider-key-remove', detail),
  openKeyUrl: (detail: { provider: string }) =>
    createEvent('provider-key-open-url', detail),
  setStreaming: (detail: { provider: string; enabled: boolean }) =>
    createEvent('provider-streaming-set', detail),
  setEndpoint: (detail: { provider: string; endpoint: string }) =>
    createEvent('provider-endpoint-set', detail),
  setGlobalStreaming: (detail: { enabled: boolean }) =>
    createEvent('provider-global-streaming-set', detail),
  setVscodeSetting: (detail: { key: string; value: boolean | number }) =>
    createEvent('provider-vscode-setting-set', detail),
  openUrl: (detail: { url: string }) =>
    createEvent('provider-open-url', detail),
} as const;

export const AgentSelectionEvents = {
  openYaml: (detail: { agentName: string; agentSource: AgentSourceType }) =>
    createEvent('agent-open-yaml', detail),
  setEnabled: (detail: {
    agentName: string;
    agentSource: AgentSourceType;
    category: 'workflow' | 'toolUse';
    enabled: boolean;
  }) => createEvent('agent-enabled-set', detail),
  setAllEnabled: (detail: {
    category: 'workflow' | 'toolUse';
    source: AgentSourceType;
    enabled: boolean;
  }) => createEvent('agent-all-enabled-set', detail),
  openFolder: (detail: { folderType: 'custom' }) =>
    createEvent('agent-open-folder', detail),
  createAgent: (detail: {
    category: 'workflow' | 'toolUse';
    mode?: 'ai' | 'template';
  }) => createEvent('agent-create', detail),
  customizeAgent: (detail: {
    agentName: string;
    agentSource: AgentSourceType;
  }) => createEvent('agent-customize', detail),
  deleteCustomAgent: (detail: { agentName: string }) =>
    createEvent('agent-delete-custom', detail),
  setCustomDir: () => createEvent('agent-set-custom-dir', undefined),
  resetCustomDir: () => createEvent('agent-reset-custom-dir', undefined),
  revealAgentFile: (detail: {
    agentName: string;
    agentSource: AgentSourceType;
  }) => createEvent('agent-reveal-file', detail),
  viewRemotePrompt: (detail: { agentName: string }) =>
    createEvent('agent-view-remote-prompt', detail),
  // Keep the event name stable because SettingsApp already listens for it.
  saveTeam: () => createEvent('save-agent-mode-preset', undefined),
} as const;
