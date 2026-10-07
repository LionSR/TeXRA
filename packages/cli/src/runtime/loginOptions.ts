import type { SubscriptionProviderId } from '@texra/controllers/modelAccess/subscriptionProviders';

/** A `/login` request: one subscription provider and its sign-in transport. */
export interface CliLoginSlashArgs {
  readonly target: SubscriptionProviderId;
  readonly noBrowser: boolean;
  readonly device: boolean;
}

export type CliLogoutTarget = SubscriptionProviderId | 'all';

/** Account & access form sign-in rows: a provider plus its sign-in transport
 *  (browser by default, `--device` for the device-code flow). Every value
 *  parses through `parseChatLoginSlashArgs`. */
export type LoginFormValue =
  SubscriptionProviderId | `${SubscriptionProviderId} --device`;

// `--device` and `--no-browser` are distinct sign-in transports, not
// refinements of each other (device-code shows no loopback URL), and the
// device branch silently wins when both are set. The chat `/login` path
// rejects the combination so the choice is explicit instead of quietly
// ignored.
export const LOGIN_TRANSPORT_CONFLICT_MESSAGE =
  'Use either --device or --no-browser, not both: --device signs in with a one-time code (no loopback URL), while --no-browser prints the loopback sign-in URL.';

export function hasLoginTransportConflict(
  args: Pick<CliLoginSlashArgs, 'device' | 'noBrowser'>,
): boolean {
  return args.device && args.noBrowser;
}

export function parseChatLoginSlashArgs(
  input: string,
): CliLoginSlashArgs | undefined {
  const positionals: string[] = [];
  let noBrowser = false;
  let device = false;
  for (const token of input.trim().split(/\s+/).filter(Boolean)) {
    if (token === '--no-browser') noBrowser = true;
    else if (token === '--device') device = true;
    else if (token.startsWith('--')) return undefined;
    else positionals.push(token);
  }
  if (positionals.length !== 1) return undefined;
  const [name] = positionals;
  return name === 'chatgpt' || name === 'grok'
    ? { target: name, noBrowser, device }
    : undefined;
}
