/**
 * npm run dev — runs `next dev` and the openings watcher side by side
 * (a tiny runner instead of a `concurrently` dependency). `predev` has
 * already done a one-shot build. Ctrl-C stops both.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { ROOT } from "./fsutil";

const nextArgs = process.argv.slice(2);
const children: ChildProcess[] = [];

// Start the watcher first and only start next once it is watching, so an
// edit made right after the server is up is never missed.
const watcher = spawn(process.execPath, ["--import", "tsx", "scripts/openings/watch.ts"], {
  cwd: ROOT,
  stdio: ["inherit", "inherit", "inherit", "ipc"],
});
children.push(watcher);
let nextStarted = false;
const startNext = () => {
  if (nextStarted) return;
  nextStarted = true;
  const next = spawn("npx", ["next", "dev", ...nextArgs], { cwd: ROOT, stdio: "inherit" });
  children.push(next);
  next.on("exit", (code) => stop(code ?? 0));
};
watcher.on("message", (m) => m === "ready" && startNext());
setTimeout(startNext, 15_000); // never block dev on a slow watcher

let exiting = false;
const stop = (code: number) => {
  if (exiting) return;
  exiting = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
};
watcher.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
