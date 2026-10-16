---
title: Floating assistant
order: 3
---

The floating assistant is a button in the bottom-right corner of every page. Click it, or press Ctrl+J (Cmd+J on a Mac), to open a chat with an assistant that can work on all of Termix for you: read and change hosts, credentials, snippets, fleets and alerts, run commands on hosts, and open views.

It is the same assistant as [Cluster Ops](cluster-ops.md), with the same conversations. Cluster Ops is its full-screen view.

Changes and commands run without asking you first. Only use it for requests you would trust a person signed in as you with.

## Open it

- Click the button, or press Ctrl+J. Change the key under Settings, Keybindings, Toggle the AI assistant.
- Drag the button to move it. It stays where you put it.
- Drag the panel's top-left corner to resize it. The dock button makes it a full-height drawer on the right, and the expand button opens Cluster Ops.
- Closing the panel does not stop the assistant. The button spins while it works; open the panel again to see how it went.

Conversations shows past conversations. Plus starts a new one.

## Targets

Targets are the hosts the assistant may run shell commands on. They show as chips above the input.

- Type `@` and part of a name to add a host, fleet, folder or tag. A fleet, folder or tag adds all of its hosts.
- Click the x on a chip to remove it.
- The assistant can also choose targets itself, for example "check disk space on everything tagged prod". The chips update as it does.

The assistant can still manage Termix with no targets.

## What it can do

- Manage Termix with the Termix CLI, which ships inside the plugin: list, add, change and delete hosts, credentials, snippets and fleets, list and revoke API keys, read alerts, sessions and the audit log, and call any route with `termix api`. It works as you, with your permissions.
- Run a command on its targets, several at a time, and read their OS and resources. See [Cluster Ops](cluster-ops.md).
- Open a terminal on a host, a tab, a settings page or a sidebar view.

It also knows which tab you are on, and the host when that tab is a terminal or file manager.

The CLI cannot open an interactive terminal, log in or out, keep a tunnel running, or read and write files on the Termix server's own disk. It also cannot run `hosts export`, create API keys, or call export routes through `termix api`, because those print decrypted credentials or new tokens, which would be sent to the model provider. For shell work the assistant uses its targets.

Every CLI call is kept with its arguments, exit code and output, and written to the audit log as `ai_cli_command`. Passwords, keys, tokens and similar values in the arguments are masked.

## Who can use it

The floating assistant needs the `ai.ops.use` permission, the same as Cluster Ops. Only admins have it at first. The assistant also has to be on for the user.
