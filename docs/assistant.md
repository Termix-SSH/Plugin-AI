---
title: AI assistant
order: 2
---

The AI assistant works on all of Termix for you: it reads and changes hosts, credentials, snippets, fleets and alerts, opens views, and, if an admin allows it, runs shell commands on the hosts you pick.

There is one assistant with two views, sharing the same conversations. A run started in one shows in the other.

- **Floating:** a button in the bottom-right corner of every page. Click it, or press Ctrl+J (Cmd+J on a Mac).
- **Full screen:** AI in the sidebar opens the AI tab.

Changes run without asking you first. Only use it for requests you would trust a person signed in as you with.

## Open it

- Click the button, or press Ctrl+J. Change the key under Settings, Keybindings, Toggle the AI assistant.
- Drag the button to move it. It stays where you put it.
- Drag the panel's header to move it and its edges to resize it. The dock button makes it a full-height drawer on the right, and the expand button opens the AI tab.
- The assistant works on the server. Closing the panel, switching pages, reloading or closing the browser does not stop it, and neither does a dropped connection. The button spins while it works; come back to see how it went, or to watch it carry on. One message at a time per conversation.

Pick a provider at the top. With none set up yet, Add provider takes you to Settings, AI Assistant, Providers.

Conversations shows past conversations, with the tokens each has used. Plus starts a new one.

A reply shows in the order it happened: some text, a tool call, more text, the next tool call. When the model thinks before answering, its thinking shows as a collapsed Thinking block above the text it led to; click it to read it. It is never mixed into the answer.

## What it can do

- Manage Termix with the Termix CLI, which ships inside the plugin: list, add, change and delete hosts, credentials, snippets and fleets, list and revoke API keys, read alerts, sessions and the audit log, and call any route with `termix api`. It works as you, with your permissions.
- Open a terminal on a host, a tab, a settings page or a sidebar view.
- With the `ai.ops.use` permission, run shell commands on target hosts. See [run commands on hosts](#run-commands-on-hosts).

It also knows which tab you are on, and the host when that tab is a terminal or file manager.

The CLI cannot open an interactive terminal, log in or out, keep a tunnel running, or read and write files on the Termix server's own disk. It also cannot run `hosts export`, create API keys, or call export routes through `termix api`, because those print decrypted credentials or new tokens, which would be sent to the model provider.

Every CLI call is kept with its arguments, exit code and output, and written to the audit log as `ai_cli_command`. Passwords, keys, tokens and similar values in the arguments are masked.

## Run commands on hosts

With the `ai.ops.use` permission, the assistant can work on many hosts at once: you pick the hosts, describe what you want, and it runs shell commands on them over SSH and reports back per host. Without it, the target picker and chips are not shown, and the assistant cannot run `termix exec`, `termix fleets exec`, `termix snippets run` or call an execute route through `termix api`.

### Targets

Targets are the hosts the assistant may run commands on.

- In the AI tab, check them on the left: fleets (if the Fleets plugin is on), folders including every folder under them, tags, or hosts one at a time. Search filters every list. Hosts without SSH are not listed.
- In either view, type `@` and part of a name to add a host, fleet, folder or tag. A fleet, folder or tag adds all of its hosts. They show as chips above the input; click the x on a chip to remove it.
- The assistant can also choose targets itself, for example "check disk space on everything tagged prod". The chips and the picker update as it does.

The targets go with every message, and the conversation remembers them. The assistant can still manage Termix with no targets.

### Commands

- It can list its targets, run a command on some or all of them, several hosts at a time, and read each host's OS, kernel, CPU count, memory and uptime, once per conversation. A host that is not a target is refused.
- Each command shows as a card with the command, how many hosts it ran on and how many succeeded or failed. Hosts appear as they finish, with their exit code, how long it took and the first line of output. Click a host to see its full output.
- Commands run without a terminal, so anything that waits for input fails or times out. Long output keeps its start and end.
- Stop ends the assistant's run and closes any command still running.

Every command on every host is kept with its exit code, duration and output, and written to the audit log. Your own SSH access to each host still applies.

## Context and compaction

A model can only read so much at once, its context window. The header shows how much of it the latest call took, for example `42k / 524k`. A `~` in front of the tokens used means they are an estimate, because the provider did not report its token counts; a `~` in front of the window means the window is a guess. Hover the meter to see where the window came from and how much is kept free for the reply.

The window comes from the provider wherever it says:

| Provider                                                                           | Where the window is read                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI-compatible (vLLM, SGLang, OpenRouter, LM Studio, Groq, Together and others) | The model's entry in `GET /models`: `max_model_len`, `context_length`, `top_provider.context_length`, `context_window`, `max_context_length` or `input_token_limit`. The reply's limit from `top_provider.max_completion_tokens`, `max_completion_tokens` or `max_output_tokens` |
| Ollama                                                                             | `POST /api/show`: the `num_ctx` the model is set to load with, else its trained `context_length`                                                                                                                                                                                 |
| Gemini                                                                             | The model's `inputTokenLimit` and `outputTokenLimit`                                                                                                                                                                                                                             |
| Anthropic                                                                          | The models API's `max_input_tokens` and `max_tokens`                                                                                                                                                                                                                             |

What a provider reports is kept for six hours, or five minutes when it said nothing or did not answer within five seconds. Editing the provider, or Refresh in its settings, asks again.

In order, the window is:

1. Your override for the model, under Settings, AI Assistant, Providers, edit, Context window per model. It is still held to what the model can take at all.
2. What the provider reports.
3. A guess from the model's name: Claude 200k, GPT-5 400k, GPT-4.1 and Gemini 1M, GLM 4.6 and later 200k, Qwen 2.5 and Mistral 32k.
4. 128k.

The settings list the default model, every model with an override and every model you have used, each with its window and where it came from.

Part of the window is kept free for the reply: what the provider allows for a reply, or what the assistant asks for (16,000 tokens for Anthropic) if that is less, else 8,192, and never more than a quarter of the window. Another 2% is kept as a margin for estimates.

On Ollama the assistant loads the model with the window as `num_ctx`, so Ollama does not cut the start of a long conversation at its own small default. Lower the window with an override if the model does not fit in memory at its full length.

On Anthropic the tools, the system prompt and the newest message are marked for prompt caching, so each call of a long run reads the earlier part from the cache.

Before each call, when the conversation would take more than about 80% of what is left after the reply (85% on Anthropic, as compaction starts the cache over), the assistant makes room on its own:

1. Older tool results are cut to their start and end. The last four stay whole.
2. If that is not enough, one extra model call summarises the earlier part of the conversation. The summary stands in for it from then on, and the most recent steps and your latest message are kept word for word. A tool call is never separated from its result.

A "Context compacted" line marks the spot in the conversation. The summary is saved, so the conversation carries on from it after a reload. The compact button in the header does the same on request.

A single tool result is never sent to the model at more than 12,000 characters; longer ones keep their start and end. You still see the whole result in the tool card.

## Usage

Every model call is counted: the assistant, the terminal assistant and compaction. The chart button in the header shows today's tokens; click it for the usage view, which is also under Settings, AI Assistant, Token usage. It shows today, the last 7 and 30 days, tokens per day, per model and per feature. Someone with `ai.usage.view_all`, admins by default, can switch to all users and see a breakdown per user.

Providers that report token counts are counted exactly: OpenAI and compatible endpoints from their final usage chunk, Anthropic, Gemini and Ollama from their own counts. When a provider reports nothing, the tokens are estimated at about four characters each and marked as estimated.

The dashboard can show an AI token usage card with today's and the last 30 days' tokens, your own, or the whole server's if you can see everyone's.

## Limits

The assistant keeps going until it is done or you press Stop; there is no step limit. It does stop on its own when it calls the same tool with the same arguments and gets the same result five times in a row, since it is then going nowhere.

An admin can change how many hosts run at once, the command timeout and how much output is kept per host, under Settings, AI Assistant. The assistant can ask for a longer timeout on one command, up to 600 seconds.

## Who can use it

Anyone with the `ai.use` permission, once an admin has turned the assistant on. Opening it turns it on for you. Running commands on hosts also needs `ai.ops.use`, which only admins have at first. Seeing every user's token usage needs `ai.usage.view_all`, also admins only at first.
