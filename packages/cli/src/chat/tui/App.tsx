// Phase 0 hello-world `<App>` — exists only to validate the React Compiler
// Babel pre-pass wired in scripts/reactCompilerPlugin.mjs. Not imported from
// any runtime path yet. The skeleton TUI lands in Phase 1.

import { Box, Text } from 'ink';

export function App(): JSX.Element {
  return (
    <Box>
      <Text>TeXRA TUI scaffold ready (Phase 1+).</Text>
    </Box>
  );
}
