import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const required = [
  "dist",
  "bin",
  "docs",
  "presets/hdr-4k60-av1-balanced.json",
  "presets/hdr-4k60-av1-hybrid-mp4.json",
  "skills",
  "AGENTS.md",
  "CHANGELOG.md",
  "CLAUDE.md",
  "CODEX.md",
  "CONTRIBUTING.md",
  "GEMINI.md",
  "GROK.md",
  "LEGENDS.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
];
for (const entry of required) assert(packageJson.files.includes(entry), `package files missing ${entry}`);
for (const forbidden of [".legends-obs-kit", "node_modules", ".env"]) {
  assert(!packageJson.files.includes(forbidden), `package files must exclude ${forbidden}`);
}
assert.equal(packageJson.bin["legends-obs-kit"], "./dist/index.js");
assert.notEqual(packageJson.private, true, "public release package must not be private");
assert.equal(packageJson.license, "MIT");
assert.equal(packageJson.repository?.url, "git+https://github.com/avalonreset/legends-obs-kit.git");

const skillText = await readFile(path.join(root, "skills", "legends-obs-kit", "SKILL.md"), "utf8");
assert.match(skillText, /^---\r?\nname: legends-obs-kit\r?\ndescription: .+\r?\n---/s, "SKILL.md needs valid name and description frontmatter");

const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmPrefix = process.platform === "win32"
  ? [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
  : [];
const packResult = spawnSync(npmCommand, [...npmPrefix, "pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
});
assert.equal(packResult.status, 0, `npm pack --dry-run failed: ${packResult.error?.message || packResult.stderr || packResult.stdout}`);
const packReport = JSON.parse(packResult.stdout);
assert.equal(packReport.length, 1, "npm pack should describe exactly one package");
const packedFiles = packReport[0].files.map((entry) => String(entry.path).replaceAll("\\", "/"));
for (const forbidden of ["node_modules/", ".legends-obs-kit/", ".codex-tmp/", ".env", "scripts/fix-nvenc", "scripts/wire-kick"]) {
  assert(!packedFiles.some((file) => file === forbidden || file.startsWith(forbidden)), `packed artifact contains forbidden path: ${forbidden}`);
}
for (const requiredFile of ["dist/index.js", "presets/hdr-4k60-av1-balanced.json", "presets/hdr-4k60-av1-hybrid-mp4.json", "skills/legends-obs-kit/SKILL.md", "bin/setup-multi-agent.ps1", "LICENSE", "README.md"]) {
  assert(packedFiles.includes(requiredFile), `packed artifact missing ${requiredFile}`);
}

async function textFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await textFiles(target));
    else if (/\.(?:md|json|ya?ml|js|ts|ps1)$/i.test(entry.name)) files.push(target);
  }
  return files;
}

const publicRoots = ["bin", "dist", "docs", "presets", "skills", "src", "test"].map((entry) => path.join(root, entry));
const publicFiles = [
  path.join(root, "AGENTS.md"),
  path.join(root, "CHANGELOG.md"),
  path.join(root, "CLAUDE.md"),
  path.join(root, "CODEX.md"),
  path.join(root, "CONTRIBUTING.md"),
  path.join(root, "GEMINI.md"),
  path.join(root, "GROK.md"),
  path.join(root, "LEGENDS.md"),
  path.join(root, "NEXT.md"),
  path.join(root, "README.md"),
  path.join(root, "SECURITY.md"),
];
for (const directory of publicRoots) publicFiles.push(...await textFiles(directory));

const privateMarkers = [
  /C:\\Users\\rccol/i,
  /E:\\empire/i,
  /E:\\legends-/i,
  /\bBenjamin\b/i,
  /\bNERV\b/i,
  /\bHADES\b/i,
  /\bHISENSE\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\b(?:xox[bparse]|xapp)-[A-Za-z0-9-]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];
for (const file of publicFiles) {
  const text = await readFile(file, "utf8");
  for (const marker of privateMarkers) {
    assert(!marker.test(text), `public file contains a private or secret marker: ${path.relative(root, file)} (${marker})`);
  }
}

console.log(JSON.stringify({
  ok: true,
  name: packageJson.name,
  version: packageJson.version,
  required,
  scannedFiles: publicFiles.length,
  packedFiles: packedFiles.length,
  packedBytes: packReport[0].unpackedSize,
}));
