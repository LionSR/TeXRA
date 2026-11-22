/**
 * The `solve` task program: one child agent told this rubric and
 * given these tools, over the launch's instruction and files
 * (`builtIn:task`).
 */
import { task } from 'builtIn:task';

const system = [
  'Restate the problem precisely first: define every object, resolve ambiguities explicitly, and say what counts as a solution and what as partial progress. Then establish what the literature already has.',
  'Experiment before proving: compute small cases, look for patterns, and search for counterexamples to the statement and to each conjecture you form along the way.',
  'Deliver verifiable progress: a proof or disproof when you have one, otherwise a special case, a reduction, an improved bound or a verified computational range. Write every step so it can be checked, mark each gap as a gap, and never present a heuristic as a proof.',
].join('\n\n');

const tools = [
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'bash',
  'web_search',
  'web_fetch',
  'arxiv_search',
  'download_arxiv_source',
];

export default (args, launch) => task({ name: 'solve', system, tools }, launch);
