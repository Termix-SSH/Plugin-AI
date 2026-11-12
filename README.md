<div align="center">

<img src="https://termix.site/img/logo.svg" width="120" alt="Termix Logo" />

<h1>AI Assistant</h1>

<p>An AI assistant that reads your setup and proposes changes for you to approve</p>

<!-- VIDEO:START -->

<a href="https://www.youtube.com/watch?v=YgdIrZuDUO4"><img src="https://img.shields.io/badge/Watch_the_demo-f59145?style=for-the-badge&logo=youtube&logoColor=white" alt="Watch the demo on YouTube" /></a>

<!-- VIDEO:END -->

</div>

<br />

## Overview

AI Assistant is one assistant, floating on every page or full screen in the AI tab, that manages Termix as you through the bundled Termix CLI. Beside a terminal it reads your setup and proposes changes for you to approve. It can also run coding agents on your SSH hosts.

Read the [docs](https://docs.termix.site/plugins/ai) to set it up and use it.

<br />

## Features

- Ask about your hosts, snippets, fleets, alerts, automations and more
- Proposes changes instead of making them, and nothing runs until you approve it
- Can run safe read-only commands like `df` and `uptime` if you allow it
- Ask about a host right from its terminal
- Works with Ollama, Anthropic, OpenAI, Google Gemini and any OpenAI compatible endpoint
- Run Pi, OpenCode, Claude Code or Codex as a coding agent on an SSH host, using your own provider
- One AI assistant, floating on every page (Ctrl+J) or full screen in the AI tab, that manages Termix as you through the bundled Termix CLI and opens views for you
- With the `ai.ops.use` permission, it also runs shell commands across the hosts, folders, tags or fleets you select
- Find and run actions other plugins offer, like restarting a container or waking a machine, with changes waiting for your approval
- A Failing drive task that reads SMART and array state when Storage Health finds a problem
- A homepage widget with recent tasks and plans waiting for approval

<br />

## Sponsors

For a paid sponsor spot, email [mail@termix.site](mailto:mail@termix.site).

<!-- SPONSORS:START -->

<div align="center">

<br />

<a href="https://www.blacksmith.sh/">
  <img src="https://termix.site/img/sponsors/blacksmith.svg" height="40" alt="Blacksmith" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://www.cloudflare.com/">
  <img src="https://termix.site/img/sponsors/cloudflare.png" height="40" alt="Cloudflare" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://akamai.com/">
  <img src="https://termix.site/img/sponsors/akamai.svg" height="40" alt="Akamai" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://aws.amazon.com/">
  <img src="https://termix.site/img/sponsors/aws.png" height="40" alt="AWS" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://rackgenius.com/">
  <img src="https://termix.site/img/sponsors/rackgenius.png" height="40" alt="Rack Genius" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://ginernet.com/">
  <img src="https://termix.site/img/sponsors/ginernet.png" height="40" alt="Ginernet" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://www.hetzner.com/?mtm_campaign=termix&mtm_medium=referral&mtm_content=sponsoring_link">
  <img src="https://termix.site/img/sponsors/hetzner.png" height="40" alt="Hetzner" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://emberswan.com/">
  <img src="https://termix.site/img/sponsors/emberswan.png" height="40" alt="Ember Swan" />
</a>

</div>

<!-- SPONSORS:END -->

<br />

## Support

Bugs and ideas for AI Assistant go in this repo: [report a bug](https://github.com/Termix-SSH/Plugin-AI/issues/new?template=bug_report.yml) or [request a feature](https://github.com/Termix-SSH/Plugin-AI/issues/new?template=feature_request.yml). Report an issue on the plugin's page in the Plugins tab fills in your versions for you.

Problems with Termix itself (login, hosts, credentials, sharing, sync) go in the [Termix repo](https://github.com/Termix-SSH/Termix/issues/new/choose). Not sure where it goes? Open it there and it will be moved.

Add as much detail as you can, in English if possible. For questions, join the [Discord](https://discord.gg/jVQGdvHDrf) server.

<br />

## License

Apache License 2.0. See [LICENSE](LICENSE).
