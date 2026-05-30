import { useEffect, useState } from 'react';

export function useLiveNowMs(shouldTick: boolean, resetKey?: unknown): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!shouldTick) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [resetKey, shouldTick]);

  return nowMs;
}
