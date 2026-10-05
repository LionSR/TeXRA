/**
 * `@texra-ai/harness/plugins`: the harness's built-in plugins, as the values
 * an embedder lists for `Sessions.layer({ platform, plugins })`.
 * `harnessBuiltins.all` is every built-in; `harnessBuiltins.minimal` only
 * files and the shell. An embedder adds its own plugins beside them.
 */
export { harnessBuiltins } from '@tools/builtinPlugins';
