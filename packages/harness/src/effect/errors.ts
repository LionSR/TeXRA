/**
 * The failures the Effect surface names (`@texra-ai/harness`). Five are
 * defined here — the plugin list the package refuses, the tools a launch
 * refuses, the resume refusal, a trace no reader can take, and the run's own
 * failure. The other launch refusal, an input the launch will not run
 * (`LaunchRefused`), is the agent layer's, which raises it, and three more
 * reach the surface from the session store (`DatabaseOpenFailed`, `DatabaseReadFailed`,
 * `SessionOptionsConflict`: the `SessionOpenError` union in
 * `@shared/session/database`), for nine in the session lifecycle. The entry
 * exports other tagged errors too; `config/api-reports/harness.api.md` lists
 * the whole surface.
 *
 * Request failures are not defined here. A `session.request` answers with the
 * runtime's own `RequestError` union (`@shared/session/runtimeRequest`), the
 * same values every host reads, so the package adds no second
 * vocabulary for them.
 */
import { Schema } from 'effect';

import type { LaunchRefused } from '@common/errors/agentErrors';
import { ResumeRefusalSchema } from '@shared/schemas';

/**
 * The plugin list cannot be composed, for a defect `toolTable` refuses: an
 * id that is not lowercase letters, digits and dashes, an id or tool name
 * listed twice, a switch on a plugin with no availability probe, a
 * `requires` naming a plugin not listed, an agent-file block owned twice or
 * keyed by a persona key, or two script modules of one name.
 */
export class PluginsRefused extends Schema.TaggedError<PluginsRefused>()(
  'PluginsRefused',
  {
    message: Schema.String,
  },
) {}

/**
 * The tools the caller passed cannot run here: a tool that requires
 * approval, on a session opened without an approval handler.
 */
export class ToolsRefused extends Schema.TaggedError<ToolsRefused>()(
  'ToolsRefused',
  {
    tools: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

/** A run that failed on its own: an activation with no readable end.
 *  `cause` is exactly what the launch path threw. */
export class RunFailure extends Schema.TaggedError<RunFailure>()('RunFailure', {
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

/** A run `session.resume` will not continue, for the runtime's reason
 *  (`ResumeRefusal`). */
export class ResumeRefused extends Schema.TaggedError<ResumeRefused>()(
  'ResumeRefused',
  {
    runId: Schema.String,
    reason: ResumeRefusalSchema,
    message: Schema.String,
  },
) {}

/** What a launch refuses before any model work: the two an embedder
 *  branches on. A run that fails after admission fails with
 *  {@link RunFailure} instead. */
export type LaunchError = LaunchRefused | ToolsRefused;
