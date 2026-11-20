// Third-party imports
import { Flag } from 'effect/cli';

/**
 * A boolean flag that is off by default and takes no `--no-` form: the shape
 * every yes/no switch on a TeXRA command shares. A command that needs a
 * default of `true` (so `--no-x` turns it off) spells its own `Flag.Boolean`.
 */
export const boolFlag = (name: string, description: string) =>
  Flag.Boolean(name).pipe(
    Flag.withoutNegation,
    Flag.withDefault(false),
    Flag.withDescription(description),
  );

/**
 * The optional `--model/-m` flag the commands that launch an agent share. The
 * surface's own wording is the parameter: a session, a run or a task names what
 * the model is for.
 */
export const modelFlag = (description: string) =>
  Flag.String('model').pipe(
    Flag.withAlias('m'),
    Flag.withDescription(description),
    Flag.optional,
  );
