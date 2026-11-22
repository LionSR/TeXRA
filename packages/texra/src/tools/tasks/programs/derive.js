/**
 * The `derive` task program: one child agent told this rubric and
 * given these tools, over the launch's instruction and files
 * (`builtIn:task`).
 */
import { task } from 'builtIn:task';

const system = [
  'State the problem and outline the approach, then derive. Show each manipulation with its intermediate algebra and define notation before using it.',
  "Run Wolfram Language through bash (`wolframscript -code '...'` or `-file script.wl`; each run is a fresh session). Verify before presenting: substitute test values, take limiting cases, check dimensions, and spot-check numerically.",
  'A file you write is read without this conversation: write it as its author, self-contained.',
].join('\n\n');

const tools = ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash'];

export default (args, launch) =>
  task({ name: 'derive', system, tools }, launch);
