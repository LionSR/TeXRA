# supabase-relay (retired 2026-08)

The server side of TeXRA's relay ("Included model access"), removed from the
active tree in 2026-08. Full removal record, architecture documentation, and
step-by-step rebuild recipe:
`docs/proposals/2026-08-18-relay-removal-and-recovery.md`.

Lifted verbatim from pre-removal commit
`e9dbd7fd9b28153a5cc908a27c9096f4590f03a7` (the client side lives only there —
`git show <SHA>:<path>` recovers it).

Contents:

- `functions/relay/` — the relay edge function (provider proxy with tier,
  spend, and rate enforcement).
- `functions/relay-tokens/` — CI relay token mint/list/revoke.
- `functions/_shared/relayCiToken.ts` — shared CI-token validation. NOTE: both
  functions also import `_shared` siblings (`auth.ts`, `cors.ts`, `crypto.ts`,
  `edgeClients.ts`, `responses.ts`) that remain LIVE in
  `supabase/functions/_shared/`; a restoration copies `functions/*` back under
  `supabase/functions/`, where those relative imports resolve again.
- `scripts/deploy-relay.mjs` — deploy wrapper. CRITICAL: deploys with
  `--no-verify-jwt`; a plain `supabase functions deploy relay` breaks
  anthropic/google traffic (see recovery doc §9).
- `docs/RELAY_SETUP.md`, `docs/relay-tier-config.md` — operator setup guide
  and endpoint reference, as last published.
- `tests/` — the four `src/test-kernel/supabase/` suites that pinned
  client/server parity (tier constants, spending limits, token prefix,
  request limits). They ran green at the pre-removal SHA; they are reference
  copies, not executable here.
