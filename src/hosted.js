const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
})[character]);

export function bundleUrls(origin, slug) {
  const page = `${origin.replace(/\/$/, "")}/s/${slug}`;
  return { page, manifest: `${page}/manifest.json`, review: `${page}/review.json`, instructions: `${page}/AGENT_SETUP.md` };
}

const reviewOf = row => row.review || { status: "not reviewed", warnings: [] };

export function renderInstructions(row, origin) {
  const urls = bundleUrls(origin, row.slug);
  const review = reviewOf(row);
  const notes = review.warnings.length ? review.warnings.map(warning => `- ${warning}`).join("\n") : "- None";
  return `# ${row.title}\n\nThis is a RigDrop bundle. Inspect it before applying changes.\n\n## Server review\n\nStatus: ${review.status}\n\nItems to check before installation:\n\n${notes}\n\n## Inspect\n\n\`\`\`sh\nnpx --yes github:GaganChaudhary6378/rigdrop inspect ${urls.page}\n\`\`\`\n\n## Install\n\n\`\`\`sh\nnpx --yes github:GaganChaudhary6378/rigdrop install ${urls.page} --yes\n\`\`\`\n\n- Raw manifest: ${urls.manifest}\n- Review report: ${urls.review}\n- SHA-256: ${row.checksum}\n- Required secret values are supplied separately on the receiving machine.\n`;
}

export function renderBundlePage(row, origin) {
  const bundle = row.manifest;
  const urls = bundleUrls(origin, row.slug);
  const items = bundle.items.map(item => `<li><strong>${escapeHtml(item.kind)}</strong><span>${escapeHtml(item.name)}</span><code>${escapeHtml(item.agent)}</code></li>`).join("");
  const review = reviewOf(row);
  const notes = review.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join("");
  const secrets = bundle.requiredSecrets.length
    ? bundle.requiredSecrets.map(secret => `<code>${escapeHtml(secret)}</code>`).join(" ")
    : "None";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(row.title)} · RigDrop</title>
  <meta name="description" content="Inspect and install a shared AI agent setup.">
  <link rel="alternate" type="application/json" href="${urls.manifest}">
  <link rel="alternate" type="text/markdown" href="${urls.instructions}">
  <link rel="stylesheet" href="/style.css">
</head>
<body><main>
  <a class="brand" href="/">RigDrop</a>
  <p class="eyebrow">PUBLIC SETUP BUNDLE</p>
  <h1>${escapeHtml(row.title)}</h1>
  <p class="lede">Review this setup before adding it to Claude Code or Codex.</p>
  <section class="stats"><div><b>${bundle.items.length}</b><span>items</span></div><div><b>${bundle.requiredSecrets.length}</b><span>secrets required</span></div></section>
  <section><h2>Included setup</h2><ul class="items">${items || "<li>No items</li>"}</ul></section>
  <section><h2>Server review</h2><p>Status: <strong>${escapeHtml(review.status)}</strong></p>${notes ? `<p>Check these items before installation:</p><ul>${notes}</ul>` : ""}</section>
  <section><h2>Required environment variables</h2><p>${secrets}</p><p class="muted">Names are shared. Values never enter the bundle.</p></section>
  <section><h2>Use with an agent</h2><pre><code>npx --yes github:GaganChaudhary6378/rigdrop inspect ${urls.page}\nnpx --yes github:GaganChaudhary6378/rigdrop install ${urls.page} --yes</code></pre></section>
  <section class="links"><a href="${urls.manifest}">Raw manifest</a><a href="${urls.review}">Review report</a><a href="${urls.instructions}">Agent instructions</a></section>
  <footer>SHA-256 <code>${escapeHtml(row.checksum)}</code></footer>
</main></body></html>`;
}
