---
title: Cluster Ops
order: 2
---

Cluster Ops lets the assistant work on many hosts at once. You pick the hosts, describe what you want, and it runs shell commands on them over SSH and reports back per host.

It is the full-screen view of the [floating assistant](assistant.md): the same assistant and the same conversations, with the target picker on the left. A run started in one shows in the other.

Unlike the assistant chat, commands here run without asking you first. Only use it with hosts and a request you would trust a person with a shell on.

## Pick the hosts

Open Cluster Ops from the sidebar. On the left, check what the assistant may work on:

- Fleets, if the Fleets plugin is on. Checking one adds its hosts.
- Folders, including every folder under it.
- Tags.
- All hosts, one at a time.

The count at the top shows how many hosts are selected. Search filters every list. Hosts without SSH are not listed.

You can also type `@` in the input to add hosts, fleets, folders or tags, or let the assistant pick them. Both show up here.

## Ask

Pick a provider and type what you want, like "check free disk space" or "restart nginx where it is not running". The selected hosts go with every message, and the conversation remembers them.

Conversations shows past conversations; opening one brings back its hosts too.

Each command shows as a card with the command, how many hosts it ran on and how many succeeded or failed. Hosts appear as they finish, with their exit code, how long it took and the first line of output. Click a host to see its full output.

Stop ends the assistant's run and closes any command still running. New conversation starts over.

## What the assistant can do

- List the selected hosts, or choose them itself by host, fleet, folder or tag.
- Run a command on some or all of them, several hosts at a time. A host you did not select is refused.
- Read each host's OS, kernel, CPU count, memory and uptime, once per conversation.

- Manage Termix with the Termix CLI and open views. See the [floating assistant](assistant.md).

Commands run without a terminal, so anything that waits for input fails or times out. Long output keeps its start and end.

Every command on every host is kept with its exit code, duration and output, and written to the audit log.

## Limits

An admin can change the step limit, how many hosts run at once, the command timeout and how much output is kept per host, under Settings, AI Assistant. The assistant can ask for a longer timeout on one command, up to 600 seconds.

## Who can use it

Cluster Ops needs the `ai.ops.use` permission. Only admins have it at first. The assistant also has to be on for the user, and their own SSH access to each host still applies.
