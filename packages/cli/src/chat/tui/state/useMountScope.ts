// The runner of a scope a component's mount owns: made on the first render
// and closed at unmount, which interrupts every fiber started through it. A
// component's supersedable reads, its timers and the streams it follows run
// here instead of in refs of fibers interrupted by hand.

// Third-party imports
import { useEffect, useState } from 'react';

// Local imports
import type { ScopeRunner } from '../../scopeRunner';
import { useChatProcess } from '../chatProcess';

export function useMountScope(): ScopeRunner {
  const { chat } = useChatProcess();
  const [mount] = useState(() => chat.child());
  useEffect(() => mount.close, [mount]);
  return mount;
}
