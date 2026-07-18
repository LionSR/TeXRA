import type { UsageRoute } from '@shared/schemas';

import { parseCliApiMode, type CliApiMode } from './apiAccessMode';

export type CliModelAccessRoute = 'chatgpt' | 'included' | 'personal';

export interface CliModelAccessStatus {
  readonly active: CliModelAccessRoute;
  readonly chatGptSignedIn: boolean;
  readonly chatGptAccountLabel?: string;
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
    default:
      return undefined;
  }
}

/** Prefer the route that produced usage; otherwise describe the next request. */
export function resolveCliModelAccessRoute({
  apiMode,
  subscriptionActive,
  usageRoute,
}: {
  readonly apiMode: CliApiMode;
  readonly subscriptionActive: boolean;
  readonly usageRoute?: UsageRoute;
}): CliModelAccessRoute {
  if (usageRoute !== undefined) {
    switch (usageRoute) {
      case 'chatgpt-subscription':
        return 'chatgpt';
      case 'relay':
        return 'included';
      case 'api-key':
        return 'personal';
      default:
        return usageRoute satisfies never;
    }
  }
  return subscriptionActive ? 'chatgpt' : apiMode;
}

export function shortCliModelAccessRoute(route: CliModelAccessRoute): string {
  return route === 'chatgpt' ? 'subscription' : route;
}

export function formatCliModelAccessRoute(route: CliModelAccessRoute): string {
  switch (route) {
    case 'chatgpt':
      return 'ChatGPT subscription';
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
  return route === 'chatgpt'
    ? label
    : label.charAt(0).toLowerCase() + label.slice(1);
}

/** Build the canonical three choices shown by every model-access picker. */
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

  return [
    {
      value: 'chatgpt',
      label: 'Prefer ChatGPT subscription',
      description: chatGptDescription,
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
