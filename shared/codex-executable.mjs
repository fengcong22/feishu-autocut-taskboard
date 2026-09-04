import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

function executableFile(candidate, fileExists = null) {
  if (fileExists) return fileExists(candidate) ? candidate : null;
  try {
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

function executableOnPath(env, platform = process.platform, fileExists = null) {
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    if (platform === "win32") {
      const nativeExecutable = executableFile(path.join(directory, "codex.exe"), fileExists);
      if (nativeExecutable) return nativeExecutable;

      const npmEntry = executableFile(path.join(
        directory,
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      ), fileExists);
      if (npmEntry) return npmEntry;
      continue;
    }
    const executable = executableFile(path.join(directory, "codex"), fileExists);
    if (executable) return executable;
  }
  return null;
}

function windowsNpmVendorExecutable(env, fileExists, arch, homeDirectory) {
  const appData = env.APPDATA || path.join(homeDirectory, "AppData", "Roaming");
  const root = path.join(
    appData,
    "npm",
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
  );
  const target = arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
  const triple = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  return executableFile(path.join(root, target, "vendor", triple, "bin", "codex.exe"), fileExists);
}

export function codexExecutableInApp(appPath, platform = process.platform) {
  if (platform === "win32") {
    return path.win32.join(path.win32.dirname(appPath), "resources", "codex.exe");
  }
  if (platform === "linux") return "/usr/lib/chatgpt/resources/codex";
  return path.join(appPath, "Contents", "Resources", "codex");
}

export function resolveCodexExecutable({
  explicit = process.env.CODEX_EXECUTABLE,
  appPath,
  env = process.env,
  platform = process.platform,
  homeDirectory = os.homedir(),
  arch = process.arch,
  fileExists,
} = {}) {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();

  if (appPath) {
    const bundled = executableFile(codexExecutableInApp(appPath, platform));
    if (bundled) return bundled;
  }

  const installedCli = platform === "win32"
    ? executableOnPath(env, platform, fileExists)
      ?? windowsNpmVendorExecutable(env, fileExists, arch, homeDirectory)
    : executableOnPath(env, platform, fileExists);
  if (installedCli) return installedCli;

  if (platform === "darwin") {
    for (const applicationDirectory of ["/Applications", path.join(homeDirectory, "Applications")]) {
      for (const applicationName of ["ChatGPT.app", "Codex.app"]) {
        const bundled = executableFile(codexExecutableInApp(
          path.join(applicationDirectory, applicationName),
          platform,
        ));
        if (bundled) return bundled;
      }
    }
  }

  return "codex";
}
