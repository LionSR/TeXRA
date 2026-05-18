import { Box, Text } from 'ink';

const TIPS = [
  'Use /help to see available commands',
  'Press /model to switch models',
  'Press /agent to switch agents',
  'Press Ctrl-C to interrupt',
  'Use /clear to start fresh',
  'Press /status to see session details',
  'Press /api to view or change API mode',
] as const;

export function TipRow(): React.JSX.Element {
  // Pick a deterministic tip based on the current hour so it rotates
  // naturally without timers or extra state.
  const index = new Date().getHours() % TIPS.length;

  return (
    <Box paddingX={1}>
      <Text dimColor>Tip: {TIPS[index]}</Text>
    </Box>
  );
}
