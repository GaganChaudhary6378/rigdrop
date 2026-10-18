---
name: rigdrop-share
description: Share this machine's Claude Code and Codex setup (skills, plugins, rules, MCP servers) as one RigDrop link that another agent can install. Use when the user says "share my setup", "share my skills/plugins", "make a link of my agent setup", or runs /rigdrop-share.
argument-hint: "[title]"
---

# RigDrop share

Publish the user's agent setup and give back one link. Upload nothing before the user approves the list.

Use `rigdrop` below as short for `npx --yes github:GaganChaudhary6378/rigdrop`.

## Steps

1. Run `rigdrop whoami`. If it says "Not signed in", run `rigdrop login`. It opens Google sign-in in the browser and waits. Tell the user to finish the sign-in in the browser.
2. Run `rigdrop share --dry-run --json` (add `--title "<title>"` when the user gave one, and `--project <path>` when they want this project's skills and rules too). Read the JSON.
3. Show the user a short summary:
   - `sources`: tools installed from a marketplace or repository. Only the names and the install commands are uploaded. Example: "gstack (garrytan/gstack): 127 skill paths", "vercel-labs/agent-skills: 9 skills".
   - `files`: local files that are uploaded as content. Name each one, with `items[].id` for its item.
   - `notes` and `skipped`: what is not shared, and why.
   - `bundleBytes`: the upload size.
   Point out rules files (`CLAUDE.md`, `AGENTS.md`) and MCP servers. They are personal and the user may not want to share them.
4. Ask the user what to remove. Keep the IDs or file paths they name.
5. After the user approves, run `rigdrop share --yes --json --exclude <id-or-path,...>` with the same `--title` and `--project` options. Leave out `--exclude` when nothing is removed.
6. Give the user the `page` link and this line for the other person:

   > Open Claude Code or Codex and say: "Install this setup: <page>" (or run `/rigdrop-review <page>`).

## Errors

- "Run rigdrop login first" or "Session expired": run `rigdrop login`, then repeat step 5.
- "Bundle failed the server review" or "Possible secret found": show the listed files. Remove them with `--exclude`, or ask the user to remove the secret from the file. Never edit the user's files to hide a secret without asking.
- "Daily publishing limit reached": tell the user to try again in 24 hours.
