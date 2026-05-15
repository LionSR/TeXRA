// Smoke target for the React Compiler Babel pre-pass
// (scripts/smoke-react-compiler.mjs). Not on any runtime path yet.

import { Text } from 'ink';
import type { ReactElement } from 'react';

export function App(): ReactElement {
  return <Text>TeXRA TUI scaffold ready (Phase 1+).</Text>;
}
