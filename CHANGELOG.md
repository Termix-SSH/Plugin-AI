# Changelog

## 1.1.0

### Added

- One AI assistant with two views that share their conversations: a floating panel on every page, opened from a button or Ctrl+J, and the full-screen AI tab
- The assistant manages Termix through the Termix CLI, which ships inside the plugin and runs as the signed-in user, and can open terminals, tabs, settings and sidebar views
- With the new `ai.ops.use` permission (admins only by default), the assistant runs shell commands on target hosts in parallel, with live results per host; pick targets by fleet, folder, tag or host, type `@` to add them, or let the assistant choose
- Every command on a host and every Termix CLI call is recorded and written to the audit log, with secret arguments masked
- Admin settings for the assistant's parallel hosts, command timeout and output kept per host
- Pick up past conversations from Conversations, with the tokens each has used
- The assistant shows its replies in the order they happened, text and tool calls interleaved, with the model's thinking in a collapsed Thinking block of its own
- A context meter in the assistant's header, with the window read from the provider: `max_model_len` and the other fields of OpenAI-compatible model lists (vLLM, OpenRouter, Groq and more), Ollama's `num_ctx` and trained length, Gemini's and Anthropic's model limits; a guess from the model name only when the provider says nothing, marked with `~`
- A context window override per model in the provider settings, which list each model's window and where it came from, with Refresh to ask the provider again
- The assistant loads Ollama models with the conversation's window as `num_ctx`, and uses prompt caching on Anthropic
- Automatic compaction: as a conversation nears what the context window leaves after the reply's tokens, older tool results are trimmed and then the earlier part is summarised, marked with "Context compacted"; a header button compacts on request
- Token usage for every AI call, with a usage view in the assistant and in settings, a dashboard card, and every user's usage for those with the new `ai.usage.view_all` permission (admins only by default)
- Assistant runs go on on the server: closing the panel, switching pages, reloading, closing the browser or losing the connection no longer stops them, and coming back shows the conversation with the run continuing live; only Stop ends a run early

### Changed

- The plugin name and description show in your language
- AI in the sidebar now opens the assistant full screen, replacing the old chat; the terminal assistant still proposes changes for you to approve
- Without `ai.ops.use`, the assistant has no target hosts and cannot run commands on hosts through the CLI, including `exec`, `fleets exec`, `snippets run` and execute routes
- The assistant has no step limit any more and runs until it is done or stopped; it only stops itself when it repeats the same call with the same result five times
- A tool result sent back to the model is capped at 12,000 characters, keeping its start and end

### Fixed

- Change proposals showed a host id instead of the host name
- Anthropic providers failed every chat with "signal: Extra inputs are not permitted"
- Thinking from reasoning models, sent as `reasoning_content`, `<think>` tags, Gemini thought parts or Ollama's thinking field, no longer runs into the answer

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
