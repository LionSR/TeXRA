# API reference

TeXRA's core ships as two npm packages. These pages list every public export
with its doc comment and declaration, generated from the source on each
release of the site.

## [`@texra-ai/harness`](./harness/)

An embeddable agent runtime in Effect: run an agent from a Node program and
consume its trace as a stream.

- [`@texra-ai/harness`](./harness/)
- [`@texra-ai/harness/schemas`](./harness/schemas)
- [`@texra-ai/harness/transcript`](./harness/transcript)
- [`@texra-ai/harness/plugins`](./harness/plugins)
- [`@texra-ai/harness/node`](./harness/node)

## [`@texra-ai/llm`](./llm/)

Model access: the model and provider catalogs, the route decision, the
subscription sign-in flows, and one `Model` contract over every wire protocol.

- [`@texra-ai/llm`](./llm/)
- [`@texra-ai/llm/node`](./llm/node)

Both packages are 0.x, so the API may change in any minor release. Install
and usage guides are in each package's README on
[npm](https://www.npmjs.com/package/@texra-ai/harness) and
[GitHub](https://github.com/LionSR/TeXRA/tree/main/packages/harness).

If you have a Claude Max or Team plan, it includes
[monthly API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)
you can spend through an Anthropic API key with these packages.
