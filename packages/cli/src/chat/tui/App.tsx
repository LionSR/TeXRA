// Phase 0 hello-world `<App>` — exists only to validate the React Compiler
// Babel pre-pass wired in scripts/reactCompilerPlugin.mjs, exercised by
// `scripts/smoke-react-compiler.mjs` on every build. Not imported from any
// runtime path yet. The skeleton TUI lands in Phase 1.

import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

export function App(): ReactElement {
  return (
    <Box>
      <Text>TeXRA TUI scaffold ready (Phase 1+).</Text>
    </Box>
  );
}
