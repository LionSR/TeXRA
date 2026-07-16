import type { UsageRoute } from '@shared/schemas';

import type { CliApiMode } from './apiAccessMode';

export type CliModelAccessRoute = 'chatgpt' | 'included' | 'personal';

export interface CliModelAccessStatus {
  readonly active: CliModelAccessRoute;
  readonly chatGptSignedIn: boolean;
  readonly chatGptAccountLabel?: string;
  readonly texraSignedIn?: boolean;
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
