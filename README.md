# RigDrop

Export selected Claude Code and Codex settings into one reviewable bundle, publish it to an agent-readable URL, and install it on another machine.

**Hosted app:** [agent-setup-link.vercel.app](https://agent-setup-link.vercel.app)

The CLI copies local skills, plugins, and rule files into the bundle. If an item is already inside a public GitHub repository, it records a commit-pinned reference instead. MCP definitions are included with environment values replaced by variable placeholders.

## What works

- Detect Claude Code, Codex, and shared Agent Skills folders.
- Capture user or project skills, plugins, rules, and MCP definitions.
- Reject common secrets, `.env` files, unsafe symlinks, and oversized payloads.
- Preview every destination before installation.
- Keep existing files by default; `--force` replaces them after making a backup.
- Roll back an installation from its local journal.
- Publish a bundle to the hosted registry and install from its public URL.

No bundle scripts are executed. Secret values are never written into a bundle.

## Requirements

- Node.js 20 or newer
- Git, when a bundle contains a GitHub reference
- A publishing token for adding bundles to the hosted registry

## Setup

```sh
git clone https://github.com/GaganChaudhary6378/rigdrop.git
cd rigdrop
npm link
agent-setup doctor
```

There are no runtime dependencies and no build step.

## Create and share a setup

```sh
agent-setup scan
agent-setup scan --project /path/to/project --out team.bundle.json
agent-setup inspect team.bundle.json
agent-setup publish team.bundle.json
```

Set the private publishing token and publish:

```sh
set -a; source .env.local; set +a
agent-setup publish team.bundle.json
```

The local `.env.local` file is ignored by Git. Never commit it or paste its token into a bundle.

`publish` displays the public bundle URL. Anyone with the link can read the embedded local files, so inspect the bundle before publishing.

## Install a shared setup

Preview only, then apply:

```sh
agent-setup install https://agent-setup-link.vercel.app/s/BUNDLE_ID
agent-setup install https://agent-setup-link.vercel.app/s/BUNDLE_ID --project /path/to/project --yes
```

Existing destinations are kept. Use `--force` to replace them after a backup:

```sh
agent-setup install team.bundle.json --yes --force
agent-setup rollback INSTALLATION_ID
```

Installation journals and backups live in `~/.agent-setup-link/installations` and `~/.agent-setup-link/backups`.

## Supported locations

| Content | Claude Code | Codex | Shared |
|---|---|---|---|
| Skills | `~/.claude/skills` | `~/.codex/skills` | `~/.agents/skills` |
| Plugins | `~/.claude/plugins` | `~/.codex/plugins` | — |
| Rules | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | project `AGENTS.md` / `CLAUDE.md` |
| MCP | `~/.claude.json`, `.mcp.json` | `~/.codex/config.toml` | — |

Codex TOML support reads only `[mcp_servers.NAME]` sections and their `env` tables. Other Codex settings remain untouched.

## Bundle format

Bundles are JSON. Every embedded file has a SHA-256 digest. GitHub sources contain a repository URL, an exact commit, and a path. The whole bundle also has an integrity digest.

See the [product draft](docs/product-draft.md), [technical plan](docs/technical-plan.md), and [example bundle](examples/agent-setup.bundle.yaml).

## Development

```sh
npm test
npm run check
```

Copy `.env.example` into `.env.local` for local web development. Apply the migration under `supabase/migrations`, then configure the same three variables in Vercel. `PUBLISH_TOKEN` must match the publishing token hash used by the migration.

## Hosted architecture

- Vercel serves the website, public pages, and server functions.
- Supabase stores immutable bundle manifests with RLS enabled.
- Public pages expose HTML, JSON, and Markdown from the same bundle ID.
- The publishing API requires `PUBLISH_TOKEN`; bundle reads are public.

## Project status

This is an MVP for personal projects and trusted teams. It does not sync live sessions, install arbitrary binaries, or translate agent-specific plugin formats.

## License

MIT
