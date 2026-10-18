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
- [x] Require file-by-file review before upload, with one-share exclusions and dry-run support.
- [x] Align review size with the upload limit and exclude internal agent folders and MCP secrets.
- [ ] Apply the Supabase migration and verify the production publish/read/install flow (moved to Phase 2b).

Outcome: a sender can share one public URL that another agent can inspect and install.

## Phase 2b: Accounts and reviewed publishing

- [x] Add `login`, `logout`, and `whoami` with Google sign-in through Supabase Auth (PKCE loopback, session file mode 0600, automatic refresh).
- [x] Replace the shared `PUBLISH_TOKEN` with the signed-in user's token; record `owner_id` on each bundle.
- [x] Add the server review (destinations, secrets, file types, MCP entries, Git sources) and store its report.
- [x] Add owner-only `unpublish` through RLS and a limit of 20 bundles per account in 24 hours.
- [x] Show the review on the bundle page, `AGENT_SETUP.md`, and `review.json`.
- [x] Add the `rigdrop-review` skill and the `add-skill` command for Claude Code and Codex.
- [ ] Create the Google OAuth client and enable Google in Supabase Auth.
- [ ] Apply all migrations, set Vercel env vars, remove `PUBLISH_TOKEN` from Vercel, and deploy.
- [ ] Verify with two accounts: A logs in, shares, and unpublishes; B reads without login and cannot delete A's bundle.

Outcome: anyone can publish under their own account, with no shared secret in the open-source CLI.

## Phase 2c: Install sources and agent commands

- [x] Detect Claude plugin, Codex plugin, and Skills CLI install records, grouped by marketplace or repository.
- [x] Detect skills that are symlinks into one clean GitHub clone (for example gstack) and share one clone source.
- [x] Add the `source` bundle item, with strict field checks and commands built only from checked fields.
- [x] Install sources on the receiver: run `claude`/`codex`/`npx skills`, clone at the pinned commit, recreate links, and roll back clones and links.
- [x] Add `--json` and `--exclude` to `share`, and `--exclude` to `install`.
- [x] Add the `rigdrop-share` skill; update `rigdrop-review` and `add-skill`.
- [x] Test detection, unsafe sources, source install, rollback, and exclusions.
- [ ] Try a real receiver install from the deployed link (needs the Phase 2b deployment).

Outcome: on this machine the bundle has 13 install sources and 6 other items (58 KB). Before, it uploaded about 56 gstack copies and did not share plugins.

## Phase 3: Wider compatibility

- [ ] Add adapters only when a real user needs another agent or plugin format.
- [ ] Add publisher signatures if untrusted public distribution becomes necessary.
- [ ] Add live session handoff after setup portability is proven useful.

Outcome: future work follows actual compatibility requests rather than guessed integrations.
