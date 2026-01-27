function createEvent<T>(type: string, detail: T): CustomEvent<T> {
  return new CustomEvent(type, { detail, bubbles: true, composed: true });
}

export const ProfileViewEvents = {
  signIn: () => createEvent('profile-sign-in', undefined),
  signOut: () => createEvent('profile-sign-out', undefined),
  selectAgent: (detail: { agentName: string }) =>
    createEvent('profile-select-agent', detail),
  setApiAccessMode: (detail: { mode: 'included' | 'personal' }) =>
    createEvent('profile-api-access-mode', detail),
} as const;
