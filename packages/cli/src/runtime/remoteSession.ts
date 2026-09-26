import { cliEnvValue } from './cliContext';

/**
 * Heuristic for "this terminal probably can't open a local browser or
 * receive a loopback OAuth callback": SSH sessions export one of these
 * variables. Used to recommend device-code sign-in, never to force it.
 */
export function isLikelyRemoteSession(): boolean {
  return ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY'].some((name) =>
    Boolean(cliEnvValue(name)),
  );
}
