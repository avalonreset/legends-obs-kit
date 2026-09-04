import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const scratch = await mkdtemp(path.join(os.tmpdir(), "legends-obs-kit-release-"));
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmPrefix = process.platform === "win32"
  ? [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
  : [];
const tarCommand = process.platform === "win32" ? "tar.exe" : "tar";

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}

try {
  const report = JSON.parse(run(npmCommand, [...npmPrefix, "pack", root, "--json", "--ignore-scripts"], scratch));
  assert.equal(report.length, 1, "npm pack should create exactly one artifact");
  const tarball = path.join(scratch, report[0].filename);
  await mkdir(path.join(scratch, "package"));
  run(tarCommand, ["-xf", tarball], scratch);

  const packageRoot = path.join(scratch, "package");
  const packedPackage = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const manifest = JSON.parse(run(process.execPath, [path.join(packageRoot, "dist", "index.js"), "manifest"], packageRoot));
  assert.equal(manifest.name, "Legends OBS Kit");
  assert.equal(manifest.ambientMcp, false);
  assert.equal(packedPackage.version, sourcePackage.version, "packed package version must match source package.json");
  assert.equal(manifest.version, sourcePackage.version, "compiled manifest version must match package.json; rebuild dist before release");

  const skill = await readFile(path.join(packageRoot, "skills", "legends-obs-kit", "SKILL.md"), "utf8");
  assert.match(skill, /node <root>\\dist\\index\.js/);
  assert.match(skill, /lobs doctor --pretty/);

  const doctor = await readFile(path.join(packageRoot, "bin", "doctor.ps1"), "utf8");
  assert.match(doctor, /dist\\index\.js/);
  assert.doesNotMatch(doctor, /E:\\/i);

  if (process.platform === "win32") {
    const installHome = path.join(scratch, "install-home");
    await mkdir(installHome);
    const installEnv = { ...process.env, USERPROFILE: installHome, HOME: installHome };
    const installer = path.join(packageRoot, "bin", "setup-multi-agent.ps1");
    run("pwsh.exe", ["-NoProfile", "-File", installer, "-SkipDoctor"], packageRoot, installEnv);
    run("pwsh.exe", ["-NoProfile", "-File", installer, "-SkipDoctor"], packageRoot, installEnv);
  }

  console.log(JSON.stringify({
    ok: true,
    artifact: report[0].filename,
    packedFiles: report[0].entryCount,
    packedBytes: report[0].unpackedSize,
    manifestVersion: manifest.version,
  }));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
