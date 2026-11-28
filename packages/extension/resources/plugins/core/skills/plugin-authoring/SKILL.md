---
name: plugin-authoring
description: Write a plugin with a native module (`harness.mjs`) that adds tools, programs, script modules, services or a prompt section to this process. Use when the user asks for a new tool or plugin of their own, before installing it with `plugin_manager`.
---

# Writing a plugin with a native module

A plugin is a folder. `plugin_manager` installs it, and the person enables and trusts it; nothing in it runs before that.

## The folder

```
my-plugin/
  .claude-plugin/plugin.json   { "name": "my-plugin" }
  harness.mjs                  the native module
```

The same folder may also carry `skills/`, `agents/`, `programs/` and `.mcp.json`.

## harness.mjs

The file begins with two declarations, each a literal, which the trust review reads without running the file:

```js
export const description = 'Counts the words in a text.';
export const provides = ['tool:word_count'];
```

`provides` names everything the plugin contributes:

- `tool:<name>`, `program:<name>`, `module:<name>`: one entry per tool, program and script module.
- `processLayer`, `sessionLayer`, `prompt`: the plugin's field of that name, when it has one.

A plugin that contributes something `provides` does not name is refused.

The default export takes `{ plugins, effect }` and returns a plugin:

```js
export default ({ plugins, effect }) => {
  const { Effect, Schema } = effect;
  const word_count = plugins.defineTool({
    name: 'word_count',
    description: 'Count the words in a text.',
    schema: Schema.Struct({ text: Schema.String }),
    execute: ({ text }) =>
      Effect.succeed(String(text.trim().split(/\s+/).length)),
  });
  return plugins.definePlugin({ id: 'my-plugin', tools: [word_count] });
};
```

- `plugins` is the plugin authoring surface: `definePlugin`, `defineTool` and what a tool's body reads from its call.
- `effect` is the Effect library this process runs: `Effect`, `Context`, `Layer`, `Schema`, `Stream`, `Scope` and the rest. Use it instead of importing `effect`, so the plugin and the process share one copy.
- The plugin's `id` is the name in `plugin.json`.
- An optional tool input field is `Schema.optional(Schema.NullOr(S))`.

## How its tools run

Each call of a native module's tool asks under the approval policy, whatever the tool declares, and is stopped after 60 seconds. A call that fails ends alone, with an error that names the plugin.

## Installing and changing it

`plugin_manager` `install` takes the folder, a git URL or `github.com/<owner>/<repo>[@ref]`; `enable` asks the person to trust it. Any edit to the folder withdraws the plugin until it is enabled and trusted again, so finish the edit before asking.
