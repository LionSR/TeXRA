// Local imports - platform
import type { Platform } from '@platform/platform';

/** Private hook carried by package-provided platforms that need post-init work. */
export const PACKAGE_RUNTIME_INITIALIZER = Symbol(
  '@texra-ai/agent/runtime-initializer',
);

/** Platform with a package-owned runtime initializer. */
export type PackageRuntimePlatform = Platform & {
  readonly [PACKAGE_RUNTIME_INITIALIZER]?: () => void;
};
