<template>
  <div class="launch-container">
    <div class="launch-header">
      <h1>Launch TeXRA Workspace</h1>
      <p class="subtitle">
        Start a GitHub Codespace with TeXLive and TeXRA pre-installed
      </p>
    </div>

    <div class="launch-form">
      <div class="form-group">
        <label for="repo-type">Repository Type</label>
        <select
          id="repo-type"
          v-model="repoType"
          @change="handleRepoTypeChange"
        >
          <option value="overleaf">Overleaf Git</option>
          <option value="github-private">GitHub (Private)</option>
          <option value="github-public">GitHub (Public)</option>
        </select>
      </div>

      <div class="form-group">
        <label for="repo-url">Repository URL</label>
        <input
          id="repo-url"
          v-model="repoUrl"
          type="text"
          :placeholder="
            repoType === 'overleaf'
              ? 'https://git.overleaf.com/[24-char-project-id]'
              : 'https://github.com/username/repo'
          "
          required
        />
        <small v-if="repoType === 'overleaf'">
          Copy the Git URL from Menu → Git in your Overleaf project
        </small>
      </div>

      <div v-if="repoType === 'overleaf'" class="auth-selection">
        <h3>Authentication Method</h3>
        <div class="auth-options">
          <label class="auth-option">
            <input type="radio" v-model="authMethod" value="manual" />
            <span
              >📝 Enter credentials manually (Recommended for first-time
              users)</span
            >
          </label>
          <label class="auth-option">
            <input type="radio" v-model="authMethod" value="secrets" />
            <span>🔐 Use Codespace Secrets (Best for regular use)</span>
          </label>
        </div>

        <div v-if="authMethod === 'secrets'" class="secrets-info">
          <p>✅ Make sure you've set up these secrets:</p>
          <ul>
            <li><code>OVERLEAF_EMAIL</code> - Your Overleaf email</li>
            <li><code>OVERLEAF_TOKEN</code> - Your Overleaf Git token</li>
            <li>Repository access: <code>texra-ai/texra-workspace</code></li>
          </ul>
          <div class="secret-links">
            <a
              href="https://github.com/settings/codespaces"
              target="_blank"
              class="setup-link"
            >
              🔧 Set up Codespace secrets
            </a>
            <a
              href="https://www.overleaf.com/learn/how-to/Git_integration_authentication_tokens"
              target="_blank"
              class="setup-link"
            >
              📚 Get Overleaf Git token
            </a>
          </div>
        </div>

        <div v-if="authMethod === 'manual'" class="auth-fields">
          <div class="form-group">
            <label for="username">Overleaf Email</label>
            <input
              id="username"
              v-model="username"
              type="text"
              placeholder="your@email.com"
            />
          </div>
          <div class="form-group">
            <label for="password">Overleaf Git Token</label>
            <input
              id="password"
              v-model="password"
              type="password"
              placeholder="Your Overleaf Git token"
            />
          </div>
          <div class="quick-guide">
            <h5>💡 How to get your token:</h5>
            <ol>
              <li>In Overleaf: Menu → Git</li>
              <li>Click "Generate token" (or use existing one)</li>
              <li>Copy the token and paste it above</li>
            </ol>
            <small style="margin-top: 0.5rem; display: block">
              <a
                href="https://www.overleaf.com/learn/how-to/Git_integration_authentication_tokens"
                target="_blank"
              >
                View detailed guide →
              </a>
            </small>
          </div>
        </div>
      </div>

      <div v-else-if="repoType === 'github-private'" class="auth-section">
        <h3>Authentication</h3>
        <div class="form-group">
          <label for="username">GitHub Username</label>
          <input
            id="username"
            v-model="username"
            type="text"
            placeholder="github-username"
          />
        </div>
        <div class="form-group">
          <label for="password">GitHub Personal Access Token</label>
          <input
            id="password"
            v-model="password"
            type="password"
            placeholder="ghp_xxxxxxxxxxxx"
          />
          <small>
            <a href="https://github.com/settings/tokens/new" target="_blank"
              >Create a token</a
            >
            with 'repo' scope
          </small>
        </div>
      </div>

      <div class="button-group">
        <button
          @click="launchCodespace"
          :disabled="!isValid"
          class="launch-button"
        >
          <span v-if="!loading">🚀 Launch Codespace</span>
          <span v-else>Preparing...</span>
        </button>
      </div>

      <div v-if="error === 'success' && setupCommand" class="success-message">
        <h3>✅ Codespace creation page opened!</h3>

        <div
          v-if="repoType === 'overleaf' && authMethod === 'secrets'"
          class="auth-info"
        >
          🔐 Using Codespace Secrets for authentication
        </div>

        <div class="command-section">
          <p>
            📋 After the Codespace starts, paste this command in the terminal:
          </p>
          <div class="command-box">
            <code>{{ setupCommand }}</code>
            <button @click="copyToClipboard" class="copy-button">
              {{ copySuccess ? '✓ Copied!' : '📋 Copy' }}
            </button>
          </div>
        </div>

        <div class="script-info">
          <p>⚡ The script will:</p>
          <ul v-if="repoType === 'overleaf' && authMethod === 'secrets'">
            <li>Use your OVERLEAF_EMAIL and OVERLEAF_TOKEN secrets</li>
            <li>Clone your repository automatically</li>
            <li>Configure git for you</li>
          </ul>
          <ul v-else-if="repoType === 'overleaf'">
            <li>Use the credentials you provided</li>
            <li>Clone your repository</li>
            <li>Configure git with your email</li>
          </ul>
          <ul v-else>
            <li>Clone your repository</li>
            <li>Configure git with your credentials</li>
            <li>Set up the TeXRA environment</li>
          </ul>
        </div>

        <p class="bookmark-tip">
          💡 Tip: Bookmark your Codespace URL to quickly resume work next time!
        </p>
        <p class="secrets-tip">
          🔑 You can also add API keys as Codespace secrets (e.g.,
          ANTHROPIC_API_KEY, OPENAI_API_KEY) to avoid entering them each time.
        </p>
      </div>

      <div v-else-if="error && error !== 'success'" class="error-message">
        {{ error }}
      </div>

      <div class="info-box">
        <h4>How it works</h4>
        <ol>
          <li>Click "Launch Codespace" to open GitHub Codespaces</li>
          <li>Wait for the Codespace to start (2-3 minutes first time)</li>
          <li>Copy and run the setup command shown after clicking Launch</li>
          <li>Your repository will be cloned and configured automatically</li>
        </ol>
        <p
          style="margin-top: 1rem; color: var(--vp-c-text-3); font-size: 0.9rem"
        >
          <strong>⏱️ Note:</strong> First-time setup takes ~2 minutes to
          download TeXLive packages. Subsequent launches will be much faster.
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';

const repoType = ref('overleaf');
const repoUrl = ref('');
const username = ref('');
const password = ref('');
const authMethod = ref('manual'); // Default to manual for first-time users
const loading = ref(false);
const error = ref('');
const setupCommand = ref('');
const copySuccess = ref(false);

const handleRepoTypeChange = () => {
  // Clear auth fields when switching to public
  if (repoType.value === 'github-public') {
    username.value = '';
    password.value = '';
  }
  error.value = '';
};

const copyToClipboard = async () => {
  if (!setupCommand.value) return;

  try {
    await navigator.clipboard.writeText(setupCommand.value);
    copySuccess.value = true;
    setTimeout(() => {
      copySuccess.value = false;
    }, 2000);
  } catch (err) {
    console.error('Failed to copy:', err);
  }
};

const isValid = computed(() => {
  if (!repoUrl.value) return false;

  // For Overleaf, accept Git URLs with project IDs
  if (repoType.value === 'overleaf') {
    // Check if it contains a 24-character hex project ID
    const projectIdMatch = repoUrl.value.match(/[a-f0-9]{24}/);
    if (!projectIdMatch) return false;

    // Check if it's from overleaf.com domain
    if (!repoUrl.value.includes('overleaf.com')) return false;
  } else {
    // Validate URL format for GitHub
    try {
      const url = new URL(repoUrl.value);
      if (
        repoType.value.startsWith('github') &&
        !url.hostname.includes('github.com')
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }

  // Check auth requirements
  if (repoType.value === 'overleaf') {
    // If using secrets, we don't need credentials in the form
    if (authMethod.value === 'secrets') {
      return true;
    }
    // If manual, check for credentials
    if (!username.value || !password.value) return false;
  } else if (repoType.value === 'github-private') {
    if (!username.value || !password.value) return false;
  }

  return true;
});

const launchCodespace = async () => {
  error.value = '';
  loading.value = true;

  try {
    // Prepare configuration
    const config = {
      repoUrl: repoUrl.value,
      repoType: repoType.value,
    };

    // Add auth if needed
    if (repoType.value === 'overleaf') {
      // Only add credentials if using manual auth
      if (authMethod.value === 'manual') {
        config.username = username.value;
        config.password = password.value;
      }
      // Always indicate auth method for Overleaf
      config.authMethod = authMethod.value;
    } else if (repoType.value === 'github-private') {
      config.username = username.value;
      config.password = password.value;
    }

    // For Overleaf repos with manual auth, use the email for git config
    if (repoType.value === 'overleaf' && authMethod.value === 'manual') {
      // Use the username (Overleaf email) for both git name and email
      config.gitEmail = username.value;
      // Extract name from email (part before @) or use full email
      config.gitName = username.value.split('@')[0];
    }

    // Encode configuration as base64
    const configStr = JSON.stringify(config);
    const configBase64 = btoa(configStr);

    // Build Codespace URL
    const workspaceRepo = 'texra-ai/texra-workspace';
    const codespaceUrl = new URL(`https://github.com/codespaces/new`);

    // Add parameters
    codespaceUrl.searchParams.set('hide_repo_select', 'true');
    codespaceUrl.searchParams.set('ref', 'main');
    codespaceUrl.searchParams.set('repo', workspaceRepo);
    codespaceUrl.searchParams.set('skip_quickstart', 'true');

    // Add environment variable with config
    // Note: GitHub Codespaces doesn't support passing env vars via URL directly
    // We'll need to use a different approach - store config temporarily or use secrets

    // For now, we'll open the codespace and show instructions
    const instructionsUrl = `https://github.com/${workspaceRepo}?setup=${encodeURIComponent(configBase64)}`;

    // Store config in sessionStorage for manual retrieval
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('texra-launch-config', configBase64);
    }

    // Open the Codespace creation page
    window.open(codespaceUrl.toString(), '_blank');

    // Store the setup command
    setupCommand.value = `echo '${configBase64}' | base64 -d > /tmp/texra-config.json && bash /workspaces/texra-workspace/.devcontainer/auto-setup.sh`;

    // Show success message with instructions
    if (repoType.value === 'overleaf') {
      if (authMethod.value === 'secrets') {
        error.value = `success`;
      } else {
        error.value = `success`;
      }
    } else {
      error.value = `success`;
    }
  } catch (err) {
    error.value = `Error: ${err.message}`;
  } finally {
    loading.value = false;
  }
};
</script>

<style scoped>
.launch-container {
  max-width: 800px;
  width: 90%;
  margin: 2rem auto;
  padding: 2rem;
}

.launch-header {
  text-align: center;
  margin-bottom: 2rem;
}

.launch-header h1 {
  font-size: 2rem;
  margin-bottom: 0.5rem;
}

.subtitle {
  color: var(--vp-c-text-2);
  font-size: 1.1rem;
}

.launch-form {
  background: var(--vp-c-bg-soft);
  border-radius: 8px;
  padding: 2rem;
}

@media (max-width: 768px) {
  .launch-container {
    width: 95%;
    padding: 1rem;
  }

  .launch-form {
    padding: 1.5rem;
  }
}

.form-group {
  margin-bottom: 1.5rem;
}

.form-group label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 500;
  color: var(--vp-c-text-1);
}

.form-group input,
.form-group select {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 0.9rem;
}

.form-group input:focus,
.form-group select:focus {
  outline: none;
  border-color: var(--vp-c-brand);
}

.form-group small {
  display: block;
  margin-top: 0.25rem;
  color: var(--vp-c-text-3);
  font-size: 0.85rem;
}

.form-group small a {
  color: var(--vp-c-brand);
}

.auth-section {
  background: var(--vp-c-bg);
  border-radius: 4px;
  padding: 1rem;
  margin: 1.5rem 0;
}

.auth-section h3 {
  margin-bottom: 1rem;
  font-size: 1.1rem;
}

.button-group {
  margin-top: 2rem;
}

.launch-button {
  width: 100%;
  padding: 0.75rem 1.5rem;
  background: var(--vp-c-brand);
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 1rem;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.2s;
}

.launch-button:hover:not(:disabled) {
  background: var(--vp-c-brand-dark);
}

.launch-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.success-message {
  margin-top: 1rem;
  padding: 1.5rem;
  background: var(--vp-c-success-soft);
  border: 1px solid var(--vp-c-success);
  border-radius: 8px;
}

.success-message h3 {
  margin: 0 0 1rem 0;
  color: var(--vp-c-success-dark);
  font-size: 1.2rem;
}

.auth-info {
  margin-bottom: 1rem;
  color: var(--vp-c-text-2);
  font-size: 0.95rem;
}

.command-section {
  margin: 1rem 0;
}

.command-section p {
  margin-bottom: 0.5rem;
  color: var(--vp-c-text-1);
  font-weight: 500;
}

.command-box {
  display: flex;
  align-items: center;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  padding: 0.5rem;
  gap: 0.5rem;
}

.command-box code {
  flex: 1;
  padding: 0.5rem;
  font-family: monospace;
  font-size: 0.85rem;
  word-break: break-all;
  overflow-wrap: break-word;
  color: var(--vp-c-text-1);
  background: transparent;
}

.copy-button {
  flex-shrink: 0;
  padding: 0.5rem 1rem;
  background: var(--vp-c-brand);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9rem;
  transition: all 0.2s;
  white-space: nowrap;
}

.copy-button:hover {
  background: var(--vp-c-brand-dark);
  transform: translateY(-1px);
}

.script-info {
  margin: 1rem 0;
  padding: 1rem;
  background: var(--vp-c-bg);
  border-radius: 6px;
}

.script-info p {
  margin-bottom: 0.5rem;
  font-weight: 500;
  color: var(--vp-c-text-1);
}

.script-info ul {
  margin: 0;
  padding-left: 1.5rem;
  color: var(--vp-c-text-2);
}

.script-info li {
  margin: 0.25rem 0;
}

.bookmark-tip,
.secrets-tip {
  margin-top: 1rem;
  padding: 0.75rem;
  background: var(--vp-c-tip-bg);
  border-left: 3px solid var(--vp-c-brand);
  border-radius: 4px;
  color: var(--vp-c-text-2);
  font-size: 0.95rem;
}

.error-message {
  margin-top: 1rem;
  padding: 0.75rem;
  background: var(--vp-c-danger-soft);
  border: 1px solid var(--vp-c-danger);
  border-radius: 4px;
  color: var(--vp-c-danger);
  white-space: pre-wrap;
  word-break: break-all;
  overflow-wrap: break-word;
  font-family: monospace;
  font-size: 0.85rem;
  max-width: 100%;
  overflow-x: auto;
}

.info-box {
  margin-top: 2rem;
  padding: 1rem;
  background: var(--vp-c-bg);
  border-radius: 4px;
  border-left: 3px solid var(--vp-c-brand);
}

.info-box h4 {
  margin-bottom: 0.5rem;
  color: var(--vp-c-text-1);
}

.info-box ul {
  margin: 0;
  padding-left: 1.5rem;
}

.info-box li {
  margin: 0.25rem 0;
  color: var(--vp-c-text-2);
}

.auth-selection {
  margin: 1.5rem 0;
}

.auth-options {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin: 1rem 0;
}

.auth-option {
  display: flex;
  align-items: center;
  padding: 0.75rem;
  background: var(--vp-c-bg);
  border: 2px solid var(--vp-c-divider);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
}

.auth-option:hover {
  border-color: var(--vp-c-brand);
  background: var(--vp-c-bg-soft);
}

.auth-option input[type='radio'] {
  margin-right: 0.75rem;
}

.auth-option input[type='radio']:checked + span {
  font-weight: 500;
  color: var(--vp-c-brand);
}

.secrets-info,
.auth-fields {
  margin-top: 1rem;
  padding: 1rem;
  background: var(--vp-c-bg);
  border-radius: 6px;
  border: 1px solid var(--vp-c-divider-light);
}

.secrets-info p {
  margin-bottom: 0.5rem;
}

.secrets-info ul {
  margin: 0.5rem 0;
  padding-left: 1.5rem;
}

.secrets-info code {
  background: var(--vp-c-bg-soft);
  padding: 0.2rem 0.4rem;
  border-radius: 3px;
  font-size: 0.9rem;
}

.secret-links {
  display: flex;
  gap: 1rem;
  margin-top: 1rem;
  flex-wrap: wrap;
}

.quick-guide {
  background: var(--vp-c-bg-alt);
  padding: 1rem;
  border-radius: 6px;
  margin-top: 1rem;
  border-left: 3px solid var(--vp-c-brand);
}

.quick-guide h5 {
  margin: 0 0 0.75rem 0;
  color: var(--vp-c-text-1);
  font-size: 0.95rem;
}

.quick-guide ol {
  margin: 0;
  padding-left: 1.5rem;
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
}

.quick-guide li {
  margin: 0.25rem 0;
}

.setup-link {
  display: inline-flex;
  align-items: center;
  padding: 0.5rem 1rem;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand);
  text-decoration: none;
  border-radius: 6px;
  font-size: 0.9rem;
  transition: all 0.2s;
  border: 1px solid var(--vp-c-brand-dimm);
}

.setup-link:hover {
  background: var(--vp-c-brand);
  color: white;
  transform: translateY(-2px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}
</style>
