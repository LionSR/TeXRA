import { Box, Text } from 'ink';

const BASE_TIPS = [
  'Use /help to see available commands',
  'Press /model to switch models',
  'Ctrl-C exits idle chats; stops active responses',
  'Use /clear to start fresh',
  'Press /status to see session details',
  'Press /api to view or change API mode',
] as const;

const AGENT_SELECTION_TIP = 'Press /agent to choose the root agent';

export function tipRowText({
  agentSelectionAvailable = false,
  hour = new Date().getHours(),
}: {
  readonly agentSelectionAvailable?: boolean;
  readonly hour?: number;
} = {}): string {
  const tips = agentSelectionAvailable
    ? [BASE_TIPS[0], BASE_TIPS[1], AGENT_SELECTION_TIP, ...BASE_TIPS.slice(2)]
    : BASE_TIPS;
  const index = ((hour % tips.length) + tips.length) % tips.length;
  return tips[index]!;
}

export function TipRow(props: {
  readonly agentSelectionAvailable?: boolean;
}): React.JSX.Element {
  // Pick a deterministic tip based on the current hour so it rotates
  // naturally without timers or extra state.
  const tip = tipRowText({
    agentSelectionAvailable: props.agentSelectionAvailable,
  });

  return (
    <Box paddingX={1}>
      <Text dimColor>Tip: {tip}</Text>
    </Box>
  );
}
