import { createEvent } from '@shared/utils/events';

export const ProfileViewEvents = {
  signIn: () => createEvent('profile-sign-in', undefined),
  signOut: () => createEvent('profile-sign-out', undefined),
  selectAgent: (detail: { agentName: string }) =>
    createEvent('profile-select-agent', detail),
  setApiAccessMode: (detail: { mode: 'included' | 'personal' }) =>
    createEvent('profile-api-access-mode', detail),
} as const;

export const ProviderKeyEvents = {
  setKey: (detail: { provider: string }) =>
    createEvent('provider-key-set', detail),
  removeKey: (detail: { provider: string }) =>
    createEvent('provider-key-remove', detail),
  openKeyUrl: (detail: { provider: string }) =>
    createEvent('provider-key-open-url', detail),
} as const;
