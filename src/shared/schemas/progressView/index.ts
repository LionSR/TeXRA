/**
 * ProgressView schemas - messages and data.
 *
 * Public entry point: external code (webviews, CLI, desktop) imports from
 * `@shared/schemas/progressView` or via the `@shared/schemas` barrel. The
 * schemas are split into focused modules; this file re-exports them so import
 * sites stay unchanged.
 *
 * - `./data`           - shared field schemas + tool-use/web-search/web-fetch payloads
 * - `./projectionShape` - canonical SYNC_STREAM_CONTENT projection shape +
 *                         `pickProjection` derivation helper
 * - `./outbound`       - backend → frontend messages (UPDATE_*, SYNC_*) + union
 * - `./inbound`        - frontend → backend messages (actions, follow-ups) +
 *                        union + dispatcher
 */
export * from './data';
export * from './projectionShape';
export * from './outbound';
export * from './inbound';
