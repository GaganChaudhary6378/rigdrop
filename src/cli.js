#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { bundleReview, doctor, ensureBundleFits, install, loadBundle, omitBundleFiles, plan, publish, publishBundle, rollback, scan } from "./core.js";

const [command, ...rest] = process.argv.slice(2);
const noInputCommands = ["scan", "share", "doctor"];
const input = noInputCommands.includes(command) ? undefined : rest[0];
const args = noInputCommands.includes(command) ? rest : rest.slice(1);
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = name => args.includes(name);

function summary(bundle) {
  console.log(`${bundle.metadata.title}\n${bundle.items.length} item(s), ${bundle.requiredSecrets.length} required secret(s)`);
  for (const item of bundle.items) console.log(`- ${item.kind}: ${item.name} -> ~/${item.destination} (${item.source?.kind || "config"})`);
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
    let bundle = await scan({
      project: value("--project"),
      title: value("--title")
    });
    summary(bundle);
    let review = printReview(bundle);
    ensureBundleFits(bundle);
    if (has("--dry-run")) {
      console.log("\nDry run complete. Nothing uploaded.");
      return;
    }
    if (!has("--yes")) {
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
    const page = await publishBundle(bundle, { registry: value("--registry"), token: process.env.AGENT_SETUP_PUBLISH_TOKEN });
    console.log(`\nShared setup: ${page}`);
    console.log(`Paste this link into an agent: ${page}/AGENT_SETUP.md`);
    return;
  }
  if (command === "inspect") {
    summary(await loadBundle(input));
    return;
  }
  if (command === "install") {
    const bundle = await loadBundle(input);
    summary(bundle);
    console.log("\nPlan:");
    for (const item of plan(bundle, homedir(), value("--project"))) console.log(`- ${item.absoluteDestination}`);
    if (!has("--yes")) {
      console.log("\nPreview only. Run again with --yes to install.");
      return;
    }
    const journal = await install(bundle, { project: value("--project"), force: has("--force") });
    console.log(`Installed. Roll back with: rigdrop rollback ${journal.id}`);
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
    console.log(await publish(input, { registry: value("--registry"), token: process.env.AGENT_SETUP_PUBLISH_TOKEN }));
    return;
  }
  console.log("RigDrop\n\nCommands:\n  share [--project PATH] [--title NAME] [--registry URL] [--yes] [--dry-run]\n  scan [--project PATH] [--out FILE] [--title NAME]\n  inspect FILE_OR_URL\n  install FILE_OR_URL [--project PATH] [--yes] [--force]\n  rollback INSTALLATION_ID [--project PATH]\n  doctor\n  publish BUNDLE_FILE [--registry URL]");
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
