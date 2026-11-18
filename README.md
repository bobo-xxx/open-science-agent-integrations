# Open Science Agent Integrations

Use the local Open Science SDK from an external agent to submit and continue research tasks, recover submissions, review plans, and retrieve outputs. Codex and Claude Code have local plugin packages. WorkBuddy has a skill package.

All packages carry the same skill and Node runner. The runner loads the SDK from the selected Open Science installation and connects to its authenticated local service. It needs Node.js 22.13 or later and an Open Science service that advertises `durable-submissions` for task submission.

## Configure the target instance

Copy [the Windows example](examples/config.windows.json) to a local file and fill in the absolute paths. Then run `npm run configure -- <prepared-config.json>` once. It creates `~/.open-science-agent-integrations/config.json` and preserves any existing file there. Edit the existing file to change the default or add another instance.

```json
{
  "defaultInstance": "dev",
  "instances": {
    "dev": {
      "name": "Open Science DEV",
      "sdkPath": "D:/path/to/open-science-dev/packages/open-science/index.mjs",
      "configRoot": "D:/path/to/the/dev/profile"
    }
  }
}
```

For a source development build, use `packages/open-science/index.mjs` from that checkout. For an installed app, use `resources/packages/open-science/index.mjs` from its installation directory. Point `configRoot` at the directory containing the intended instance's `web-service.json`. Use separate profiles for the development and normal installations.

All hosts read the same configuration. Use `--instance <id>` to choose an instance for the current call. Use `OPEN_SCIENCE_INTEGRATIONS_CONFIG` or `--config <path>` to use a different shared configuration file. For older single-instance config files, the runner assigns ID `default`.

The runner stores request IDs and known Run IDs in `receipts` next to that file. Use a local filesystem with hard links, such as NTFS. An optional absolute `stateDirectory` overrides this storage path. Receipts resolve to their original instance after a default change. Keep each instance ID bound to its original profile. A task accepted by Open Science continues after the runner exits. Cancellation is a separate action.

Start a target manually by default. For a launcher verified to preserve the foreground window and start the correct profile, set that instance's `launch` object to `{ "command": "C:/absolute/path/to.exe", "args": [], "preservesFocus": true }`, with optional absolute `cwd`. Set `preservesFocus` only after checking this exact launcher and profile on Windows. `windowsHide` alone hides a console and provides no guarantee about a desktop window. A configured and verified launcher can start an offline target, with a 60-second connection budget. Use `--no-start` for a probe that leaves offline targets stopped.

## Build and load

Run `npm run build` from the repository root. The build creates self-contained bundles in `dist`.

| Host | Install or load | Update and remove |
| --- | --- | --- |
| Codex | `codex plugin marketplace add <absolute-dist/codex>`, then `codex plugin add open-science@open-science-integrations-local`. Open a new chat. | Rebuild, run `codex plugin remove open-science@open-science-integrations-local`, then add the plugin again to update. Leave it removed to uninstall. |
| Claude Code | `claude --plugin-dir <absolute-dist/claude-code/plugins/open-science>` for a single session. For a user install, run `claude plugin marketplace add <absolute-dist/claude-code>` and `claude plugin install open-science@open-science-integrations-local`. | Restart a single session with the new bundle, or update the marketplace and use `claude plugin update open-science@open-science-integrations-local`. `claude plugin uninstall open-science@open-science-integrations-local` removes a marketplace install. |
| WorkBuddy | Use **Skills → Add Skill → Upload Skill** with `dist/workbuddy/open-science.zip`. For a local coding project, place the `dist/workbuddy/open-science` skill directory under `.codebuddy/skills` in the selected workspace. | Update the project skill directory, or replace the installed skill with the new ZIP through the app. Use **Installed skills** to uninstall an imported skill. |

Each host manages its own install. Keep the shared config and receipts when removing one adapter. The WorkBuddy host must run on the same PC with permission to execute Node and read the selected SDK and profile paths.

Ask the host to list Open Science projects or run a research task there. Select the skill explicitly when verifying discovery. Codex lists it under `open-science:open-science`. Use `doctor` for model and runtime readiness. The bundles call the SDK directly through Node and require a host that can execute local scripts and reach the selected service. The WorkBuddy archive follows its [skill format](https://open.workbuddy.cn/en/docs/skill).

## Verify the runner

With the app running, send a read-only request from PowerShell:

```powershell
'{"action":"instances"}' | node packages/core/runner.mjs
'{"action":"health"}' | node packages/core/runner.mjs --instance dev --no-start
```

Expect `ok: true` and the configured service's version and capabilities. Send `{"action":"projects"}` to verify that the instance has the expected projects. See the [runner reference](skills/open-science/references/runner.md) for the task, plan and artifact requests. Run `npm test` for the local regression checks.

To switch the internal agent when you need it, ask the host to read `agent-routing` and apply `switch-agent` to the selected instance. The new setting governs later tasks in that instance. Check the runtime and model with `doctor` before starting a real test task.

This integration uses public SDK capabilities. A blocked ordinary approval or question is surfaced with its session ID so the user can respond in the app. SDK and backend feature work belongs in the Open Science repository.
