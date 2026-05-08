import { initPlatform, type Platform } from './platform';

export interface BootstrapOptions {
  buildPlatform(): Platform | Promise<Platform>;
  afterInit?(platform: Platform): void | Promise<void>;
}

export interface BootstrapResult {
  platform: Platform;
}

export async function bootstrap(
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  const services = await options.buildPlatform();
  initPlatform(services);
  if (options.afterInit) {
    await options.afterInit(services);
  }
  return { platform: services };
}

const NODE_SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
type NodeShutdownSignal = (typeof NODE_SHUTDOWN_SIGNALS)[number];

export interface WireNodeShutdownOptions {
  lifecycle: Pick<Platform['lifecycle'], 'runShutdown'>;
  signals?: readonly NodeShutdownSignal[];
  onError?: (error: unknown) => void;
  exit?: (code: number) => void;
}

export function wireNodeShutdownSignals(options: WireNodeShutdownOptions): {
  dispose(): void;
} {
  const signals = options.signals ?? NODE_SHUTDOWN_SIGNALS;
  let shuttingDown = false;
  const onError =
    options.onError ?? ((error) => console.error('[bootstrap]', error));
  const exit = options.exit ?? ((code) => process.exit(code));

  const handler = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    options.lifecycle
      .runShutdown()
      .catch(onError)
      .finally(() => exit(0));
  };

  for (const signal of signals) {
    process.once(signal, handler);
  }

  return {
    dispose: () => {
      for (const signal of signals) {
        process.off(signal, handler);
      }
    },
  };
}
