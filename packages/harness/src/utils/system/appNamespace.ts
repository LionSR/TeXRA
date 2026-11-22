/**
 * The embedding app's name for what the harness persists and reads from the
 * environment: the settings catalog's namespace (`texra` for TeXRA), served
 * once per process from that catalog. The harness spells no product itself,
 * so an embedder's store file and variables carry the embedder's word.
 */
import { Context } from 'effect';

/** The settings catalog's namespace, as the process serves it. */
export class AppNamespace extends Context.Service<AppNamespace, string>()(
  '@texra-ai/worldline/AppNamespace',
) {}

/** The database file of a storage root: `<namespace>.db`. */
export const storeFileName = (namespace: string): string => `${namespace}.db`;

/** The app's variable for `name`: `<NAMESPACE>_<NAME>`. */
export const appEnvName = (namespace: string, name: string): string =>
  `${namespace.toUpperCase()}_${name}`;
