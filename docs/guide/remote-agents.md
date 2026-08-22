# Remote agents

<script setup>
import CliRemoteHero from '../.vitepress/components/CliRemoteHero.vue';
</script>

Remote agents are cloud-hosted agents maintained by the TeXRA team. They add specialized capabilities to TeXRA and receive updates without an extension update.

## What are remote agents?

Remote agents are pre-configured agents hosted in the cloud that you can run directly from TeXRA. Unlike built-in agents, they:

- Receive updates automatically, without an extension update
- Provide specialized capabilities for specific research domains
- Load on demand, so the extension stays small

## Getting started

### 1. Sign in to TeXRA

Remote agents require a TeXRA account:

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run **TeXRA: Sign In**
3. Choose a sign-in method (GitHub or Google)
4. Complete the sign-in flow in your browser
5. Return to VS Code once signed in

::: tip
To check your sign-in status at any time, run **TeXRA: View Profile** from the Command Palette.
:::

### 2. Browse available agents

Once signed in, browse remote agents from the Agents tab:

1. Open the Command Palette
2. Run **TeXRA: Show Agents** to open the Agents tab in Settings
3. Select a remote agent in the list to see its details
4. Select **Show in agent selector** to add it to your agent selector

Your email and access level sit on the Account & Usage tab (**TeXRA: View Profile**).

The selected agent appears in the main TeXRA view alongside your built-in agents.

### 3. Use remote agents

Remote agents work like built-in agents:

1. Open the TeXRA view (select the TeXRA icon in the Secondary Side Bar)
2. Select your remote agent from the agent dropdown
3. Choose your input file and model
4. Select **Run** to start the agent

::: info
Remote agents carry a cloud icon (☁️) in the agent selector to set them apart from local agents.
:::

The agent dropdown is a single flat list with no Local/Remote headers; remote agents are told apart only by the trailing cloud icon (tooltip: Remote agent, prompts loaded from cloud), and a **Browse all agents…** entry at the end opens Settings → Agents:

<DropdownMenu
  label="Agent"
  value="search"
  valueIcon="cloud"
  maxWidth="320px"
  :groups="[
    { items: [
      { name: 'polish', icon: 'sparkle' },
      { name: 'correct', icon: 'pencil' },
      { name: 'search', icon: 'cloud', badge: 'in use', badgeVariant: 'accent', active: true },
      { name: 'simplifier', icon: 'cloud' },
      { name: 'orchestrator', icon: 'cloud' },
    ] },
  ]"
/>

<p class="hero-caption">The agent dropdown: one flat list where remote agents (<code>search</code>, <code>simplifier</code>, <code>orchestrator</code>) carry a cloud marker that sets them apart from local agents like <code>polish</code> and <code>correct</code>.</p>

None of this is VS Code-only. The whole loop works from a terminal too:

<CliRemoteHero />

<p class="hero-caption">Sign in once and remote agents resolve by name everywhere: <code>agents show</code> reports <code>source: remote</code>, and <code>texra chat --agent search</code> runs it like any local agent.</p>

## Remote agent access

Signed-in researchers, academics, and technical writers can use specialized remote agents for academic research and professional writing. Signing in only unlocks the hosted agent catalog. Remote agents still run on your own credential, the same provider API key or subscription as your built-in agents. Access includes:

- **Specialized domain agents**: Agents tailored for specific research fields (mathematics, computer science, physics, and others)
- **Advanced reasoning capabilities**: Multi-step analysis and complex document processing
- **Beta features**: Early access to experimental agents and capabilities
- **Priority improvements**: Your feedback directly influences agent development

<FeatureCards
  min="220px"
  :cards="[
    { icon: 'mortar-board', title: 'Specialized domain agents', desc: 'Agents tailored for specific research fields.', chips: [{ text: 'mathematics', variant: 'info' }, { text: 'CS', variant: 'info' }, { text: 'physics', variant: 'info' }] },
    { icon: 'pulse', title: 'Advanced reasoning', desc: 'Multi-step analysis and complex document processing.', chips: [{ text: 'multi-step', variant: 'neutral' }] },
    { icon: 'sparkle', title: 'Beta features', tag: 'Early access', tagVariant: 'accent', desc: 'Early access to experimental agents and capabilities.' },
    { icon: 'comment-discussion', title: 'Priority improvements', desc: 'Your feedback directly influences agent development.', chips: [{ text: 'your feedback', variant: 'neutral' }] }
  ]"
/>

<p class="hero-caption">What remote agent access gets you: domain-specific agents, advanced multi-step reasoning, early access to beta agents, and a direct line into how agents evolve.</p>

Current remote agents include `search` (literature discovery), `simplifier` (code and writing simplification), and `orchestrator` (multi-agent coordination). Read the [remote agents section of the built-in agents guide](./built-in-agents.md#remote-agents) for details on each.

Different agents may be available to different research groups, depending on their domain and needs.

### Requesting access

Remote agent access is available to active researchers, academics, and technical writers. To request it:

1. **Sign in** to TeXRA using your institutional or professional email
2. **Contact us** at [contact@texra.ai](mailto:contact@texra.ai) with:
   - Your name and affiliation
   - A brief description of your research area
   - How you plan to use remote agents

We review each request and grant access within 1-2 business days.

::: tip Free for researchers
TeXRA supports academic research. Remote agent access is **free for qualifying researchers and students**: there is no charge for the hosted agent catalog. Model calls made by those agents are still billed to your own provider account or subscription.
:::

## Managing your account

### View your profile

To check your account status:

1. Open the Command Palette
2. Run **TeXRA: View Profile**
3. View your email and access level on the Account & Usage tab

Run **TeXRA: Show Agents** to browse the remote agents available to you.

### Sign out

To sign out of your TeXRA account:

1. Open the Command Palette
2. Run **TeXRA: Sign Out**
3. Confirm sign out

Your local agents continue to work after signing out. Only remote agents become unavailable until you sign in again.

## Frequently asked questions

### Do I need to sign in to use TeXRA?

No. TeXRA works fully offline with built-in agents. Sign in only if you want remote agents from the cloud.

### Are remote agents slower than built-in agents?

Remote agents perform similarly to built-in agents. The agent configuration is loaded from the cloud, but the model runs with your configured API keys, as with built-in agents.

### Can I use remote agents offline?

No. Remote agents require an internet connection to load their configurations. For offline work, use built-in agents instead.

### What happens to my documents?

Your documents are never uploaded to TeXRA servers. Remote agents only load their configuration (prompts and settings) from the cloud. All document processing happens locally using your own API keys.

### Can I create my own remote agents?

Currently, remote agents are maintained by the TeXRA team. If you have ideas for new agents or want to share your custom agents with the community, contact us at [contact@texra.ai](mailto:contact@texra.ai).

### How do I disable remote agents?

Remote agents are available only while you are signed in. To stop using them, sign out; your built-in agents keep working. (In the CLI, run `texra auth logout`; in the VS Code extension, use the sign-out action in the account menu.)

## Need help?

If you run into issues with remote agents or have questions about access:

- **Email**: [contact@texra.ai](mailto:contact@texra.ai)
- **Documentation**: [texra.ai/guide](https://texra.ai/guide)

We typically respond within 24-48 hours.
