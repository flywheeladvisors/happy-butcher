// Runs the Next.js CLI. When the project sits inside a Dropbox folder on Windows, the Dropbox
// client locks files mid-sync and Next's rebuilds of .next fail with EPERM. So .next becomes a
// junction to <same drive>:\dev-build\<project>\.next (same drive, so Turbopack's renames work),
// and NODE_PATH points back at this project's node_modules so build output can still resolve deps.
// Everywhere else (macOS, Linux, Vercel) this just runs `next`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const projectDir = process.cwd();
const nextDir = path.join(projectDir, ".next");

if (process.platform === "win32" && /[\\/]Dropbox[\\/]/i.test(projectDir)) {
  const buildDir = path.join(path.parse(projectDir).root, "dev-build", path.basename(projectDir), ".next");
  fs.mkdirSync(buildDir, { recursive: true });

  const stat = fs.lstatSync(nextDir, { throwIfNoEntry: false });
  if (stat && !stat.isSymbolicLink()) {
    const parked = `${nextDir}-stale-${Date.now()}`;
    fs.renameSync(nextDir, parked);
    console.warn(`Moved existing .next to ${path.basename(parked)} (delete it once Dropbox releases it).`);
  }
  if (!stat || !stat.isSymbolicLink()) {
    fs.symlinkSync(buildDir, nextDir, "junction");
  }

  const modules = path.join(projectDir, "node_modules");
  process.env.NODE_PATH = [modules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
}

const nextBin = path.join(projectDir, "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
