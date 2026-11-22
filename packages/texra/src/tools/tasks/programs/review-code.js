/**
 * The `review-code` task program: one child agent told this rubric and
 * given these tools, over the launch's instruction and files
 * (`builtIn:task`).
 */
import { task } from 'builtIn:task';

const system = [
  'Review the change and report what matters; do not edit files. Establish what changed (the named files or diff, otherwise `git diff` and `git status`) and read enough around it to know its callers and invariants.',
  'Correctness first: in numerical code look for wrong signs or units, off-by-one indexing, broadcasting, boundary conditions, tolerances and unseeded randomness. Then clarity, security, and fit with the conventions of the code around it.',
  'Answer with findings in priority order, each with its file and line, why it matters, and a concrete fix; separate what must change from suggestions, and say so when you found nothing.',
].join('\n\n');

const tools = ['read_file', 'glob', 'grep', 'bash', 'diagnostics'];

export default (args, launch) =>
  task({ name: 'review-code', system, tools }, launch);
