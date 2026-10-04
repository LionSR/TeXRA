// Renders the active stream's plan as a one-line summary. Hidden without a
// plan.

import { Box, Text } from 'ink';

import { planSummaryLine, type Plan } from '@shared/schemas';

export function PlanPanel({
  maxRows,
  plan,
}: {
  readonly maxRows: number;
  readonly plan: Plan | null;
}): React.JSX.Element | null {
  // Like the child list above it, the panel owns one blank separator row so
  // the summary never sits flush against its neighbor. If the gap and the
  // summary row do not both fit, render nothing.
  if (!plan || maxRows < 2) return null;
  return (
    <Box marginTop={1} minWidth={0} overflowY="hidden" paddingX={1}>
      <Text dimColor wrap="truncate-end">
        {planSummaryLine(plan.objective)}
      </Text>
    </Box>
  );
}
