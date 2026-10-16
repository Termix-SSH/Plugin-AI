# Changelog

## 1.0.2

### Added

- One AI assistant with two views that share their conversations: a floating panel on every page, opened from a button or Ctrl+J, and the full-screen AI tab
- The assistant manages Termix through the Termix CLI, which ships inside the plugin and runs as the signed-in user, and can open terminals, tabs, settings and sidebar views
- With the new `ai.ops.use` permission (admins only by default), the assistant runs shell commands on target hosts in parallel, with live results per host; pick targets by fleet, folder, tag or host, type `@` to add them, or let the assistant choose
- Every command on a host and every Termix CLI call is recorded and written to the audit log, with secret arguments masked
- Admin settings for the assistant's step limit, parallel hosts, command timeout and output kept per host
- Pick up past conversations from Conversations

### Changed

- AI in the sidebar now opens the assistant full screen, replacing the old chat; the terminal assistant still proposes changes for you to approve
- Without `ai.ops.use`, the assistant has no target hosts and cannot run commands on hosts through the CLI, including `exec`, `fleets exec`, `snippets run` and execute routes

### Fixed

- Change proposals showed a host id instead of the host name

## 1.0.1

### Changed

- Translated into every supported language

## 1.0.0

### Added

- First release
- Ask about your hosts, snippets, fleets, alerts, automations and more, or about one host right from its terminal
- Proposes changes instead of making them, and nothing runs until you approve it
- Can run safe read-only commands like `df` and `uptime` if you allow it
- Works with Ollama, Anthropic, OpenAI, Google Gemini and any OpenAI compatible endpoint
- AI Agents: run Pi, OpenCode, Claude Code or Codex on an SSH host using one of your Termix providers, with tool approvals, queued messages, attachments, Git diffs and worktrees
- One-click install of the selected agent and Node.js, and a button to set up SSH loopback forwarding
