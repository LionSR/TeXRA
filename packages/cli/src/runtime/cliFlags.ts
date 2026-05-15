export const GLOBAL_FLAGS_WITH_VALUE = new Set([
  '--approval-policy',
  '--cwd',
  '--output-format',
]);

export const RUN_FLAGS_WITH_VALUE = new Set([
  '--input',
  '-i',
  '--output',
  '--model',
  '-m',
  '--instruction',
]);

export const GLOBAL_BOOLEAN_FLAGS = new Set(['--print', '-p']);

export const CLI_BOOLEAN_FLAGS = new Set([
  ...GLOBAL_BOOLEAN_FLAGS,
  '--help',
  '-h',
  '--version',
  '-v',
]);

export const FLAGS_WITH_VALUE = new Set([
  ...GLOBAL_FLAGS_WITH_VALUE,
  ...RUN_FLAGS_WITH_VALUE,
  '--agent',
  '--tool-display',
]);

export function cliFlagName(arg: string): string {
  return arg.split('=', 1)[0] ?? arg;
}
