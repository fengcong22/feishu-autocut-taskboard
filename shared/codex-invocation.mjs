import { accessSync, closeSync, openSync, readSync } from "node:fs";
import path from "node:path";

function windowsBash() {
  for (const candidate of [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  ]) {
    try {
      accessSync(candidate);
      return candidate;
    } catch {}
  }
  return "bash";
}

function scriptRuntime(executable) {
  if (typeof executable !== "string") return false;
  if (/\.(?:cjs|js|mjs)$/i.test(executable)) return process.execPath;
  if (path.extname(executable)) return null;

  let file;
  try {
    file = openSync(executable, "r");
    const buffer = Buffer.alloc(256);
    const bytesRead = readSync(file, buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/, 1)[0];
    if (/^#!.*\bnode(?:\.exe)?(?:\s|$)/i.test(firstLine)) return process.execPath;
    if (/^#!.*\b(?:ba)?sh(?:\.exe)?(?:\s|$)/i.test(firstLine)) return windowsBash();
    return null;
  } catch {
    return null;
  } finally {
    if (file !== undefined) closeSync(file);
  }
}

// Development and test fixtures may point at a Node script. Native Codex
// installations continue to use the executable directly.
export function codexInvocation(executable, args = [], platform = process.platform) {
  const runtime = platform === "win32" ? scriptRuntime(executable) : null;
  if (runtime) {
    return {
      command: runtime,
      args: [executable, ...args],
    };
  }
  return { command: executable, args };
}
