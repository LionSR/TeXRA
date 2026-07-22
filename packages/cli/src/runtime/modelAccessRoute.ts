import type { UsageRoute } from '@shared/schemas';

import { parseCliApiMode, type CliApiMode } from './apiAccessMode';

export type CliModelAccessRoute =
  'chatgpt' | 'kimi-code' | 'included' | 'personal';

export interface CliModelAccessStatus {
  readonly active: CliModelAccessRoute;
  readonly chatGptSignedIn: boolean;
  readonly chatGptAccountLabel?: string;
  readonly kimiCodeKeySet?: boolean;
  readonly texraSignedIn?: boolean;
}

interface CliModelAccessItem {
  readonly value: CliModelAccessRoute;
  readonly label: string;
  readonly description: string;
}

export function parseCliModelAccessRoute(
  input: string,
): CliModelAccessRoute | undefined {
  const apiMode = parseCliApiMode(input);
  if (apiMode) return apiMode;

  switch (input.trim().toLowerCase()) {
    case 'chatgpt':
    case 'subscription':
      return 'chatgpt';
    case 'kimi':
    case 'kimicode':
    case 'kimi-code':
      return 'kimi-code';
    default:
      return undefined;
  }
}

/** Prefer the route that produced usage; otherwise describe the next request. */
export function resolveCliModelAccessRoute({
  apiMode,
  subscriptionActive,
  kimiCodeActive,
  usageRoute,
}: {
  readonly apiMode: CliApiMode;
  readonly subscriptionActive: boolean;
  readonly kimiCodeActive?: boolean;
  readonly usageRoute?: UsageRoute;
}): CliModelAccessRoute {
  if (usageRoute !== undefined) {
    switch (usageRoute) {
      case 'chatgpt-subscription':
        return 'chatgpt';
      case 'relay':
        return 'included';
      case 'api-key':
        // Kimi Code usage records as a plain `api-key`; a completed request's
        // route cannot change, so never relabel it from live preferences.
        return 'personal';
      default:
        return usageRoute satisfies never;
    }
  }
  if (subscriptionActive) return 'chatgpt';
  // The Kimi Code route only describes personal access — under included
  // access the relay owns eligible models.
  if (kimiCodeActive === true && apiMode === 'personal') return 'kimi-code';
  return apiMode;
}

export function shortCliModelAccessRoute(route: CliModelAccessRoute): string {
  if (route === 'chatgpt') return 'subscription';
  return route;
}

export function formatCliModelAccessRoute(route: CliModelAccessRoute): string {
  switch (route) {
    case 'chatgpt':
      return 'ChatGPT subscription';
    case 'kimi-code':
      return 'Kimi Code subscription';
    case 'included':
      return 'Included TeXRA access';
    case 'personal':
      return 'Personal API keys';
    default:
      return route satisfies never;
  }
}

/** Sentence-fragment form derived from the canonical access label. */
export function formatCliModelAccessRouteInline(
  route: CliModelAccessRoute,
): string {
  const label = formatCliModelAccessRoute(route);
  // Proper-noun labels keep their casing; plain labels lowercase like prose.
  return route === 'chatgpt' || route === 'kimi-code'
    ? label
    : label.charAt(0).toLowerCase() + label.slice(1);
}

/** Build the canonical choices shown by every model-access picker. */
export function buildCliModelAccessItems(
  status: CliModelAccessStatus,
): CliModelAccessItem[] {
  let chatGptDescription: string;
  if (status.active === 'chatgpt') {
    chatGptDescription = `On · ${status.chatGptAccountLabel ?? 'your account'}`;
  } else if (status.chatGptSignedIn) {
    chatGptDescription = `Off · ${status.chatGptAccountLabel ?? 'your account'}`;
  } else {
    chatGptDescription = 'Sign in with ChatGPT Plus/Pro/Team';
  }

  let kimiCodeDescription: string;
  if (status.kimiCodeKeySet !== true) {
    kimiCodeDescription = 'Add a key with /key (kimi.com/code/console)';
  } else if (status.active === 'kimi-code') {
    kimiCodeDescription = 'On · key configured';
  } else {
    kimiCodeDescription = 'Off · key configured';
  }

  return [
    {
      value: 'chatgpt',
      label: 'Prefer ChatGPT subscription',
      description: chatGptDescription,
    },
    {
      value: 'kimi-code',
      label: 'Prefer Kimi Code subscription',
      description: kimiCodeDescription,
    },
    {
      value: 'included',
      label: formatCliModelAccessRoute('included'),
      description:
        status.texraSignedIn === false
          ? 'Sign in through Account to use included models'
          : 'Use your TeXRA account',
    },
    {
      value: 'personal',
      label: formatCliModelAccessRoute('personal'),
      description: 'Use keys configured on this computer',
    },
  ];
}
