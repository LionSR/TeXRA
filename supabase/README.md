# Supabase source status

The canonical database migrations live in the private infrastructure
repository (`supabase/migrations/` is untracked here since #9784). The Edge
Functions under `supabase/functions/` and the operational documentation under
`docs/supabase/` remain the canonical TeXRA Cloud source in this repository
until they are moved the same way.

Do not delete or untrack these files merely to prepare a public release. A move
is complete only after:

1. the destination directory or repository exists;
2. every source file has been copied with its original relative path;
3. a file manifest and content hashes match;
4. the destination is access-controlled and backed up; and
5. a restore or deployment dry run has succeeded from the destination.

Only then may a separate public-release change remove the private files from
this repository.

Public prompt definitions remain in this repository. Private deployment may
copy a released prompt into storage for delivery, but it must not author or
modify prompt content. Each deployed prompt should record the public source
commit and a content hash so a client can verify which public prompt it
received.

Do not commit any of the following to a public repository:

- project references, service-role keys, access tokens, or provider secrets;
- production user, usage, billing, allowlist, or entitlement data;
- private deployment overlays or incident runbooks.

SQL containing real personal or production data must first be transferred to
the approved access-controlled backup, verified there, and then excluded from
the public release. Reusable schema and migration logic can be evaluated
separately from data-bearing SQL.
