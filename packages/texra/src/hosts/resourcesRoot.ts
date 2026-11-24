/**
 * Where the host's packaged resources ship: the theory plugin's document
 * templates, the transcript export's LaTeX preamble and the trace-viewer
 * bundle. The process layer serves it from the host's resources path
 * (`texraProcessLayer`); a process that ships none (a suite) serves nothing,
 * and each reader says what it cannot do without them.
 */
import { Context } from 'effect';

/** The packaged resources root; `undefined` where none ships. */
export const ResourcesRoot = Context.Reference<string | undefined>(
  '@texra-ai/texra/hosts/ResourcesRoot',
  { defaultValue: () => undefined },
);
