# Changelog

## 1.0.2

### Added

- Cluster Ops: pick hosts by fleet, folder, tag or one by one, and let the assistant run shell commands on them in parallel, with live results per host
- Every Cluster Ops command is recorded per host and written to the audit log
- Admin settings for the Cluster Ops step limit, parallel hosts, command timeout and output kept per host
- The `ai.ops.use` permission, for admins only by default

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
