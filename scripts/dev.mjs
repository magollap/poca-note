import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");
const children = [];

function launch(name, args, color) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`\n[dev] ${name} exited with code ${code}`);
    }
    stop(code || 0);
  });
  children.push(child);
  console.log(`[dev] ${color}${name}\x1b[0m started (pid ${child.pid})`);
  return child;
}

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

launch("api", ["server/index.js"], "\x1b[36m");
launch("web", [viteBin, "--config", "web/vite.config.js"], "\x1b[35m");
