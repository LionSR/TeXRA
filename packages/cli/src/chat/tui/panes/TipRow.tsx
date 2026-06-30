import { Box, Text } from 'ink';

const QUEUE_FOLLOW_UP_TIP =
  'Type while a response is running to queue a follow-up';
const IDLE_QUEUE_FOLLOW_UP_FALLBACK_TIP =
  'Press Ctrl-R to search your input history';

const BASE_TIPS = [
  'Use /help to see available commands',
  'Press /model to switch models',
  'Ctrl-C exits idle chats; stops active responses',
  'Use /clear to start fresh',
  'Press /status to see session details',
  'Press /api to view or change API mode',
  'Press Ctrl-T to read the full transcript',
  QUEUE_FOLLOW_UP_TIP,
  'Press Ctrl-R to search your input history',
  'Use /resume to continue a previous session',
] as const;

const AGENT_SELECTION_TIP = 'Press /agent to choose the root agent';

export function tipRowText({
  agentSelectionAvailable = false,
  hour,
  responseRunning = false,
}: {
  readonly agentSelectionAvailable?: boolean;
  readonly hour: number;
  readonly responseRunning?: boolean;
}): string {
  if (responseRunning) {
    return QUEUE_FOLLOW_UP_TIP;
  }

  const tips = agentSelectionAvailable
    ? [BASE_TIPS[0], BASE_TIPS[1], AGENT_SELECTION_TIP, ...BASE_TIPS.slice(2)]
    : BASE_TIPS;
  const index = ((hour % tips.length) + tips.length) % tips.length;
  const tip = tips[index]!;
  return tip === QUEUE_FOLLOW_UP_TIP ? IDLE_QUEUE_FOLLOW_UP_FALLBACK_TIP : tip;
}

export function TipRow(props: {
  readonly agentSelectionAvailable?: boolean;
  readonly hour: number;
  readonly responseRunning?: boolean;
}): React.JSX.Element {
  return (
    <Box paddingX={1}>
      <Text dimColor>Tip: {tipRowText(props)}</Text>
    </Box>
  );
}
