import { defineCommand } from 'citty';

import { readCliVersion } from '../runtime/cliContext';
import { CliExitCode } from '../runtime/exitCodes';
import { writeTextStdout } from '../runtime/logSinks';

import { setExitCode } from './_helpers/exitCode';

export const versionCommand = defineCommand({
  meta: { name: 'version', description: 'Print the CLI version' },
  async run() {
    writeTextStdout(await readCliVersion());
    setExitCode(CliExitCode.Success);
  },
});
