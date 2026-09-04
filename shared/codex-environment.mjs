export function withoutTaskboardLauncherEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => {
      const normalizedName = name.toUpperCase();
      return !normalizedName.startsWith("CODEX_TASKBOARD_")
        && normalizedName !== "CODEX_FEISHU_BRIDGE_SECRET";
    }),
  );
}
