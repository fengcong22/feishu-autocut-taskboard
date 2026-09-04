# DeepSeek Harness plugin

This directory is an installable DeepSeek Harness bundle. It adds a Taskboard entry to the Harness sidebar and opens the active installed Codex Taskboard runtime.

From a DeepSeek Harness source checkout, install it into the Web profile:

```sh
pnpm dsh plugin --profile web add /absolute/path/to/codex-taskboard/integrations/deepseek-harness
```

Start Codex Taskboard before opening the entry. The plugin reads the launcher-owned runtime file, so it does not depend on a fixed port.
