import type { CliApiMode } from '@cli/runtime/apiAccessMode';
import {
  loadCliApiStatus,
  loadCliModelAccessOverview,
} from '@cli/runtime/apiStatus';

/** Load the canonical account snapshot used by TUI account commands. */
export async function loadCliAccountStatusLines(options: {
  readonly apiMode: CliApiMode;
  readonly includeApiDetails?: boolean;
}): Promise<string[]> {
  const [overview, apiStatus] = await Promise.all([
    loadCliModelAccessOverview({ apiMode: options.apiMode }),
    options.includeApiDetails
      ? loadCliApiStatus({ apiMode: options.apiMode })
      : Promise.resolve(undefined),
  ]);
  const detailLines =
    apiStatus?.detailLines.filter((line) => !overview.lines.includes(line)) ??
    [];
  return [...overview.lines, ...detailLines];
}
