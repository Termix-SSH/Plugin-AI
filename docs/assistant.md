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
- Closing the panel does not stop the assistant. The button spins while it works; open the panel again to see how it went.

Pick a provider at the top. With none set up yet, Add provider takes you to Settings, AI Assistant, Providers.

Conversations shows past conversations. Plus starts a new one.

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

## Limits

An admin can change the step limit, how many hosts run at once, the command timeout and how much output is kept per host, under Settings, AI Assistant. The assistant can ask for a longer timeout on one command, up to 600 seconds.

## Who can use it

Anyone with the `ai.use` permission, once an admin has turned the assistant on. Opening it turns it on for you. Running commands on hosts also needs `ai.ops.use`, which only admins have at first.
