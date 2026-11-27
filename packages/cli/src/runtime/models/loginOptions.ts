import { isSubscriptionAuthProvider } from '@texra-ai/worldline/schemas';
import type { SubscriptionProviderId } from '@texra/controllers/modelAccess/subscriptionProviders';

/**
 * How a subscription sign-in reaches the browser: `auto` opens one and waits
 * on the loopback callback, `no-browser` prints that URL to paste, `device`
 * shows a one-time code. As a request, `auto` also lets the terminal choose
 * a device code (`resolveLoginTransport`).
 */
export type LoginTransport = 'auto' | 'device' | 'no-browser';

/** A `/login` request: one subscription provider and its sign-in transport. */
export interface CliLoginSlashArgs {
  readonly target: SubscriptionProviderId;
  readonly transport: LoginTransport;
}

export type CliLogoutTarget = SubscriptionProviderId | 'all';

/** Account & access form sign-in rows: a provider plus its sign-in transport
 *  (browser by default, `--device` for the device-code flow). Every value
 *  parses through `parseChatLoginSlashArgs`. */
export type LoginFormValue =
  | SubscriptionProviderId
  | `${SubscriptionProviderId} --device`;

// `--device` and `--no-browser` are distinct sign-in transports, not
// refinements of each other (device-code shows no loopback URL). The chat
// `/login` path rejects the combination so the choice is explicit.
export const LOGIN_TRANSPORT_CONFLICT_MESSAGE =
  'Use either --device or --no-browser, not both: --device signs in with a one-time code (no loopback URL), while --no-browser prints the loopback sign-in URL.';

/** The parsed `/login` arguments; `'conflict'` when both transport flags are
 *  given, undefined when the input is not a `/login` request at all. */
export function parseChatLoginSlashArgs(
  input: string,
): CliLoginSlashArgs | 'conflict' | undefined {
  const positionals: string[] = [];
  const transports = new Set<LoginTransport>();
  for (const token of input.trim().split(/\s+/).filter(Boolean)) {
    if (token === '--no-browser') transports.add('no-browser');
    else if (token === '--device') transports.add('device');
    else if (token.startsWith('--')) return undefined;
    else positionals.push(token);
  }
  if (positionals.length !== 1) return undefined;
  const [name] = positionals;
  if (!isSubscriptionAuthProvider(name)) return undefined;
  if (transports.size > 1) return 'conflict';
  const [transport = 'auto'] = transports;
  return { target: name, transport };
}
