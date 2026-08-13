<script setup>
// Terminal card for `texra init` — guide/configuration.md "Where Settings
// Live". Beat 1 reproduces the real scaffold output
// (packages/cli/src/commands/init.ts): `Wrote .texra/config.json` followed by
// the chosen defaults and the next-step hint; `--yes` accepts defaults
// non-interactively, `--gitignore` adds `.texra/` to .gitignore. Beat 2 is the
// doctor's config row (packages/cli/src/runtime/doctor.ts checkConfig)
// confirming which workspace config file is loaded.
//
// Built on <TermWindow>; .mockup-scoped and token-only. Static strings.
</script>

<template>
  <TermWindow
    title="texra init"
    aria-label="texra init scaffolding .texra/config.json"
  >
    <!-- Beat 1: scaffold workspace defaults -->
    <div class="mk-term-prompt">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd">texra init</span>
    </div>
    <div class="cih-hint-flags">
      --yes accepts defaults non-interactively; --gitignore adds .texra/ to
      .gitignore
    </div>
    <div class="cih-block">
      <div class="cih-wrote">Wrote .texra/config.json</div>
      <div class="cih-kv"><span class="cih-k">agent:</span> assistant</div>
      <div class="cih-kv"><span class="cih-k">model:</span> deepseekT</div>
      <div class="cih-kv"><span class="cih-k">approval:</span> ask</div>
      <div class="cih-kv"><span class="cih-k">output:</span> text</div>
      <div class="cih-next">
        Next: run `texra` for the launcher, or `texra chat` to start.
      </div>
    </div>

    <!-- Beat 2: doctor confirms what's loaded -->
    <div class="mk-term-prompt cih-beat">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd">texra doctor</span>
    </div>
    <div class="cih-doctor">
      <span class="cih-pass">PASS</span>
      <span class="cih-name">Config:</span>
      <span class="cih-msg">Workspace config: .texra/config.json</span>
    </div>
  </TermWindow>
</template>

<style scoped>
/* Card shell, body, and prompt come from TermWindow + the shared .mk-term-*
   classes in theme/mockup.css. */
.cih-hint-flags {
  margin-top: var(--mk-space-3);
  padding-left: var(--mk-space-16);
  color: var(--mk-text-faint);
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-70);
  font-style: italic;
}
.cih-block {
  margin-top: var(--mk-space-5);
  padding-left: var(--mk-space-16);
  font-size: var(--mk-fs-74);
}
.cih-wrote {
  color: var(--mk-text);
  font-weight: 600;
}
.cih-kv {
  color: var(--mk-text-dim);
  padding-left: var(--mk-space-12);
}
.cih-k {
  color: var(--mk-syn-keyword);
}
.cih-next {
  margin-top: var(--mk-space-6);
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-72);
}

.cih-beat {
  margin-top: var(--mk-space-10);
}
.cih-doctor {
  margin-top: var(--mk-space-4);
  padding-left: var(--mk-space-16);
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
  font-size: var(--mk-fs-74);
}
.cih-pass {
  color: var(--color-success);
  font-weight: 700;
}
.cih-name {
  color: var(--mk-text);
  font-weight: 600;
}
.cih-msg {
  color: var(--mk-text-dim);
  min-width: 0;
}
</style>
