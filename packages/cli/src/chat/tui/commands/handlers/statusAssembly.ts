import type { CliApiMode } from '@cli/runtime/apiAccessMode';
import {
  loadCliApiStatusLines,
  loadCliModelAccessOverview,
} from '@cli/runtime/apiStatus';

/** Load the canonical account snapshot used by TUI account commands. */
export async function loadCliAccountStatusLines(options: {
  readonly apiMode: CliApiMode;
  readonly includeApiDetails?: boolean;
}): Promise<string[]> {
  const [overview, apiStatusLines] = await Promise.all([
    loadCliModelAccessOverview({ apiMode: options.apiMode }),
    options.includeApiDetails
      ? loadCliApiStatusLines({ apiMode: options.apiMode })
      : Promise.resolve([]),
  ]);
  const detailLines = apiStatusLines
    .slice(2)
    .filter((line) => !overview.lines.includes(line));
  return [...overview.lines, ...detailLines];
}
