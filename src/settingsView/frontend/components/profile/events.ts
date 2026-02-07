import { createEvent } from '@shared/utils/events';
import type { AgentSourceType } from '@shared/schemas/agent';

export const ProfileViewEvents = {
  signIn: () => createEvent('profile-sign-in', undefined),
  signOut: () => createEvent('profile-sign-out', undefined),
  selectAgent: (detail: { agentName: string }) =>
    createEvent('profile-select-agent', detail),
  setApiAccessMode: (detail: { mode: 'included' | 'personal' }) =>
    createEvent('profile-api-access-mode', detail),
} as const;

export const ModelSelectionEvents = {
  setModelEnabled: (detail: { modelName: string; enabled: boolean }) =>
    createEvent('model-enabled-set', detail),
  setPolishModel: (detail: { modelName: string }) =>
    createEvent('polish-model-set', detail),
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
} as const;

export const AgentSelectionEvents = {
  openYaml: (detail: {
    agentName: string;
    agentSource: AgentSourceType;
    variant: 'base' | 'multiple';
  }) => createEvent('agent-open-yaml', detail),
  setEnabled: (detail: {
    agentName: string;
    agentSource: AgentSourceType;
    category: 'workflow' | 'toolUse';
    enabled: boolean;
  }) => createEvent('agent-enabled-set', detail),
  openFolder: (detail: {
    folderType: 'custom' | 'builtInWorkflow' | 'builtInToolUse';
  }) => createEvent('agent-open-folder', detail),
  createAgent: () => createEvent('agent-create', undefined),
  setCustomDir: () => createEvent('agent-set-custom-dir', undefined),
  resetCustomDir: () => createEvent('agent-reset-custom-dir', undefined),
  setAutoShowRemote: (detail: { enabled: boolean }) =>
    createEvent('agent-auto-show-remote', detail),
} as const;
