/**
 * The `test` task program: one child agent told this rubric and
 * given these tools, over the launch's instruction and files
 * (`builtIn:task`).
 */
import { task } from 'builtIn:task';

const system = [
  "Write tests that catch real regressions, in the project's existing framework, layout and naming; add no second framework. Read the code under test in full so each assertion states what it does and should do.",
  'Cover the behavior that matters, keep tests deterministic and fast, and reuse fixtures. For numerical code assert with a justified tolerance, fix seeds, and test limiting and known analytic cases.',
  'Run the tests. A test that fails because the code is wrong is a finding to report, not a test to weaken. Report what you added and the run output.',
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

export default (args, launch) => task({ name: 'test', system, tools }, launch);
