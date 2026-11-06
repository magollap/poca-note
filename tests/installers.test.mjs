import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("installers and the requirements manifest are present and wired up", () => {
  for (const file of [
    "requirements.txt",
    "scripts/install.sh",
    "scripts/install.ps1",
    "scripts/install.cmd",
    "scripts/start.mjs",
    "scripts/doctor.mjs",
  ]) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} should exist`);
  }

  const requirements = fs.readFileSync(path.join(root, "requirements.txt"), "utf8");
  assert.match(requirements, /^require:node >=22\.13$/m);
  assert.match(requirements, /^require:npm >=10$/m);
  assert.match(requirements, /^npm:express /m);
  assert.match(requirements, /^npm:react /m);

  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.start, "node scripts/start.mjs");
  assert.equal(pkg.scripts.doctor, "node scripts/doctor.mjs");

  const shell = fs.readFileSync(path.join(root, "scripts/install.sh"), "utf8");
  assert.match(shell, /--install-node/);
  assert.match(shell, /npm ci/);

  const powershell = fs.readFileSync(path.join(root, "scripts/install.ps1"), "utf8");
  assert.match(powershell, /-InstallNode/);
  assert.match(powershell, /npm ci/);
});
