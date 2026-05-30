<script setup>
// Frameless "anatomy of one memory item" card for guide/memory.md →
// "Managing memories from the Dashboard". The prose enumerates the four parts
// of a single note (Path · Metadata strip · Contents · Actions) plus the
// Refresh / Open Folder toolbar; this figure shows ONE expanded `.mem-item`
// at full width with a dim annotation pill calling out each part, so the
// metadata-strip vocabulary and the three action icons are unambiguous.
//
// Reuses MemoryHero's `.mem-item` markup + the `.yh-note` annotation-pill
// idiom from AgentYamlHero (right-aligned dim pill, hidden on narrow screens).
// Standalone (no MockupFrame / dash-nav). The root carries `.mockup` so the
// shared `--mk-*` colour + dimensional tokens resolve and the card flips
// cleanly between the docs light / dark themes.
</script>

<template>
  <div
    class="mockup mem-anat"
    role="group"
    aria-label="anatomy of a memory item"
  >
    <!-- Toolbar above the list (mirrors the Refresh / Open Folder buttons) -->
    <div class="ma-toolbar">
      <button type="button" class="r-btn">
        <wa-icon library="texra" name="rotate-right"></wa-icon>
        Refresh
      </button>
      <button type="button" class="r-btn">
        <wa-icon library="texra" name="folder-open"></wa-icon>
        Open Folder
      </button>
      <span class="ma-note ma-note-tb"
        >reveal <code>memories/</code> on disk</span
      >
    </div>

    <!-- One expanded memory item, annotated part by part -->
    <div class="mem-item pinned">
      <!-- Path + Actions -->
      <div class="mem-head">
        <div class="mem-path">/memories/project-conventions.md</div>
        <span class="ma-note ma-note-path">Path</span>
        <div class="mem-acts">
          <button
            type="button"
            class="m-act m-act-on"
            title="Unpin this memory"
          >
            <wa-icon library="texra" name="thumbtack-slash"></wa-icon>
          </button>
          <button type="button" class="m-act" title="Open in editor">
            <wa-icon library="texra" name="file-export"></wa-icon>
          </button>
          <button type="button" class="m-act" title="Delete this memory">
            <wa-icon library="texra" name="trash"></wa-icon>
          </button>
          <span class="ma-note ma-note-acts">pin · open · delete</span>
        </div>
      </div>

      <!-- Metadata strip -->
      <div class="mem-meta">
        <span class="pin-badge">Pinned</span>
        <span class="meta-dot">·</span>
        <span>1.2 KB</span>
        <span class="meta-dot">·</span>
        <span>34 lines</span>
        <span class="meta-dot">·</span>
        <span>Updated 5m ago</span>
        <span class="meta-dot">·</span>
        <span>by research</span>
        <span class="ma-note ma-note-meta">Metadata strip</span>
      </div>

      <!-- Contents -->
      <div class="mem-coll open">
        <wa-icon class="chev" library="texra" name="chevron-down"></wa-icon>
        Contents
        <span class="ma-note ma-note-coll">collapsible preview</span>
      </div>
      <div class="mem-preview">
        <div class="md-h">Project conventions</div>
        <ul class="md-ul">
          <li>
            Equations use <code class="md-code">\eqref</code>, not
            <code class="md-code">\ref</code>.
          </li>
          <li>
            Section labels follow <code class="md-code">sec:short-name</code>.
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Standalone. Tokens come from `.mockup` (theme/mockup.css). The note pills
   reuse the AgentYamlHero `.yh-note` idiom; the item markup mirrors
   MemoryHero's `.mem-item`, but the styles are self-contained here. */
.mem-anat {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-10);
  margin: var(--mk-space-12) 0;
  font-family: var(--vp-font-family-base);
}

/* Toolbar */
.ma-toolbar {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
}
.r-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-5);
  font-size: var(--mk-fs-70);
  color: var(--wa-color-text-normal);
  background: var(--mk-bg-raised);
  border: 1px solid var(--mk-border);
  border-radius: var(--mk-radius);
  padding: var(--mk-space-4) var(--mk-space-9);
  cursor: pointer;
}
.r-btn wa-icon {
  font-size: var(--mk-space-11);
  color: var(--color-text-secondary);
}

/* Memory item (mirrors MemoryHero) */
.mem-item {
  background: var(--mk-bg-soft);
  border: 1px solid var(--mk-border);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-10) var(--mk-space-12);
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-6);
}
.mem-item.pinned {
  border-left: 2px solid var(--color-text-link);
  padding-left: calc(var(--mk-space-12) - 1px);
}
.mem-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
}
.mem-path {
  min-width: 0;
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-78);
  font-weight: 500;
  color: var(--color-text-link);
  word-break: break-all;
}
.mem-acts {
  display: flex;
  align-items: center;
  gap: var(--mk-space-2);
  flex-shrink: 0;
  margin-left: auto;
}
.m-act {
  background: transparent;
  border: none;
  width: var(--mk-space-22);
  height: var(--mk-space-22);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--mk-radius-sm);
  color: var(--color-text-secondary);
  cursor: pointer;
}
.m-act wa-icon {
  font-size: var(--mk-space-12);
}
.m-act-on {
  color: var(--color-text-link);
}

/* Metadata strip */
.mem-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--mk-space-4);
  font-size: var(--mk-fs-70);
  color: var(--color-text-secondary);
}
.meta-dot {
  color: var(--color-text-tertiary);
}
.pin-badge {
  color: var(--color-text-link);
  font-weight: 600;
}

/* Collapsible Contents header */
.mem-coll {
  margin-top: var(--mk-space-2);
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-5);
  font-size: var(--mk-fs-72);
  color: var(--color-text-secondary);
  align-self: flex-start;
}
.mem-coll wa-icon {
  font-size: var(--mk-space-11);
}

/* Inline markdown preview */
.mem-preview {
  padding: var(--mk-space-8) var(--mk-space-10);
  background: var(--mk-bg);
  border: 1px solid var(--mk-border);
  border-radius: var(--mk-radius);
  font-size: var(--mk-fs-76);
  line-height: 1.45;
  color: var(--wa-color-text-normal);
}
.md-h {
  font-weight: 600;
  margin-bottom: var(--mk-space-4);
}
.md-ul {
  margin: 0;
  padding-left: var(--mk-space-18);
}
.md-ul li {
  margin: var(--mk-space-2) 0;
}
.md-code {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-72);
  background: var(--mk-bg-raised);
  padding: 1px var(--mk-space-4);
  border-radius: var(--mk-radius-sm);
  color: var(--mk-accent);
}

/* Annotation pills (the `.yh-note` idiom from AgentYamlHero). */
.ma-note {
  flex-shrink: 0;
  font-size: var(--mk-fs-70);
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--mk-accent) 32%, transparent);
  border-radius: var(--mk-radius);
  padding: var(--mk-space-2) var(--mk-space-7);
  line-height: 1.4;
}
.ma-note code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.92em;
}
.ma-note-tb {
  margin-left: auto;
}
.ma-note-path {
  margin-left: var(--mk-space-8);
}
.ma-note-acts,
.ma-note-meta,
.ma-note-coll {
  margin-left: var(--mk-space-8);
}

/* Drop the annotation pills below the content on narrow screens, where the
   right-aligned pills would crowd the item. */
@media (max-width: 560px) {
  .ma-note {
    display: none;
  }
}
</style>
