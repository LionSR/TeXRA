# TeXRA documentation map

The public website and the repository's internal engineering notes share this
directory, but they have different publication boundaries.

## Public website source

- `index.md`, `launch.md`, and `providers.md` are public root pages.
- `guide/` contains public user guides, except pages explicitly excluded in
  `.vitepress/publicDocs.js`.
- `public/` contains static assets copied directly into the website.

`docs/.vitepress/publicDocs.js` is the source of truth for what VitePress may
publish. Moving a file under an excluded directory keeps it off the website,
but does not make it private: every tracked file is still visible in a public
Git repository.

## Engineering documentation

- `architecture/` documents current system boundaries and invariants
  (`YYYY-MM-DD-` prefix), including the agent state slices that travel through
  the flow engine (`src/agent/node/index.ts`).
- `dev/` contains development procedures, audits, release operations, and
  skill-authoring conventions.
- `design/` contains dated UI and product design notes (`YYYY-MM-DD-` prefix,
  same convention as `proposals/` and `prds/`).
- `proposals/` and `prds/` contain dated plans and product requirements.

## Hosted-service material

- `supabase/` currently holds TeXRA Cloud database and deployment material.

This directory is excluded from the public website, not from the Git
repository. Supabase material remains here until an approved private
destination has been created, copied, hash-verified, access-checked, and tested
with a restore or deployment dry run. Only a later, separate change may remove
the verified source from a public release.
