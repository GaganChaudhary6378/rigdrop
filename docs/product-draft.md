# Product draft

## Problem

Useful agent setups are scattered across machine-specific directories and incompatible tools. A developer may have effective skills, plugins, MCP servers, rules, hooks, and commands in Claude Code, Codex, Cursor, or another agent. Sharing that setup normally means explaining several manual installation steps, copying files, and finding missing credentials.

The result is that good setups remain personal even when they would help an entire team.

## Proposed experience

### Sender

1. Run `agent-setup scan`.
2. Review detected items and select what to share.
3. See which items will be referenced from GitHub and which local files will be uploaded.
4. Resolve secret and privacy warnings.
5. Publish an immutable bundle version and copy its public link.

### Receiver

1. Give the link to a supported agent or run `agent-setup inspect <url>`.
2. See a compatibility report and exact filesystem changes.
3. Approve the installation and provide required secrets locally.
4. Install the bundle.
5. Receive a health report listing installed, skipped, incompatible, and failed items.

## Main differentiator

Existing tools can share one editor profile or one vendor's plugins. RigDrop describes one setup across multiple agent products and carries local extensions safely.

The share link is both:

- machine-readable through a versioned manifest;
- agent-readable through a generated installation document.

The receiver does not need to understand where every agent stores its configuration.

## What a bundle captures

| Category | Captured information | GitHub source | Local source |
|---|---|---|---|
| Skills | Name, version, supported agents, entry file, dependencies | Repository URL, pinned commit, subdirectory | Selected directory copied into payload |
| Plugins | Plugin manifest, compatibility, dependencies | Repository URL and pinned commit | Plugin directory copied into payload |
| MCP servers | Transport, command/package, arguments, URL, required environment-variable names | Package or repository reference | Local server files copied when explicitly selected |
| Agent rules | Rule scope, target agents, destination, precedence | Pinned file reference | Rule file copied into payload |
| Commands | Name, description, command definition, target agents | Pinned reference | Definition copied into payload |
| Hooks | Event, command, timeout, target agents | Pinned reference | Hook definition and selected scripts copied |
| Tool requirements | Runtime and CLI names with version constraints | Reference only | Never copy installed binaries |

## Capture rules

1. GitHub content stays a reference and is pinned to a commit SHA.
2. Local content is copied only after the sender selects it.
3. Secret values are replaced with named requirements such as `GITHUB_TOKEN`.
4. Absolute machine paths become portable bundle paths or receiver-selected paths.
5. Caches, logs, histories, generated files, binaries, `.git`, and dependency folders are excluded.
6. A symlink that leaves the selected directory is rejected.
7. Every captured file receives a SHA-256 checksum.
8. Public publishing requires a final list of every local file that will become public.

## First usable version

Support macOS and Linux with adapters for Claude Code and Codex.

Capture:

- local and GitHub skills;
- local and GitHub plugins;
- MCP definitions without secret values;
- global and project agent rules;
- commands and hooks used by those two agents.

The first release does not need accounts. A bundle can be uploaded anonymously, assigned an unguessable identifier, and treated as immutable. Deletion uses a separate owner token shown once to the publisher.

## Success criteria

- A sender can publish a selected setup in under five minutes.
- A receiver can preview and install it through Claude Code or Codex.
- Reinstalling the same version produces no additional changes.
- A failed installation restores the previous files.
- No detected secret value appears in the manifest, payload, logs, or public page.
- The health report explains every skipped or changed item.

## Not in the first version

- Executing arbitrary scripts directly from a bundle.
- Copying credentials, login sessions, browser cookies, or private keys.
- Synchronizing changes continuously between people.
- Hosting full development machines.
- Supporting every agent before the Claude Code and Codex adapters work well.
- Automatically overwriting conflicting user configuration.
