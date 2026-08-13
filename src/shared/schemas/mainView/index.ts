/**
 * MainView schemas - state, messages, and events.
 *
 * Public entry point: external code (webviews, CLI, desktop) imports from
 * `@shared/schemas/mainView` or via the `@shared/schemas` barrel. The schemas
 * are split into focused modules; this file re-exports them so import sites
 * stay unchanged.
 *
 * - `./state`    - session type, picker options, persisted state, banner
 *                  state, and event detail shapes
 * - `./outbound` - backend → frontend messages (SET_*, banners) + dispatcher
 * - `./inbound`  - frontend → backend messages (SELECT_*, EXECUTE, git diff,
 *                  housekeeping) + dispatcher
 *
 * Browser-safe main-view behavior helpers live in `@shared/mainView`; keep this
 * barrel focused on schemas and message contracts.
 */
export * from './state';
export * from './executeMessage';
export * from './outbound';
export * from './inbound';
