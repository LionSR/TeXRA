/**
 * `@platform` — the platform abstraction layer's public surface.
 *
 * CLAUDE.md instructs core code to "reach host services through `platform()`
 * from `@platform`". This barrel makes that documented import path real: it
 * re-exports the composition-root API from `./platform` so callers can write
 * `import { platform } from '@platform'` instead of reaching into
 * `@platform/platform`. The deeper path stays valid; this is the curated entry.
 */
export {
  initPlatform,
  platform,
  tryPlatform,
  tryGlobalState,
  type Platform,
} from './platform';
