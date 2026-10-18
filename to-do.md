# RigDrop implementation plan

## Phase 0: Product and technical definition

- [x] Define sender and receiver journeys.
- [x] Define portable content and source rules.
- [x] Document secret handling, preview, backup, verification, and rollback.

## Phase 1: Safe local round trip

- [x] Initialize a dependency-free Node.js CLI.
- [x] Define and validate the version 1 JSON bundle.
- [x] Discover Claude Code, Codex, and shared skills, plugins, rules, and MCP definitions.
- [x] Keep GitHub content as commit-pinned references.
- [x] Embed local files with exclusions, path checks, size limits, secret checks, and checksums.
- [x] Preview changes, keep conflicts by default, back up replacements, install, and roll back.
- [x] Test capture, secret replacement, installation, rollback, and tamper rejection.

Outcome: a local bundle safely reproduces supported settings in another home directory.

## Phase 2: Public sharing

- [x] Implement the Vercel website, publishing API, and public bundle formats.
- [x] Add the Supabase schema, access grants, RLS, payload limits, and publishing-token check.
- [x] Connect CLI publishing, inspection, and installation to hosted bundle URLs.
- [x] Generate HTML, JSON, and Markdown views for each bundle.
- [x] Deploy the production Vercel site with public access.
- [x] Add one-command sharing that scans, packages, publishes, and returns a public link.
- [x] Include symlinked setup files only when they resolve inside the owning agent directory.
- [x] Keep documented placeholder credentials out of secret-scan false positives.
- [x] Report oversized local files that cannot fit the public bundle.
- [x] Exclude Claude plugin caches and marketplaces from portable plugin capture.
- [x] Support shared bundles up to 4 MB across the CLI, API, and registry.
- [x] Capture only portable text and script files; exclude work assets and build output.
- [x] Exclude agent caches, staging directories, and synced work folders from automatic sharing.
- [ ] Apply the Supabase migration and verify the production publish/read/install flow.

Outcome: a sender can share one public URL that another agent can inspect and install.

## Phase 3: Wider compatibility

- [ ] Add adapters only when a real user needs another agent or plugin format.
- [ ] Add publisher signatures if untrusted public distribution becomes necessary.
- [ ] Add live session handoff after setup portability is proven useful.

Outcome: future work follows actual compatibility requests rather than guessed integrations.
