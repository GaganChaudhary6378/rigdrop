# RigDrop

Export selected Claude Code and Codex settings into one reviewable bundle, publish it to an agent-readable URL, and install it on another machine.

**Hosted service:** [rigdrop.rigdrop.workers.dev](https://rigdrop.rigdrop.workers.dev) (Cloudflare Worker API).

The CLI finds how each skill and plugin was installed and shares the install source instead of copies of the files. It captures portable instruction and script files only for skills, plugins, and rules that have no known source. GitHub-backed content is recorded as a commit-pinned reference instead of copied. Build output, binaries, office files, images, files over 256 KB, synced work folders, hidden agent folders, and caches stay local. MCP definitions contain server names and commands only.

## What works

- Detect Claude Code, Codex, and shared Agent Skills folders.
- Capture user or project skills, plugins, rules, and MCP definitions.
- Reject common secrets, `.env` files, unsafe symlinks, and files outside the portable text and script set.
- Keep large tool installations as GitHub references and list skipped local files before publishing.
- Preview every destination before installation.
- Keep existing files by default; `--force` replaces them after making a backup.
- Roll back an installation from its local journal.
- Sign in with Google, publish a bundle you own, and unpublish it later.
- Re-check every uploaded bundle on the server and publish a review report with it.
- Review a shared link from Claude Code or Codex with `/rigdrop review`.
- Install from a public URL without an account.

No bundle scripts are executed. Secret values are never written into a bundle.

## Requirements

- Node.js 20 or newer
- Git, when a bundle contains a GitHub reference
- A Google account, only to publish

## Use RigDrop from your agent

Install the RigDrop skill once for Claude Code and Codex:

```sh
npx --yes github:GaganChaudhary6378/rigdrop add-skill
```

Then use plain language in the Claude Code CLI or IDE extension, or in Codex:

| You say | The agent does |
|---|---|
| `/rigdrop share` | Signs you in if needed, previews every bundled skill, then asks whether to publish a public or private link |
| `/rigdrop ignore skill-a skill-b` | Keeps named local skills out of a later `/rigdrop share` in this chat; no file numbers are needed |
| `/rigdrop review https://rigdrop.rigdrop.workers.dev/s/ID` | Reviews the files, commands, and sources, gives a verdict, and installs after you approve |

## Install sources

RigDrop records these install sources and uploads only their names and install commands:

| Source | Found in | Receiver runs |
|---|---|---|
| Claude Code plugins | `~/.claude/plugins/installed_plugins.json`, `known_marketplaces.json` | `claude plugin marketplace add REPO`, `claude plugin install NAME@MARKETPLACE --scope user` |
| Codex plugins | `[plugins."NAME@MARKETPLACE"]` in `~/.codex/config.toml` | `codex plugin marketplace add REPO`, `codex plugin add NAME@MARKETPLACE` |
| Skills CLI skills | `~/.agents/.skill-lock.json` (`npx skills add`) | `npx --yes skills add OWNER/REPO -g -y --skill NAME...` |
| Skills linked into one GitHub clone (for example gstack) | Symlinks in the skills folders | RigDrop clones the repository at the same commit and makes the same links |

Example: gstack makes about 127 skill links from one clone. RigDrop shares it as one source, not 127 file folders.

- RigDrop builds each command from checked names and repository fields. It never runs command text from a bundle.
- Plugins from local marketplaces (for example the plugins built into the Codex app) are listed as not shared.
- `claude`, `codex`, and `npx skills` install their latest version. The bundle records the sender's commit for clones only.
- A clone with a setup script (for example `./setup`) is not run automatically. The install prints the command.
- `rollback` removes RigDrop files and clones. It does not remove plugins or skills that `claude`, `codex`, or `npx skills` installed.
- Running source commands is not supported on Windows yet.

## Use RigDrop directly

```sh
npx --yes github:GaganChaudhary6378/rigdrop doctor
```

There are no runtime dependencies or installation step. `npx` downloads and runs the GitHub version for the command, then caches it locally.

## Create and share a setup

```sh
npx --yes github:GaganChaudhary6378/rigdrop login
npx --yes github:GaganChaudhary6378/rigdrop share
npx --yes github:GaganChaudhary6378/rigdrop share --project /path/to/project --title "Team setup"
```

`login` opens Google sign-in in the browser and receives the result on `http://127.0.0.1:53682/callback`. The session is stored in `~/.rigdrop/session.json` (mode `0600`) and refreshes automatically. It never enters a bundle. Use `whoami` to check the account and `logout` to end the session.

`share` scans the setup, lets you choose **public** (no password) or **private** (a team passcode), publishes it under your account, prints one unique link, then removes the temporary bundle. When an agent publishes privately, RigDrop opens a password-only form on `127.0.0.1`, so the passcode stays out of the chat and command line. Private bundles require the passcode for the manifest, review, and instructions endpoints; D1 stores an HMAC digest, never the passcode. The server repeats bundle validation and rejects malformed uploads. Each account can publish 20 bundles in 24 hours.

For an automated private share, provide the mode and passcode explicitly:

```sh
npx --yes github:GaganChaudhary6378/rigdrop share --private --passcode "team-only-passcode" --yes
npx --yes github:GaganChaudhary6378/rigdrop install https://rigdrop.rigdrop.workers.dev/s/BUNDLE_ID --passcode "team-only-passcode" --yes
```

Remove a bundle you published:

```sh
npx --yes github:GaganChaudhary6378/rigdrop unpublish https://rigdrop.rigdrop.workers.dev/s/BUNDLE_ID
```

Before upload, `share` lists the install sources, every included file, its size, the total upload size, Git references, and excluded paths. Use `e` to remove file numbers for that one share, `--exclude ITEM_ID_OR_NAME_OR_PATH` to remove items or files without a prompt, `--dry-run` to review without upload, or `--yes` for a noninteractive upload. Add `--json` for output that an agent can read.

Anyone with the link can read embedded local files, so use the advanced two-step flow when you want to inspect before publishing:

```sh
npx --yes github:GaganChaudhary6378/rigdrop scan --out team.bundle.json
npx --yes github:GaganChaudhary6378/rigdrop inspect team.bundle.json
npx --yes github:GaganChaudhary6378/rigdrop publish team.bundle.json
```

## Review a shared setup with an agent

Then, in Claude Code or Codex:

```text
/rigdrop review https://rigdrop.rigdrop.workers.dev/s/BUNDLE_ID
```

In Codex, ask it to review the RigDrop link. The skill reads the files, the server review report (`/s/BUNDLE_ID/review.json`), MCP commands, scripts, and rules, then gives a verdict. It installs nothing without your approval.

## Install a shared setup

Preview only, then apply:

```sh
npx --yes github:GaganChaudhary6378/rigdrop inspect https://rigdrop.rigdrop.workers.dev/s/BUNDLE_ID
npx --yes github:GaganChaudhary6378/rigdrop install https://rigdrop.rigdrop.workers.dev/s/BUNDLE_ID --project /path/to/project --yes
```

The preview lists every destination and every command that the install runs. Skip items with `--exclude ITEM_ID`. Existing destinations are kept. Use `--force` to replace them after a backup:

```sh
npx --yes github:GaganChaudhary6378/rigdrop install team.bundle.json --yes --force
npx --yes github:GaganChaudhary6378/rigdrop rollback INSTALLATION_ID
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

Bundles are JSON. Embedded portable files are gzip-compressed and each has a SHA-256 digest of its original content. GitHub sources contain a repository URL, an exact commit, and a path. The whole bundle also has an integrity digest.

See the [example bundle](examples/agent-setup.bundle.yaml).

## Development

For contributors only:

```sh
git clone https://github.com/GaganChaudhary6378/rigdrop.git
cd rigdrop
npm link
rigdrop doctor
```

```sh
npm test
npm run check
```

Create a D1 database and apply the Worker migration:

```sh
npx wrangler d1 create rigdrop
# Copy the returned database_id into wrangler.toml.
npx wrangler d1 execute rigdrop --remote --file=migrations/0001_bundles.sql
npx wrangler secret put PASSCODE_SECRET
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_PUBLISHABLE_KEY
npx wrangler deploy
```

Set `AGENT_SETUP_REGISTRY_URL` to the deployed Worker URL before using the CLI, or pass it to `rigdrop login --registry URL`. `PASSCODE_SECRET` must be a long random secret and is only used to derive private-bundle passcode digests. The Supabase values remain limited to Google sign-in; bundle configs now live in D1.

Supabase Auth setup:

1. Enable the Google provider with a Google OAuth web client. The Google client's redirect URI is `https://<project-ref>.supabase.co/auth/v1/callback`.
2. Add `http://127.0.0.1:53682/callback` to Authentication → URL Configuration → Redirect URLs.

## Hosted architecture

- Cloudflare Workers serves the API and agent-readable bundle endpoints from one deployment.
- Supabase Auth identifies the publisher through Google sign-in.
- Cloudflare D1 stores immutable bundle manifests and review reports; owner IDs permit owner-only deletion.
- Public bundles expose JSON, review JSON, and Markdown from the same bundle ID. Private bundles require a passcode on every configuration endpoint.

## Project status

RigDrop began as a weekend side project for sharing a personal agent setup. It quickly became clear that the same idea could be a shared team memory: one registry for the skills, plugins, rules, and agent configuration a team relies on.

This is still an MVP for personal projects and trusted teams. It does not sync live sessions, install arbitrary binaries, or translate agent-specific plugin formats—but there is much more to come.

## License

MIT
