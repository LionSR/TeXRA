/**
 * Configuration facade for the agent layer.
 *
 * `getConfig` is a thin wrapper over `platform().config`; the single
 * implementation lives in `@utils/config`. This module re-exports it so agent
 * code can keep importing from `@agent/core/config`.
 */
export { getConfig } from '@utils/config/configUtils';
