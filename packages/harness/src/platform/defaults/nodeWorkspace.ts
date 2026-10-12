/**
 * The environment a workspace's work sees: its `.env` over the process's.
 */
import { Context, Effect } from 'effect';

/**
 * The variables of the project the work belongs to, from its `.env` file,
 * served over this process's own environment by
 * `workspaceEnvironmentLayer` (`nodePlatform`): to each run as it launches, and to a
 * single-project host's own reads. One process (the service) holds many
 * projects without merging any of them into `process.env`. Empty elsewhere.
 */
export const ProjectEnvironment = Context.Reference<
  Readonly<Record<string, string>>
>('@texra/ProjectEnvironment', { defaultValue: () => ({}) });

/** The environment the work in hand sees: this process's, with its
 *  project's `.env` variables over it. */
export const environment: Effect.Effect<
  Readonly<Record<string, string | undefined>>
> = Effect.gen(function* () {
  const project = yield* ProjectEnvironment;
  // Windows names are case-insensitive: the project's `PATH` replaces the
  // process's `Path` rather than standing beside it.
  const fold = (name: string) =>
    process.platform === 'win32' ? name.toUpperCase() : name;
  const named = new Set(Object.keys(project).map(fold));
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !named.has(fold(name))),
    ),
    ...project,
  };
});
