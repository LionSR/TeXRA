// A scope a component's mount owns: made on the first render and closed at
// unmount, which interrupts every fiber forked into it. A component's
// supersedable reads and its in-flight work live here instead of in refs of
// fibers interrupted by hand.

// Third-party imports
import { Exit, Scope } from 'effect';
import { useEffect, useState } from 'react';

// Local imports
import type { ProcessRuntime } from '@texra-ai/harness/host';

export function useMountScope(runtime: ProcessRuntime): Scope.Closeable {
  const [scope] = useState(() => runtime.runSync(Scope.make()));
  useEffect(
    () => () => {
      runtime.runFork(Scope.close(scope, Exit.void));
    },
    [runtime, scope],
  );
  return scope;
}
