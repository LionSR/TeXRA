# Responsibility audit: what the 2026-11-21 run left open

Date: 2026-11-21
Status: proposed
Origin: the scheduled audit for confused or overlapping responsibilities, on
`main` at `362ab86`. It started from the open items of the two earlier
responsibility notes and the notes on the unmerged #15130 and #15132
branches, rather than a fresh sweep, since those surveys were recent.

The PR that adds this note lands item 3 of the 2026-11-20 responsibility
note (on the #15130 branch): **the terminal's launch defaults had two
owners.** `resolveChatDefaults` (`chatDefaults.ts`) and
`cliRunModelCandidates` (`runModel.ts`) each wrote out the four-tier model
lookup, and the chat-agent filter lived only in the chat's copy, so
`texra agents` and `/agents` showed a configured default the chat would
ignore. Now `packages/cli/src/runtime/models/launchDefaults.ts` owns the
one candidate list for `chat`, `run` and `tasks`, and `cliCommandDefaults`
(`packages/cli/src/runtime/platform/cliConfig.ts`) returns the agent a
launch would start on. Checked against the code, the 2026-11-20 note's
claim that "the chat skips the unknown-model check" does not hold: the chat
command already calls `assertExplicitModelKnown` before mounting.

## Open

1. **A resumed chat's model is ranked as a person's choice.** At startup,
   `runChatTui.tsx` passes `initialResume?.config.model ?? init.modelOverride`
   as the explicit override, so the stored model outranks `--model`, and one
   no longer available is refused. A `/resume` inside the chat adopts the
   same stored config as `history` (`chatSessionController.ts`), which falls
   back with a notice. `RUN_MODEL_REASONS` ranks `history` below the
   environment and the command config, so relabelling the startup case would
   also let `TEXRA_MODEL` override a resumed run. Decision: which rank a
   resumed run's model has, then one reason at both call sites.
2. **The chat's reported model source can name a candidate it did not
   run.** `resolveChatDefaults` decides the source before availability is
   known; when `selectCliRunnableModel` then falls back, the session meta
   still shows the first candidate's reason. Small; fix with item 1, since
   both touch the same few lines in `runChatTui.tsx`.
