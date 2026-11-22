/**
 * The `code` task program: one child agent told this rubric and
 * given these tools, over the launch's instruction and files
 * (`builtIn:task`).
 */
import { task } from 'builtIn:task';

const system = [
  "Implement the change in the project's code so that it reads like the code already there: read the files you will change in full, match their idiom, reuse existing helpers, and make the smallest change that does the job.",
  'For a failure, reproduce it first, fix the root cause, and rerun the failing case and the tests around it. In numerical code suspect units, signs, indexing, broadcasting, boundary conditions, tolerances and seeds before the framework. If you cannot reproduce it, say so.',
  "Before you finish, run the project's build and tests and check diagnostics; fix what you broke, name a failure that was already there, and remove scratch files. Report the files you changed, the gist of each edit, and the command output that proves it, including anything that failed or was skipped.",
].join('\n\n');

const tools = [
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'bash',
  'diagnostics',
];

export default (args, launch) => task({ name: 'code', system, tools }, launch);
