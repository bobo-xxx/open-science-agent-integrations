# Open Science Agent Integrations

Use Codex, Claude Code, or WorkBuddy to submit research tasks to Open Science, recover runs after a chat closes, and retrieve results and artifacts through the local SDK.

## Ask your agent to install

Send the prompt for your host in a session with terminal and file access on the computer running Open Science. GitHub provides the source. The agent builds the adapter and connects it to the SDK and service on that computer.

### Codex

> Install the Open Science plugin from https://github.com/bobo-xxx/open-science-agent-integrations. Follow this README's shared setup and Codex install steps. Reuse my Open Science configuration if it already points to the requested instance. Verify the connection and tell me how to find the skill in a new Codex chat.

### Claude Code

> Install the Open Science plugin for my Claude Code user account from https://github.com/bobo-xxx/open-science-agent-integrations. Follow this README's shared setup and Claude Code install steps. Reuse my Open Science configuration if it already points to the requested instance. Verify the connection and tell me how to invoke the skill in a new Claude Code session.

### WorkBuddy

> Install the Open Science skill from [https://github.com/bobo-xxx/open-science-agent-integrations](https://github.com/bobo-xxx/open-science-agent-integrations) for WorkBuddy.

## Shared setup

Resolve repository paths from the checkout and expand `~` to the current user's home directory.

1. Check for Node.js 22.13 or newer and an Open Science installation with the SDK on this computer.
2. Clone the repository and build the adapters. Reuse an existing checkout if appropriate and preserve its local changes.

   ```sh
   git clone https://github.com/bobo-xxx/open-science-agent-integrations.git
   cd open-science-agent-integrations
   npm run build
   ```

3. Check the configuration selected by `OPEN_SCIENCE_INTEGRATIONS_CONFIG`, or `~/.open-science-agent-integrations/config.json` by default, for the intended instance. If setup is needed, locate the SDK and profile on the user's computer. Ask which instance to use if several are available and the user has not chosen one.

   - For an installed app, use `resources/packages/open-science/index.mjs` under the installation directory.
   - For a development checkout, use `packages/open-science/index.mjs` under that checkout.
   - Use the directory containing the instance's `web-service.json` as `configRoot`. Keep installed and development instances on separate profiles.

4. When creating a configuration, copy the example and replace its placeholders with the absolute `sdkPath` and `configRoot` resolved on this computer. Set `defaultInstance` to one of the configured IDs. Run `npm run configure -- <prepared-config.json>` with that file. The command preserves an existing configuration. Edit that configuration directly for a requested update. [Windows configuration example](examples/config.windows.json)

## Host install steps

### Install in Codex

From the repository root, register the built marketplace and install its plugin. These commands use PowerShell to resolve the local path.

```powershell
codex plugin marketplace add (Resolve-Path 'dist/codex').Path
codex plugin add open-science@open-science-integrations-local
```

In a new Codex chat, check that `open-science:open-science` is available and ask it to list projects.

### Install in Claude Code

From the repository root, register the built marketplace and install the plugin for the current user.

```powershell
claude plugin marketplace add (Resolve-Path 'dist/claude-code').Path
claude plugin install open-science@open-science-integrations-local
```

In a new Claude Code session, invoke `/open-science:open-science` and ask it to list projects. To load the plugin for a single session, run this from the repository root in PowerShell.

```powershell
claude --plugin-dir (Resolve-Path 'dist/claude-code/plugins/open-science').Path
```

### Install in WorkBuddy

Use your terminal and file tools in local mode to complete shared setup and install the skill.

1. Deploy the contents of `dist/workbuddy/open-science` to `~/.workbuddy/skills/open-science`. Place `SKILL.md`, `scripts`, and `references` directly under the destination. If those files already match the build, reuse the existing copy. [WorkBuddy skill directory](https://skillhub.cn/install/skillhub.md)
2. Check the deployed files. Run the installed `scripts/runner.mjs` with `--no-start` and send `{"action":"projects"}` on stdin. Report the install location and the SDK result. If the instance is offline, ask the user to start it and retry the check.
3. To verify skill discovery, give the user this prompt to send in a new local WorkBuddy chat.

   > Use the `open-science` skill to list projects in my default Open Science instance.

If the new chat cannot find the skill, ask the user to restart WorkBuddy and retry. If directory installation is blocked or the skill still cannot be found after a restart, report the blocker, give the user the absolute path to the built `dist/workbuddy/open-science.zip`, and point them to **Skills → Add Skill → Upload Skill**. For workspace-scoped installation, deploy the skill under the active coding workspace's `.codebuddy/skills/` directory. [WorkBuddy skill import](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market) · [Workspace skills](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Project)

On Windows, WorkBuddy installed the skill into the user-level directory after a one-line request with the GitHub repository URL. The installed files matched the build, and the installed runner listed projects through the local SDK.

## Verify the Open Science connection

Start the selected Open Science instance if it is offline. From the repository root, run these read-only PowerShell probes.

```powershell
'{"action":"instances"}' | node packages/core/runner.mjs
'{"action":"health"}' | node packages/core/runner.mjs --no-start
```

Expect `ok: true` and the service's version and capabilities. Pass `--instance <id>` if the selected target differs from the default. Use `doctor` to check model and runtime readiness. Task submission requires an Open Science service with `durable-submissions` support. Listing projects in a new host chat verifies that the host loaded the skill and can use the configured instance.

## Update or remove an adapter

To update, pull from GitHub in the local checkout and rerun `npm run build`. Then apply the steps for the selected host.

| Host | Update | Remove |
| --- | --- | --- |
| Codex | Remove the plugin, then run `codex plugin add open-science@open-science-integrations-local` again. Open a new chat. | Run `codex plugin remove open-science@open-science-integrations-local`. |
| Claude Code | Run `claude plugin marketplace update open-science-integrations-local` and `claude plugin update open-science@open-science-integrations-local`. Start a new session. | Run `claude plugin uninstall open-science@open-science-integrations-local`. |
| WorkBuddy | Update the deployed skill files from the new build or replace the imported ZIP through the app. Open a new local chat. | Use **Installed skills** for an imported skill. For a directory deployment, remove the deployed skill directory. |

Keep the shared configuration and receipts when removing one adapter.

## Instance selection and task recovery

- Use `OPEN_SCIENCE_INTEGRATIONS_CONFIG` or `--config <path>` for a different shared configuration. Older single-instance configurations use the ID `default`.
- The runner saves request IDs and known Run IDs in `receipts` next to the configuration on a filesystem with hard-link support, such as NTFS. Set an absolute `stateDirectory` to store them elsewhere. Keep each instance ID bound to its original profile so receipts can recover runs after the default changes. Open Science continues an accepted task after the runner exits.
- To enable automatic startup for an instance, configure its `launch` object with an absolute `command`, an `args` array, an optional absolute `cwd`, and `preservesFocus: true`. Check that the launcher starts the intended profile and preserves the foreground window before enabling it. A configured launcher has a 60-second connection budget.
- To switch the internal Open Science agent, ask the host to read `agent-routing` and apply `switch-agent` to the selected instance. The new setting governs later tasks there. Check `doctor` before starting a test task.
- When a pending approval or question needs human action, use the session ID from the runner to find it in Open Science.

See the runner reference for request examples and recovery. Run `npm test` for regression checks. The Open Science repository is where SDK and backend development takes place. [Runner reference](skills/open-science/references/runner.md) · [Acceptance record](docs/scope.md) · [Open Science source](https://github.com/aipoch/open-science)
