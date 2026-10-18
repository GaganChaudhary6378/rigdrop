# Technical plan

## Design principles

- The manifest describes intent; an adapter decides the correct destination for each agent.
- Bundles contain configuration and source files, never credentials or installed binaries.
- Installation is previewed, approved, backed up, applied, and verified.
- Unknown fields or unsupported capabilities fail visibly instead of being silently ignored.
- Published bundle versions are immutable so the same link always produces the same input.

## Architecture

```text
SENDER MACHINE
  Agent adapters
    | discover skills, plugins, MCP, rules, commands, hooks
    v
  Scanner -> Normalizer -> Secret/privacy checks -> Bundle builder
                                                    |
                         GitHub items: pinned refs  |
                         Local items: payload files |
                                                    v
                                             Registry API
                                             - manifest
                                             - payload archive
                                             - checksums
                                             - public page
                                                    |
                                                    v
                                             Shareable URL
                                                    |
                                                    v
RECEIVER MACHINE
  Agent or CLI -> Fetch -> Verify -> Compatibility plan -> Dry run
                                                      |
                                             user approval + secrets
                                                      |
                                                      v
                                              Backup -> Install
                                                      |
                                                      v
                                                  Health check
```

## Main components

### 1. CLI

One executable owns scanning, packaging, inspection, installation, rollback, and health checks. The CLI keeps agent-specific behavior behind adapters.

Suggested first implementation: TypeScript on Node.js because the configuration is mostly JSON, YAML, Markdown, and filesystem operations. Package it as an npm executable. Avoid a desktop interface until the CLI flow is proven.

### 2. Agent adapters

Each adapter implements:

```text
detect()       Find whether the agent is installed.
scan()         Return normalized configuration items.
plan(bundle)   Map normalized items to receiver destinations.
install(plan)  Apply an approved plan.
verify(plan)   Confirm the installed setup can be discovered by the agent.
```

The first adapters are `claude-code` and `codex`. Paths and formats belong inside these adapters rather than inside bundle data.

### 3. Bundle builder

The builder produces:

```text
bundle/
├── manifest.yaml
├── AGENT_SETUP.md
└── payload/
    ├── skills/
    ├── plugins/
    ├── mcp/
    ├── rules/
    ├── commands/
    └── hooks/
```

`AGENT_SETUP.md` explains the bundle to an agent and points it to the supported installer command. It must not contain shell commands generated from untrusted bundle text.

### 4. Registry

The registry stores immutable manifests and payload archives. It returns a public page and raw manifest endpoint for each share identifier.

Minimal endpoints:

```text
POST   /v1/bundles                 publish manifest and payload
GET    /v1/bundles/:id             public metadata
GET    /v1/bundles/:id/manifest    normalized manifest
GET    /v1/bundles/:id/payload     payload archive
DELETE /v1/bundles/:id             delete with owner token
```

Object storage holds payloads. A small relational table holds bundle metadata, versions, checksums, size, creation time, and deletion state.

## Bundle format

The complete example is in `examples/agent-setup.bundle.yaml`.

Every configurable item uses one of two source types.

### Git source

```yaml
source:
  kind: git
  repository: https://github.com/example/tool.git
  commit: 4c2f9d0...
  path: skills/example
```

The commit is required. Branch names such as `main` are recorded only as display information because they can change.

### Embedded source

```yaml
source:
  kind: embedded
  path: payload/skills/my-local-skill
  sha256: 90b9...
```

The path must stay inside the archive. The installer checks the digest before reading or copying it.

## MCP handling

MCP definitions require special handling because they often contain credentials.

Safe fields:

- server name;
- enabled state;
- transport type: `stdio`, `http`, or `sse`;
- executable or package name;
- arguments after secret substitution;
- remote URL after removing credentials and secret query values;
- required environment-variable names;
- supported agents.

Never captured:

- environment-variable values;
- authorization headers;
- OAuth tokens;
- cookies;
- keychain entries;
- `.env` files.

Example receiver prompt:

```text
This setup requires SUPABASE_ACCESS_TOKEN.
Enter it locally or skip the Supabase MCP server.
The value will be written only to the receiving agent's supported secret store.
```

## Installation transaction

```text
fetched
  -> verified
  -> planned
  -> awaiting approval
  -> backed up
  -> installing
  -> verifying
  -> installed

Any failure after backup -> rolling back -> rolled back or rollback_failed
```

The installer writes a journal before every filesystem change. Installation must be repeatable: an unchanged item is reported as already installed rather than copied again.

Conflict choices:

- keep the receiver's version;
- install the bundle version;
- install beside the existing item with a new name;
- skip the item.

The default is keep and report. Never overwrite silently.

## Agent-facing share page

The public link should return HTML for people and expose discoverable links to:

- the raw manifest;
- `AGENT_SETUP.md`;
- checksums;
- the supported installer command;
- package contents and requested permissions.

When a user pastes the URL into an agent, the agent can read `AGENT_SETUP.md`, explain the setup, and invoke the locally installed CLI. If the CLI is missing, the page provides a reviewed installation method for the CLI itself.

## Security boundaries

### Before publishing

- Apply built-in deny patterns for credentials, keys, tokens, `.env`, browser data, and SSH material.
- Scan text files for likely secrets.
- Show every embedded filename and total upload size.
- Require explicit confirmation that embedded files will be public.
- Reject devices, sockets, files above the size limit, and escaping symlinks.

### Before installing

- Validate the manifest against its versioned schema.
- Verify archive and file checksums.
- Reject absolute paths and `..` traversal.
- Do not execute lifecycle scripts from the bundle.
- Show filesystem changes, commands, network sources, and requested secrets.
- Back up every destination that may change.

### Trust model

A public link is untrusted input. In the first version, checksums prove integrity after publishing but do not prove who authored the bundle. Publisher signatures and verified identities can follow later.

## Failure handling

| Failure | Required behavior |
|---|---|
| Git repository unavailable | Fail that item and continue only after the user chooses partial installation |
| Referenced commit missing | Mark bundle invalid; never fall back to the repository's default branch |
| Secret found during packaging | Block publishing and show the affected file without printing the secret |
| Unsupported agent capability | Mark item incompatible and explain which capability is missing |
| Existing configuration conflict | Keep receiver version by default and request a choice |
| Network interruption | Keep downloaded temporary data separate; resume or restart safely |
| Checksum mismatch | Abort before installation |
| Install failure | Use the journal to restore all changed destinations |
| Verification failure | Report the failed item and offer rollback |

## Test strategy

- Unit tests for normalization, exclusions, secret substitution, path safety, checksums, and conflict resolution.
- Adapter fixtures for Claude Code and Codex configurations.
- Integration test that packages a mixed GitHub/local setup and installs it into a temporary home directory.
- Security tests for path traversal, escaping symlinks, archive bombs, secrets, malformed manifests, and injected commands.
- End-to-end test with two isolated user environments: publish from one, install from the other, then verify both agents discover the same selected items.
- Rollback test that forces failure halfway through installation and confirms the original files are restored byte-for-byte.

## Delivery phases

### Phase 1: Local package round trip

Build the schema, scanner, bundle builder, secret checks, Claude Code adapter, Codex adapter, dry run, transactional installer, rollback, and temporary-directory tests. Bundles remain local archives.

Outcome: one machine exports a setup and a clean test environment reproduces it safely.

### Phase 2: Public sharing

Add the minimal registry, immutable public links, upload confirmation, deletion token, limits, and public inspection page.

Outcome: another person can inspect and install a public link.

### Phase 3: Agent-directed installation

Generate `AGENT_SETUP.md`, define content negotiation/discovery on the public page, and verify that Claude Code and Codex can follow the link-driven flow.

Outcome: the receiver can paste the link into either agent and complete installation with explicit approval.

### Phase 4: Quality and portability

Add diagnostics, compatibility reporting, version upgrades, Linux coverage, signed releases, documentation, and repeatable two-user browser/CLI verification.

Outcome: failures are understandable and bundles remain reproducible across supported machines.

## Decisions to settle before coding

1. Working product and CLI name.
2. Whether public bundles expire automatically or remain until deleted.
3. Maximum embedded payload size.
4. Registry hosting choice after the local round trip works.
5. Whether project-level rules may target a repository directory or only a temporary demo project in the first release.
