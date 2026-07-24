import type {
  ModelAccessRoute,
  ModelAccessStatus,
  UsageRoute,
} from '@shared/schemas';
import {
  describeApiAccessModeStatus,
  MODEL_ACCESS_PREFERENCE_LABELS,
  MODEL_ACCESS_ROUTE_LABELS,
} from '@shared/schemas/modelAccess';

import { parseCliApiMode, type CliApiMode } from './apiAccessMode';

export type CliModelAccessRoute = ModelAccessRoute;
export type CliModelAccessStatus = ModelAccessStatus;

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
      case 'kimi-code-subscription':
        return 'kimi-code';
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
  if (kimiCodeActive === true) return 'kimi-code';
  return apiMode;
}

export function shortCliModelAccessRoute(route: CliModelAccessRoute): string {
  if (route === 'chatgpt') return 'subscription';
  return route;
}

export function formatCliModelAccessRoute(route: CliModelAccessRoute): string {
  return MODEL_ACCESS_ROUTE_LABELS[route];
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
  const chatGptAccount =
    status.chatGpt.email ?? status.chatGpt.accountId ?? 'your account';
  if (status.chatGpt.preferSubscription && status.chatGpt.signedIn) {
    chatGptDescription = `On · ${chatGptAccount}`;
  } else if (status.chatGpt.signedIn) {
    chatGptDescription = `Off · ${chatGptAccount}`;
  } else {
    chatGptDescription = 'Sign in with ChatGPT Plus/Pro/Team';
  }

  let kimiCodeDescription: string;
  if (status.kimiCode.keySet !== true) {
    kimiCodeDescription = 'Add a key with /key (kimi.com/code/console)';
  } else if (status.kimiCode.preferred) {
    kimiCodeDescription = 'On · key configured';
  } else {
    kimiCodeDescription = 'Off · key configured';
  }

  return [
    {
      value: 'chatgpt',
      label: MODEL_ACCESS_PREFERENCE_LABELS.chatgpt,
      description: chatGptDescription,
    },
    {
      value: 'kimi-code',
      label: MODEL_ACCESS_PREFERENCE_LABELS['kimi-code'],
      description: kimiCodeDescription,
    },
    {
      value: 'included',
      label: formatCliModelAccessRoute('included'),
      description: describeApiAccessModeStatus('included', status),
    },
    {
      value: 'personal',
      label: formatCliModelAccessRoute('personal'),
      description: describeApiAccessModeStatus('personal', status),
    },
  ];
}
