---
name: rigdrop
description: Share, review, or exclude named skills from a RigDrop agent-setup link. Use when the user runs /rigdrop share, /rigdrop review URL, /rigdrop ignore SKILL..., or asks to share or review an agent setup without using the terminal.
argument-hint: "share [title] | review <rigdrop-url> | ignore <skill-name...>"
---

# RigDrop

The user interacts only through `/rigdrop`; run any required RigDrop commands yourself. Do not ask them to open a terminal.

## `/rigdrop ignore <skill-name...>`

1. Run `npx --yes github:GaganChaudhary6378/rigdrop share --dry-run --json`.
2. Match each supplied name exactly against an item whose `kind` is `skill`. If a name does not match, say so and list the available skill names. Do not treat file numbers as names.
3. Confirm the names that will be excluded. Remember them for subsequent `/rigdrop share` calls in this conversation. They are not deleted and are not persisted outside this conversation.

## `/rigdrop share [title]`

1. Run `npx --yes github:GaganChaudhary6378/rigdrop whoami`. If it says `Not signed in`, run `npx --yes github:GaganChaudhary6378/rigdrop login` and tell the user to finish Google sign-in in the browser.
2. Run `npx --yes github:GaganChaudhary6378/rigdrop share --dry-run --json`, adding `--title "<title>"` if supplied and `--exclude <ignored-name,...>` for names ignored in this conversation.
3. Summarize sources, uploaded local files, skipped files, rules, MCP servers, and upload size. Rules and MCP servers can contain personal preferences; call them out explicitly.
4. Ask for approval before publishing. When approved, run the same command with `--yes --json` instead of `--dry-run`. Give the returned page link and tell the recipient to run `/rigdrop review <page>`.

## `/rigdrop review <rigdrop-url>`

1. Run `npx --yes github:GaganChaudhary6378/rigdrop inspect <url> --files` and read `<url>/review.json`.
2. Inspect embedded files, server warnings, MCP commands, scripts, rules, install sources, Git references, and destinations. Flag unpinned `npx` or `uvx`, remote execution, destructive actions, credential access, and instructions that bypass confirmations.
3. Give one verdict: **Safe to install**, **Install after changes**, or **Do not install**, naming the exact items behind it.
4. Do not install until the user explicitly approves. Then preview with `npx --yes github:GaganChaudhary6378/rigdrop install <url>` and install with `--yes`, adding `--exclude <item-id,...>` when requested. Report failed or skipped lines, any required `./setup`, and the rollback ID. Never run a setup script without separate approval.

