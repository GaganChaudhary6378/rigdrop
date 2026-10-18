#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { doctor, install, loadBundle, plan, publish, rollback, scan } from "./core.js";

const [command, ...rest] = process.argv.slice(2);
const input = command === "scan" || command === "doctor" ? undefined : rest[0];
const args = command === "scan" || command === "doctor" ? rest : rest.slice(1);
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = name => args.includes(name);

function summary(bundle) {
  console.log(`${bundle.metadata.title}\n${bundle.items.length} item(s), ${bundle.requiredSecrets.length} required secret(s)`);
  for (const item of bundle.items) console.log(`- ${item.kind}: ${item.name} -> ~/${item.destination} (${item.source?.kind || "config"})`);
  if (bundle.requiredSecrets.length) console.log(`Required environment variables: ${bundle.requiredSecrets.join(", ")}`);
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
    console.log(`Installed. Roll back with: agent-setup rollback ${journal.id}`);
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
  console.log("RigDrop\n\nCommands:\n  scan [--project PATH] [--out FILE] [--title NAME]\n  inspect FILE_OR_URL\n  install FILE_OR_URL [--project PATH] [--yes] [--force]\n  rollback INSTALLATION_ID [--project PATH]\n  doctor\n  publish BUNDLE_FILE [--registry URL]");
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
