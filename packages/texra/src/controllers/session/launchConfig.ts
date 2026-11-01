import { Effect, Schema, SchemaIssue } from 'effect';

import { Rejected } from '@texra-ai/harness';
import { withLogChannel } from '@texra-ai/harness/host';
import { AgentConfigSchema, type AgentConfig } from '@texra-ai/harness/schemas';

/**
 * A fresh launch's configuration, decoded: what a launcher form, an action
 * or a command built. One that does not decode is the launch's rejection,
 * worded with its first issue and logged with all of them; nothing starts.
 * A persisted run resumes through `resumeRun` instead.
 */
export const decodeLaunchConfig = (
  config: unknown,
): Effect.Effect<AgentConfig, Rejected> =>
  Schema.decodeUnknownEffect(AgentConfigSchema)(config).pipe(
    Effect.catchTag('SchemaError', ({ issue }) => {
      const [first] = SchemaIssue.makeFormatterStandardSchemaV1()(issue).issues;
      const path = first?.path?.map(String).join('.') || 'unknown';
      const reason = `Invalid configuration (${path}): ${first?.message ?? 'validation failed'}`;
      return Effect.logError(reason).pipe(
        Effect.annotateLogs({ data: issue }),
        withLogChannel('LaunchConfig'),
        Effect.andThen(Effect.fail(new Rejected({ reason }))),
      );
    }),
  );
