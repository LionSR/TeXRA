import type { BrowserWindow } from 'electron';

export interface DesktopPromptOptions {
  title: string;
  prompt: string;
  password?: boolean;
}

export async function promptInRenderer(
  window: BrowserWindow,
  options: DesktopPromptOptions,
): Promise<string | undefined> {
  const result = await window.webContents.executeJavaScript(
    `(() => new Promise((resolve) => {
      const existing = document.querySelector('[data-texra-desktop-prompt]');
      existing?.remove();

      const overlay = document.createElement('div');
      overlay.dataset.texraDesktopPrompt = 'true';
      overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'background:rgba(0,0,0,.28)',
        'font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif'
      ].join(';');

      const panel = document.createElement('form');
      panel.style.cssText = [
        'width:min(520px,calc(100vw - 48px))',
        'box-sizing:border-box',
        'padding:var(--wa-space-l,20px)',
        'border:1px solid var(--wa-color-surface-border,#d0d7de)',
        'border-radius:6px',
        'background:var(--wa-color-surface-default,Canvas)',
        'color:var(--wa-color-text-normal,CanvasText)',
        'box-shadow:0 18px 48px rgba(0,0,0,.24)'
      ].join(';');

      const title = document.createElement('h2');
      title.textContent = ${JSON.stringify(options.title)};
      title.style.cssText = 'margin:0 0 var(--wa-space-s,10px);font-size:var(--font-size-h3,16px);font-weight:var(--wa-font-weight-semibold,600)';

      const label = document.createElement('label');
      label.textContent = ${JSON.stringify(options.prompt)};
      label.style.cssText = 'display:block;margin-bottom:var(--wa-space-xs,8px);font-size:13px';

      const input = document.createElement('input');
      input.type = ${JSON.stringify(options.password ? 'password' : 'text')};
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.style.cssText = [
        'width:100%',
        'box-sizing:border-box',
        'padding:var(--wa-space-xs,8px) var(--wa-space-s,10px)',
        'border:1px solid var(--wa-form-control-border-color,#d0d7de)',
        'border-radius:4px',
        'background:var(--wa-form-control-background-color,Field)',
        'color:var(--wa-form-control-text-color,FieldText)',
        'font:inherit'
      ].join(';');

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;justify-content:flex-end;gap:var(--wa-space-xs,8px);margin-top:var(--wa-space-m,16px)';

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.style.cssText = 'padding:var(--wa-space-2xs,6px) var(--wa-space-s,12px)';

      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.textContent = 'Save';
      submit.style.cssText = 'padding:var(--wa-space-2xs,6px) var(--wa-space-s,12px)';

      const cleanup = (value) => {
        document.removeEventListener('keydown', onKeyDown, true);
        overlay.remove();
        resolve(value);
      };
      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cleanup(null);
        }
      };

      cancel.addEventListener('click', () => cleanup(null));
      panel.addEventListener('submit', (event) => {
        event.preventDefault();
        cleanup(input.value);
      });
      document.addEventListener('keydown', onKeyDown, true);

      actions.append(cancel, submit);
      panel.append(title, label, input, actions);
      overlay.append(panel);
      document.body.append(overlay);
      input.focus();
    }))()`,
    true,
  );
  return typeof result === 'string' ? result : undefined;
}
