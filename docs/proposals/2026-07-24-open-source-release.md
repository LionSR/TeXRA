# TeXRA Open-Source Release Plan

> **Status:** Draft for maintainer review.

TeXRA's public repository needs a clear boundary between the reproducible
product and the hosted TeXRA Cloud service. The public release should contain
the clients, local agent runtime, tool integrations, prompt source, tests, and
documentation needed to run TeXRA with user-provided model credentials.

TeXRA Cloud may remain a paid hosted service. Its value comes from managed model
access, authentication, quotas, billing, deployment, and operations—not from
keeping product prompts secret.

## Everything that counts as a product prompt is public

A prompt is any TeXRA-authored instruction sent to a model or used to produce
another model instruction. This includes:

- bundled workflow agents in `packages/extension/resources/agents/`;
- bundled tool-use agents in
  `packages/extension/resources/tool_use_agents/`;
- hosted reference agents in `prompts/agents/remote/`;
- reusable skills in `skills/` and `.claude/skills/`;
- agent-creation templates and goal prompts under
  `packages/extension/resources/templates/` and
  `packages/extension/resources/goal/`;
- runtime-generated system instructions, compaction prompts, delegation rules,
  approval instructions, summaries, and prompt fragments in `src/` and
  `packages/`;
- repository automation prompts in `.github/prompts/`; and
- evaluation rubrics and fixtures that define expected agent behavior.

Dynamic user content, retrieved documents, model output, credentials, and
private account state are inputs—not product prompt source—and must never be
committed merely to make a run reproducible.

Product prompts must also be impersonal. They may encode a general writing or
review rubric, but may not contain an identifiable person's name, private
writing samples, voice or style calibration, feedback transcripts, biography,
or account metadata. Examples must be synthetic or have documented consent and
a compatible license.

There must be no production-only prompt. If TeXRA Cloud delivers an agent from
object storage, the exact source must already exist in the public repository.
The deployment should record:

- the public repository commit;
- the prompt's repository path;
- a hash of the canonical source;
- the resolved inheritance hash when an agent extends another agent; and
- the prompt schema version.

The client should retain these identifiers in execution metadata without
persisting the user's manuscript or fully rendered private prompt. This makes a
run attributable and reproducible without turning user data into telemetry.

## Prompt changes are code changes

Prompt pull requests should state the intended behavior change, affected agents
and descendants, provider compatibility, token-size impact, and evaluation
evidence. Review must check both the changed file and the final prompt after
inheritance and shared fragments are applied.

Non-package prompts live under `prompts/`; package-owned prompts stay in their
package resource directories so the source and packaging boundary remain
aligned. A generated manifest should index both groups and fail CI when a
model-facing prompt is unlisted, an inherited agent is missing or cyclic, a
referenced tool does not exist, or generated/package contents differ from
source.

Prompts should use the same repository license as the code unless a file has
documented third-party provenance. Adapted third-party prompts need a source and
compatible license in `NOTICE`; confidential provider system prompts must not
be copied into TeXRA.

## GitHub workflow boundary

The public repository keeps both deterministic CI and TeXRA's AI-powered
maintenance workflows. GitHub requires executable workflow files to live
directly in `.github/workflows/`, so those entrypoints stay flat. Their shared
tool policy lives in `.github/automation/`, and their prompt source lives in
`.github/prompts/`.

Workflow source may name required repository secrets and variables, but may not
contain their values. Public-fork safety, author-association gates, least
permissions, missing-credential behavior, and trusted-base prompt checkout are
part of the public security contract.

User-facing workflow templates are also product source and remain available
through TeXRA documentation or the CLI.

## Developer documentation sources

Do not vendor copies of provider API and tool-call documentation. These copies
become stale independently of TeXRA and obscure which provider revision the
implementation targets.

Future developer-facing provider guidance should use a Dev Docs MCP source and
link to the provider's canonical documentation. Any generated snapshot must
record its source URL, provider revision when available, and retrieval date; it
must not become another hand-maintained reference tree in this repository.

## Hosted relay boundary

The community client must run with personal provider credentials, supported
model subscriptions, or local models without initializing TeXRA Cloud. The
hosted relay is an optional distribution capability, not a prerequisite for the
agent runtime.

The first public release may omit the relay server implementation and its
production deployment configuration. It should still publish the client-side
protocol, request and response schemas, error semantics, and any code needed to
connect explicitly to a compatible hosted service. This keeps the public client
reviewable and allows TeXRA Cloud to remain a separately operated service.

The current code is not yet at that boundary. Included model access reaches
into authentication, credential selection, model availability, usage and quota
handling, retries, onboarding, settings, and CLI commands. Deleting
`supabase/functions/relay/` alone would leave a client that still assumes the
service exists.

The separation should be capability-based:

1. define one host-neutral `HostedModelAccess` interface for availability,
   sign-in state, model metadata, request routing, usage, and quota errors;
2. make the community implementation unavailable by default and free of
   Supabase initialization;
3. inject the TeXRA Cloud implementation only from the hosted distribution
   composition root;
4. hide hosted-only UI and CLI actions based on capability availability;
5. keep direct provider handlers, local models, and personal credentials in the
   public core; and
6. add a community-build CI job that rejects cloud implementation imports and
   verifies a full agent run makes no TeXRA network request.

Do not implement this with scattered `OPEN_SOURCE` conditionals. The build
boundary must make it impossible for the community artifact to import the
relay implementation. Authentication, remote agent delivery, and hosted model
access should also be separate capabilities; sharing a Supabase deployment does
not make them one product abstraction.

The migration sequence is client-first: establish and test the optional
capability, move TeXRA Cloud wiring behind it, and only then transfer the relay
server and infrastructure into the verified private destination described
below.

## Supabase boundary

The first public release does not claim that TeXRA Cloud is self-hostable.
Production Supabase migrations, seed data, access groups, billing and quota
logic, deployment overlays, and operational runbooks are intended for private
infrastructure. Until that destination exists and is verified, the current
repository remains their source of truth and those files must not be deleted.
Public clients must still work with user-provided model keys without TeXRA
Cloud.

Public Edge Function source may remain when it is useful for reviewing the
client/server contract, but the repository must state that it is not a complete
deployable Supabase project. No service-role key, production project reference,
user record, billing row, access list, or incident data may enter the public
tree.

SQL is reviewed by content, not filename. A reusable schema may be published in
a future self-hosting package, but any SQL containing real names, email
addresses, user IDs, project identifiers, allowlists, usage rows, or billing
data must be excluded from the public release. No SQL is removed from the
current repository until an access-controlled destination contains a verified
copy.

The migration gate is:

1. create the destination directory or private repository;
2. copy files with their original relative paths;
3. generate and compare a complete file manifest and content hashes;
4. verify destination access controls and backups;
5. perform a restore or deployment dry run from the destination; and
6. only then remove the verified files in a separate public-release change.

Supabase is only a delivery cache for public prompts, never their source of
truth. A private deployment pipeline should consume a tagged public prompt
manifest, upload immutable content-addressed objects, and return the public
commit and content hash with each agent configuration. Rollback selects an
older public version; it must not edit prompt text in production.

Security controls do not depend on prompt secrecy. Authentication, RLS,
authorization, tool permissions, approval gates, sandboxing, rate limits, and
spending limits are enforced in code and infrastructure.

## Public launch checklist

The repository is ready for a public launch only when:

- every model-facing instruction maps to public source or a documented public
  generator;
- no deployed prompt exists only in Supabase storage or another private system;
- prompt inheritance, packaging parity, hashes, and representative behavior
  evaluations pass in CI;
- the product runs locally with user-provided model credentials;
- the public tree contains no production SQL, deployment overlay, embedded
  secret, user data, or internal runbook;
- every excluded file has a verified, restorable copy in its approved
  destination;
- the actual code and prompt license, `NOTICE`, contribution guide, security
  policy, and code of conduct are present;
- a secret and personal-data scan passes on both the release tree and the
  history being published; and
- the public release is created as a new sanitized repository/export. The
  private development repository's history is not rewritten or published;
  deleting a file in its latest commit would not remove it from that history.

The current top-level `LICENSE` file is a placeholder and must be replaced by
the approved license text before TeXRA is published. Choosing or changing that
license is a maintainer decision, not a mechanical cleanup step.
