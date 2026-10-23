#!/usr/bin/env node
import { cp, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentSession, DEFAULT_REGISTRY, login, logout, readSession } from "./auth.js";
import { bundleReview, doctor, embeddedFiles, ensureBundleFits, excludeFromBundle, install, loadBundle, omitBundleFiles, plan, publish, publishBundle, rollback, scan, unpublish } from "./core.js";
import { commandText, sourceCommands, sourceCount } from "./sources.js";

const [command, ...rest] = process.argv.slice(2);
const noInputCommands = ["scan", "share", "doctor", "login", "logout", "whoami", "add-skill"];
const input = noInputCommands.includes(command) ? undefined : rest[0];
const args = noInputCommands.includes(command) ? rest : rest.slice(1);
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = name => args.includes(name);
const values = name => args.flatMap((arg, index) => arg === name && args[index + 1] ? args[index + 1].split(",").map(part => part.trim()).filter(Boolean) : []);
const json = has("--json");
const passcode = () => value("--passcode");

function summary(bundle) {
  console.log(`${bundle.metadata.title}\n${bundle.items.length} item(s), ${bundle.requiredSecrets.length} required secret(s)`);
  for (const item of bundle.items) {
    if (item.kind === "source") console.log(`- source: ${item.name} (${item.source.kind}, ${sourceCount(item.source)} item(s)) [${item.id}]`);
    else console.log(`- ${item.kind}: ${item.name} -> ~/${item.destination} (${item.source?.kind || "config"}) [${item.id}]`);
  }
  if (bundle.requiredSecrets.length) console.log(`Required environment variables: ${bundle.requiredSecrets.join(", ")}`);
  const skipped = bundle.items.flatMap(item => (item.source?.skipped || []).map(file => `${item.name}/${file.path}`));
  if (skipped.length) console.log(`Skipped ${skipped.length} non-portable or oversized file(s): ${skipped.join(", ")}`);
}

const formatBytes = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
const printReview = bundle => {
  const review = bundleReview(bundle);
  console.log("\nFiles to upload:");
  review.files.forEach((file, index) => console.log(`${index + 1}. ${file.path} (${formatBytes(file.bytes)})`));
  console.log(`\n${review.files.length} file(s), ${formatBytes(review.bundleBytes)} total upload`);
  if (review.sources.length) {
    console.log("\nInstall sources (only names and install commands are uploaded):");
    for (const source of review.sources) console.log(`- ${source.name} (${source.kind}): ${source.names.length ? source.names.join(", ") : `${source.count} skill paths`} [${source.id}]`);
  }
  if (review.notes.length) {
    console.log("\nNot shared:");
    for (const note of review.notes) console.log(`- ${note}`);
  }
  if (review.references.length) {
    console.log("\nGit references (not uploaded):");
    for (const reference of review.references) console.log(`- ${reference.path} <- ${reference.repository}@${reference.commit.slice(0, 12)}:${reference.sourcePath}`);
  }
  if (review.skipped.length) {
    console.log("\nExcluded during scan:");
    for (const file of review.skipped) console.log(`- ${file.path} (${file.reason})`);
  }
  return review;
};

function selectedNumbers(answer, files) {
  const indexes = new Set();
  for (const part of answer.split(",").map(value => value.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!range) throw new Error("Use file numbers such as 2,5-8");
    const start = Number(range[1]);
    const end = Number(range[2] || range[1]);
    if (start < 1 || end < start || end > files.length) throw new Error("Selected file number is outside the review list");
    for (let index = start; index <= end; index += 1) indexes.add(index - 1);
  }
  return [...indexes].map(index => files[index].path);
}

async function main() {
  if (command === "scan") {
    const out = value("--out") || "agent-setup.bundle.json";
    const bundle = await scan({ project: value("--project"), title: value("--title") });
    await writeFile(out, `${JSON.stringify(bundle, null, 2)}\n`);
    summary(bundle);
    console.log(`Wrote ${out}`);
    return;
  }
  if (command === "share") {
    let bundle = excludeFromBundle(await scan({
      project: value("--project"),
      title: value("--title")
    }), values("--exclude"));
    ensureBundleFits(bundle);
    let review;
    if (json) review = bundleReview(bundle);
    else {
      summary(bundle);
      review = printReview(bundle);
    }
    if (has("--dry-run")) {
      if (json) console.log(JSON.stringify({ title: bundle.metadata.title, items: bundle.items.map(({ id, kind, name, agent }) => ({ id, kind, name, agent })), ...review }, null, 2));
      else console.log("\nDry run complete. Nothing uploaded.");
      return;
    }
    const session = await currentSession({ registry: value("--registry") });
    if (!json) console.log(`\nPublishing as ${session.email} to ${session.registry}`);
    if (!has("--yes")) {
      if (json) throw new Error("Use --yes with --json, after the user approves the dry-run list");
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        for (;;) {
          const answer = (await prompt.question(`\nUpload ${review.files.length} files (${formatBytes(review.bundleBytes)})? [y/N/e] `)).trim().toLowerCase();
          if (answer === "y" || answer === "yes") break;
          if (answer === "e") {
            const selected = await prompt.question("Remove file numbers for this share (for example 2,5-8), or press Enter to return: ");
            if (selected.trim()) bundle = omitBundleFiles(bundle, selectedNumbers(selected, review.files));
            review = printReview(bundle);
            ensureBundleFits(bundle);
            continue;
          }
          console.log("Upload cancelled. Nothing uploaded.");
          return;
        }
      } finally {
        prompt.close();
      }
    }
    let access = has("--private") ? "private" : "public";
    let privatePasscode = passcode();
    if (!has("--yes")) {
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        const selected = (await prompt.question("Share publicly (no password) or privately (passcode required)? [public/private] ")).trim().toLowerCase();
        access = selected === "private" ? "private" : "public";
        if (access === "private" && !privatePasscode) privatePasscode = await prompt.question("Passcode for teammates: ");
      } finally { prompt.close(); }
    }
    if (access === "private" && !privatePasscode) throw new Error("Use --passcode PASSWORD with --private and --yes");
    const page = await publishBundle(bundle, { registry: session.registry, token: session.accessToken, access, passcode: privatePasscode });
    if (json) {
      console.log(JSON.stringify({ page, instructions: `${page}/AGENT_SETUP.md`, publisher: session.email }));
      return;
    }
    console.log(`\nShared setup: ${page}`);
    console.log(`Paste this link into an agent: ${page}/AGENT_SETUP.md`);
    return;
  }
  if (command === "inspect") {
    const bundle = await loadBundle(input, { passcode: passcode() });
    summary(bundle);
    if (/^https?:/.test(input)) {
      const response = await fetch(`${input.replace(/\/(?:manifest\.json)?$/, "")}/review.json`, { headers: passcode() ? { "X-RigDrop-Passcode": passcode() } : {} });
      const review = response.ok ? await response.json() : { status: "unavailable" };
      console.log(`\nServer review: ${review.status}`);
      for (const warning of review.warnings || []) console.log(`- ${warning}`);
    }
    if (has("--files")) for (const { path, content } of embeddedFiles(bundle)) console.log(`\n===== ${path} =====\n${content.toString("utf8")}`);
    return;
  }
  if (command === "install") {
    const bundle = await loadBundle(input, { passcode: passcode() });
    summary(bundle);
    const exclude = values("--exclude");
    console.log("\nPlan:");
    for (const item of plan(bundle, homedir(), value("--project")).filter(item => !exclude.includes(item.id))) {
      if (item.kind !== "source") console.log(`- ${item.absoluteDestination}`);
      else if (item.source.kind === "git-clone") console.log(`- clone ${item.source.repository} into ${item.absoluteDestination}, then link ${item.source.links.length} skill paths`);
      else for (const command of sourceCommands(item)) console.log(`- run: ${commandText(command)}`);
    }
    if (!has("--yes")) {
      console.log("\nPreview only. Run again with --yes to install. Skip an item with --exclude ITEM_ID.");
      return;
    }
    const journal = await install(bundle, { project: value("--project"), force: has("--force"), exclude });
    for (const change of journal.changes.filter(change => change.command && change.status !== "ran")) console.log(`- ${change.status}: ${change.command}`);
    for (const item of bundle.items.filter(item => item.source?.kind === "git-clone" && item.source.setup && !exclude.includes(item.id))) {
      console.log(`Finish ${item.name}: cd ~/${item.source.path} && ./setup`);
    }
    console.log(`Installed. Roll back with: rigdrop rollback ${journal.id}`);
    if (journal.changes.some(change => change.command)) console.log("Rollback does not remove plugins or skills that claude, codex, or npx skills installed.");
    return;
  }
  if (command === "rollback") {
    await rollback(input, homedir(), value("--project"));
    console.log(`Rolled back ${input}`);
    return;
  }
  if (command === "doctor") {
    console.log(`Home: ${homedir()}`);
    for (const result of await doctor()) console.log(`${result.found ? "found" : "missing"}: ~/${result.path}`);
    return;
  }
  if (command === "publish") {
    const session = await currentSession({ registry: value("--registry") });
    console.log(await publish(input, { registry: session.registry, token: session.accessToken, access: has("--private") ? "private" : "public", passcode: passcode() }));
    return;
  }
  if (command === "unpublish") {
    const session = await currentSession();
    console.log(`Unpublished ${await unpublish(input, { registry: session.registry, token: session.accessToken })}`);
    return;
  }
  if (command === "login") {
    const session = await login({ registry: value("--registry") || DEFAULT_REGISTRY });
    console.log(`Signed in as ${session.email} to ${session.registry}`);
    return;
  }
  if (command === "logout") {
    console.log(await logout() ? "Signed out." : "Not signed in.");
    return;
  }
  if (command === "whoami") {
    const session = await readSession();
    console.log(session ? `${session.email} (${session.registry})` : "Not signed in. Run rigdrop login.");
    return;
  }
  if (command === "add-skill") {
    for (const name of ["rigdrop"]) {
      const source = join(dirname(fileURLToPath(import.meta.url)), "../skills", name);
      for (const root of [".claude/skills", ".codex/skills"]) {
        const target = join(homedir(), root, name);
        await mkdir(target, { recursive: true });
        await cp(source, target, { recursive: true });
        console.log(`Installed ${target}`);
      }
    }
    return;
  }
  console.log("RigDrop\n\nCommands:\n  login [--registry URL]\n  logout\n  whoami\n  share [--project PATH] [--title NAME] [--registry URL] [--exclude ID_OR_NAME_OR_PATH] [--private --passcode PASSWORD] [--yes] [--dry-run] [--json]\n  scan [--project PATH] [--out FILE] [--title NAME]\n  inspect FILE_OR_URL [--passcode PASSWORD] [--files]\n  install FILE_OR_URL [--passcode PASSWORD] [--project PATH] [--exclude ITEM_ID] [--yes] [--force]\n  rollback INSTALLATION_ID [--project PATH]\n  publish BUNDLE_FILE [--registry URL] [--private --passcode PASSWORD]\n  unpublish BUNDLE_URL\n  add-skill\n  doctor");
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
