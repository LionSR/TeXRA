import { readCliEnv } from './cliContext';

/**
 * Heuristic for "this terminal probably can't open a local browser or
 * receive a loopback OAuth callback": SSH sessions export one of these
 * variables. Used to recommend device-code sign-in, never to force it.
 */
export function isLikelyRemoteSession(
  env: Record<string, string | undefined> = readCliEnv(),
): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
}
