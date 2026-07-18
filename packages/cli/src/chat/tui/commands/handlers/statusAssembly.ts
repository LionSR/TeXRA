import type { CliApiMode } from '@cli/runtime/apiAccessMode';
import {
  loadCliApiStatusLines,
  loadCliModelAccessOverview,
} from '@cli/runtime/apiStatus';
import { resolveCliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import { isCodexSubscriptionActive } from '@model/codexSubscriptionActive';
import type { AgentCategory, UsageRoute } from '@shared/schemas';

/** Load the canonical account/access snapshot used by TUI status commands. */
export async function loadCliStatusAssembly(options: {
  readonly apiMode: CliApiMode;
  readonly includeApiDetails?: boolean;
  readonly target?: {
    readonly model: string;
    readonly category: AgentCategory | undefined;
    readonly usageRoute?: UsageRoute;
  };
}) {
  const [overview, apiStatusLines] = await Promise.all([
    loadCliModelAccessOverview({ apiMode: options.apiMode }),
    options.includeApiDetails
      ? loadCliApiStatusLines({ apiMode: options.apiMode })
      : Promise.resolve([]),
  ]);
  const detailLines = apiStatusLines
    .slice(2)
    .filter((line) => !overview.lines.includes(line));
  let subscriptionActive = overview.access.active === 'chatgpt';
  if (options.target) {
    subscriptionActive =
      options.target.category === undefined
        ? false
        : await isCodexSubscriptionActive(
            options.target.model,
            options.target.category,
          );
  }
  return {
    lines: [...overview.lines, ...detailLines],
    modelAccess: resolveCliModelAccessRoute({
      apiMode: options.apiMode,
      subscriptionActive,
      usageRoute: options.target?.usageRoute,
    }),
  };
}
