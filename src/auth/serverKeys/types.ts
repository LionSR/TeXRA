/**
 * Type definitions for server-side API key access.
 *
 * SERVER_SIDE_PROVIDERS and ServerSideProvider are re-exported from
 * @shared/constants/providers where they are derived from the canonical
 * PROVIDER_REGISTRY — no manual sync needed.
 */
export {
  SERVER_SIDE_PROVIDER_IDS as SERVER_SIDE_PROVIDERS,
  type ServerSideProvider,
} from '@shared/constants/providers';
