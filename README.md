# Open Science Agent Integrations

Use Codex, Claude Code, or WorkBuddy to submit research tasks to Open Science, recover runs after a chat closes, and retrieve results and artifacts through the official Open Science CLI.

## Ask your agent to install

Send the prompt for your host in a session with terminal and file access on the computer running Open Science. This guide uses the official Open Science 1.3.0 Windows desktop release as its baseline. [Open Science 1.3.0](https://github.com/aipoch/open-science/releases/tag/v1.3.0)

### Codex

> Install the Open Science plugin from https://github.com/bobo-xxx/open-science-agent-integrations. Follow this README's shared setup and Codex install steps. Reuse my Open Science configuration if it already points to the requested instance. Verify the connection and tell me how to find the skill in a new Codex chat.

### Claude Code

> Install the Open Science plugin for my Claude Code user account from https://github.com/bobo-xxx/open-science-agent-integrations. Follow this README's shared setup and Claude Code install steps. Reuse my Open Science configuration if it already points to the requested instance. Verify the connection and tell me how to invoke the skill in a new Claude Code session.

### WorkBuddy

> Install the Open Science skill from [https://github.com/bobo-xxx/open-science-agent-integrations](https://github.com/bobo-xxx/open-science-agent-integrations) for WorkBuddy.

## Shared setup

Resolve repository paths from the checkout and expand `~` to the current user's home directory.

1. Check for Git, Node.js 22.13 or newer, and npm. For Codex and Claude Code, confirm that `codex` or `claude`, respectively, is available and supports the plugin commands below. Use local mode in WorkBuddy.
2. Build from the requested GitHub revision, or `main` if the user gave no revision. Reuse an existing checkout only after confirming its `origin` is this GitHub repository, `git status --porcelain` is empty, and `HEAD` matches the requested revision fetched from GitHub. Otherwise use a separate checkout. Record the output of `git rev-parse HEAD` as the build's source revision. For a fresh default checkout, run these commands from a parent directory that does not already contain `open-science-agent-integrations`.

   ```sh
   git clone --branch main https://github.com/bobo-xxx/open-science-agent-integrations.git
   cd open-science-agent-integrations
   npm run build
   git rev-parse HEAD
   ```

3. Select the Open Science instance the user requested. Use the official desktop instance for a standard installation. If several instances match, ask which one to use. If the selected instance is offline, ask the user to open it through its normal desktop entry point so it uses its existing profile and credentials.

   - On Windows, set `cli.command` to the desktop installation's `resources/node-runtime/node.exe`. Put that installation's absolute `resources/backend/cli.mjs` path in `cli.args`. Resolve these paths from the matching installation and check the CLI's `--version`.
   - Use the directory containing the selected service's `web-service.json` as `configRoot`. The standard Windows installation normally uses `~/.open-science`. Each configured profile needs its own matching CLI, even when several versions are installed.

4. Check `OPEN_SCIENCE_INTEGRATIONS_CONFIG`, or `~/.open-science-agent-integrations/config.json` by default. For a new configuration, fill in the Windows example and run `npm run configure -- <prepared-config.json>`. The example sets the official instance ID and default to `installed`. If upgrading from an SDK-based configuration, follow the migration instructions below before replacing an installed adapter. [Windows configuration example](examples/config.windows.json)
5. Use the selected instance ID explicitly in probes and new-chat prompts. The examples below use `installed`. Substitute the ID you resolved if it differs.

### Migrate an existing configuration

Prepare a CLI configuration that lists the same instance IDs, profile roots, default selection, and receipt directory as the existing configuration. For a legacy single-instance configuration, use the ID `default`. Replace the old `sdkPath` and any automatic launcher settings with the matching official CLI entry for each instance. Have the user open each instance normally for validation.

```powershell
npm run configure -- --migrate <prepared-cli-config.json>
```

Migration verifies each CLI and running profile, saves a backup, and atomically replaces the shared configuration. If an instance has no matching CLI or service, report the instance and resolve it before migrating. Keep the backup path with the previous adapter packages for rollback. [Migration and acceptance plan](docs/cli-migration.md)

For the 0.2.0 to 0.3.0 update, build the packages first, then migrate the shared file and update all installed adapters in the same maintenance window. Version 0.2.0 requires the SDK configuration and 0.3.0 requires the CLI configuration.

To update one host at a time, copy the existing configuration to a new file beside it and pass the copy as the destination in `npm run configure -- --migrate <prepared-cli-config.json> <copied-config.json>`. Both files use the same receipt directory, including when the path is implicit. In upgraded hosts, pass `--config <absolute-path-to-copied-config>` on runner calls and include that path in the new-chat probe. Other hosts continue to use the original file until they are upgraded.

## Host install steps

### Install in Codex

From the repository root, register the built marketplace and install its plugin. These commands use PowerShell to resolve the local path.

```powershell
codex plugin marketplace add (Resolve-Path 'dist/codex').Path
codex plugin add open-science@open-science-integrations-local
```

Verify the Open Science connection, then give the user this prompt for a new Codex chat to verify that Codex discovers the skill. [Connection checks](#verify-the-open-science-connection)

> Use the `open-science:open-science` skill to list projects for Open Science instance `installed`. Pass `--instance installed` to the runner and report the returned `instanceId`.

### Install in Claude Code

From the repository root, register the built marketplace and install the plugin for the current user.

```powershell
claude plugin marketplace add (Resolve-Path 'dist/claude-code').Path
claude plugin install open-science@open-science-integrations-local
```

Verify the Open Science connection, then give the user this prompt for a new Claude Code session to verify that Claude Code discovers the skill. [Connection checks](#verify-the-open-science-connection)

> /open-science:open-science List projects for Open Science instance `installed`. Pass `--instance installed` to the runner and report the returned `instanceId`.

To load the plugin for a single session, run this from the repository root in PowerShell.

```powershell
claude --plugin-dir (Resolve-Path 'dist/claude-code/plugins/open-science').Path
```

### Install in WorkBuddy

Use your terminal and file tools in local mode to complete shared setup and install the skill.

1. Deploy the contents of `dist/workbuddy/open-science` to `~/.workbuddy/skills/open-science`. Place `SKILL.md`, `scripts`, and `references` directly under the destination. If those files already match the build, reuse the existing copy. [WorkBuddy skill directory](https://skillhub.cn/install/skillhub.md)
2. Check the deployed files. Verify the Open Science connection with the installed `scripts/runner.mjs` and report the install location. [Connection checks](#verify-the-open-science-connection)
3. To verify skill discovery, give the user this prompt to send in a new local WorkBuddy chat.

   > Use the `open-science` skill to list projects for Open Science instance `installed`. Pass `--instance installed` to the runner and report the returned `instanceId`.

If the new chat cannot find the skill, ask the user to restart WorkBuddy and retry. If directory installation is blocked or the skill still cannot be found after a restart, report the blocker, give the user the absolute path to the built `dist/workbuddy/open-science.zip`, and point them to **Skills → Add Skill → Upload Skill**. For workspace-scoped installation, deploy the skill under the active coding workspace's `.codebuddy/skills/` directory. [WorkBuddy skill import](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market) · [Workspace skills](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Project)

On Windows, WorkBuddy installed the skill into the user-level directory after a one-line request with the GitHub repository URL.

## Verify the Open Science connection

Run these read-only PowerShell probes from the repository root. Confirm the configured ID with `instances`, then pass it explicitly to `health` and `doctor`. For WorkBuddy, substitute the path to the deployed `scripts/runner.mjs`.

```powershell
'{"action":"instances"}' | node packages/core/runner.mjs
'{"action":"health"}' | node packages/core/runner.mjs --instance installed
'{"action":"doctor"}' | node packages/core/runner.mjs --instance installed
```

Report the built commit SHA, the returned `instanceId`, and the CLI and service versions reported by `health`. The `health` and `doctor` replies must have `ok: true` and match the selected ID. Check that `doctor.result.ready` is `true`. Confirm skill discovery separately when the host lists projects for the same ID in a new chat.

If verification fails, keep the selected instance and report the CLI error code.

- For a missing `web-service.json` or an offline service, have the user open the selected desktop instance and check its profile again. [Shared setup](#shared-setup)
- For `daemon_unreachable`, check the selected desktop instance and try again when its service is ready.
- For `incompatible_cli` or `cli_version_mismatch`, locate the CLI in the matching desktop installation and check its version.
- If authentication is rejected, confirm that `configRoot` belongs to the intended running instance and that the agent and app run under the same Windows account.

## Update or remove an adapter

To update, build the requested GitHub revision. For an SDK-based installation, choose a migration path before replacing a host package. Keep the previous packages and configuration backup together so you can restore both if an upgrade fails. [Migration steps](#migrate-an-existing-configuration)

| Host | Update | Remove |
| --- | --- | --- |
| Codex | Remove the plugin. If the local build moved, remove `open-science-integrations-local` with `codex plugin marketplace remove` and register the new `dist/codex`. Add the plugin again and open a new chat. | Run `codex plugin remove open-science@open-science-integrations-local`. |
| Claude Code | For the existing marketplace path, run `claude plugin marketplace update open-science-integrations-local` and `claude plugin update open-science@open-science-integrations-local`. If the build moved, replace the marketplace registration with the new `dist/claude-code` and install the plugin. Start a new session. | Run `claude plugin uninstall open-science@open-science-integrations-local`. |
| WorkBuddy | Update the deployed skill files from the new build or replace the imported ZIP through the app. Open a new local chat. | Use **Installed skills** for an imported skill. For a directory deployment, remove the deployed skill directory. |

Keep the shared configuration and receipts when removing one adapter.

## Instance selection and task recovery

- Use `OPEN_SCIENCE_INTEGRATIONS_CONFIG` or `--config <path>` for a different shared configuration. Older single-instance configurations use the ID `default`.
- The runner saves request IDs and known Run IDs in `receipts` next to the configuration on a filesystem with hard-link support, such as NTFS. Set an absolute `stateDirectory` to store them elsewhere. Keep each instance ID bound to its original profile so receipts can recover runs after the default changes. Open Science continues an accepted task after the runner exits.
- Continue existing sessions by Session ID or task receipt. If you have only a title, locate the session in Open Science.
- To switch the internal Open Science agent, ask the host to read `agent-routing` and apply `switch-agent` to the selected instance. The new setting governs later tasks there. Check `doctor` before starting a test task.
- When a pending approval or question needs human action, use the session ID from the runner to find it in Open Science.

See the runner reference for request examples and recovery. Run `npm test` for regression checks. [Runner reference](skills/open-science/references/runner.md) · [CLI migration](docs/cli-migration.md) · [Official CLI guide](https://github.com/aipoch/open-science/blob/v1.3.0/packages/open-science/CLI.md)
