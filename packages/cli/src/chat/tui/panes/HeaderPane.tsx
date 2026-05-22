// Header pane — rendered at the top of Ink's live frame, just above the live
// output and below the committed `<Static>` history. It stays pinned with the
// prompt while finalized history scrolls away into the terminal's native
// scrollback.

import os from 'node:os';
import path from 'node:path';

import { Box, Text } from 'ink';

import { shortCliApiMode } from '../../../runtime/apiAccessMode';
import { cliState } from '../state/cliState';
import { useSignal } from '../state/useSignal';

function shortenCwd(cwd: string): string {
  const home = os.homedir();
  if (cwd === home) return '~';
  const sep = path.sep;
  if (cwd.startsWith(`${home}${sep}`)) {
    return `~${sep}${cwd.slice(home.length + sep.length)}`;
  }
  return cwd;
}

export function HeaderPane(): React.JSX.Element {
  const meta = useSignal(cliState.sessionMeta);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box gap={2}>
        <Text bold color="cyan">
          TeXRA
        </Text>
        <Text dimColor>v{meta.version}</Text>
        <Text dimColor>{shortCliApiMode(meta.apiMode)}</Text>
      </Box>
      <Box>
        <Text wrap="truncate-end">
          agent: {meta.agent || 'chat'} · model: {meta.model || '—'}
        </Text>
      </Box>
      <Text dimColor wrap="truncate-end">
        {shortenCwd(meta.cwd)}
      </Text>
    </Box>
  );
}
