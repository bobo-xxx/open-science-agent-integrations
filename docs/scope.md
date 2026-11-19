# First Release Acceptance Scope

This record describes the 0.2.0 release. The official CLI adapters use the [CLI migration and acceptance plan](cli-migration.md).

## Requirements

- Run acceptance tests on the user's Windows machine.
- Verify the same end-to-end flow in Codex, Claude Code, and WorkBuddy. Select a project, start or continue a session, submit a task, recover its status after a disconnect, and retrieve the response and artifacts.
- For requests that need human attention, identify the waiting session and what it needs.
- Maintain the host adapters in this repository. SDK work takes place separately in an Open Science fork.
- Each host uses the shared skill and Node runner to operate through the public SDK. Test host limitations before adding other integration methods.
- Select a default target instance during initial setup. Users can explicitly select a different instance. If the selected instance is offline, report why and keep that selection.
- Store task receipts locally so users can recover a task after closing the original chat using the target instance, request ID, and Run ID.
- Support both natural-language activation and explicit invocation. The host uses the SDK first. If the SDK lacks the required capability, report the specific gap and let the user decide whether to use the app interface.
- Allow users to enable automatic launch per instance. Launch only the selected instance, wait up to 60 seconds, and preserve foreground focus on the host. Provide manual launch instructions if the launcher cannot preserve focus.
- Share local task receipts across all three hosts. Store only the instance identifier, task IDs, and timestamps. Let the user choose when multiple receipts match. If the submission outcome is unclear, query the original receipt first.
- Configure the target instance once on Windows. Install, upgrade, and uninstall each host's adapter separately. Keep the shared instance configuration and task receipts outside the adapter installation directories so the other hosts can use them after an adapter is uninstalled.
- Include switching the internal agent of a target instance from an external host. Verify that a task submitted after the switch uses the selected framework.

## Implementation Plan

1. **Instance configuration.** Use a single local configuration file for target names, SDK paths, configuration directories, the default target, and per-target launch options. All hosts read this file. Selecting an instance for a call applies only to that call. Receipts stay bound to their original target when the default changes. If the target binding breaks, report how to fix it.
2. **Cross-host recovery.** Persist the request ID before submission and record the Run ID when it becomes available. Allow users to look up and recover the original request after closing a chat, switching hosts, or losing a submission response. The receipt index stores only lookup metadata. Prompts, credentials, research results, and artifacts stay out of the index.
3. **Launch and interaction.** Use the existing SDK to check connectivity and capabilities. Launch the selected instance only if it is offline, automatic launch is enabled, and its launcher has been verified to preserve foreground focus. Otherwise, provide manual launch instructions. Report sessions that need human attention and their visible status.
4. **Distribution and maintenance.** Reuse the shared skill, runner, and package templates for all three hosts. Document local installation, upgrades, and removal. Verify each build and its contents. Test installation through an entry point the host supports.
5. **Internal agent switching.** External hosts can query the current framework and runtime readiness. When a user explicitly requests a switch, update the selected instance through the SDK and read the setting back. Routine tasks use the current settings.

## WorkBuddy Acceptance Prerequisites

The test machine ran WorkBuddy 5.11.3 on Windows. The Open Science skill appeared under **Installed skills**. The host acceptance test checked whether WorkBuddy could launch Node locally, load the target instance's SDK, submit a task, and retrieve its result and artifacts. [Skill format](https://open.workbuddy.cn/en/docs/skill) · [Permissions and sandboxing](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Permission-Modes)

## Acceptance Steps

1. Use the isolated development build to test configuration, instance selection, version and capability checks, offline messages, and launch focus behavior. Verify that the host identifies the session and pending action when an approval is required.
2. Install each host's package. Verify natural-language activation, explicit skill invocation, and the ability to submit a real task, continue it, and retrieve its response and artifacts. Use the configured, ready internal agent for routine regression tests.
3. Submit a task from one host, then close the original chat. Verify that a new chat and another host can both find the same Run from its local receipt. Simulate a lost submission response and verify that the task is submitted only once.
4. Upgrade and uninstall an individual adapter. Verify that other hosts can still read the shared configuration and receipts.
5. Test agent switching separately. From an external host, record the current framework of the isolated development instance. Switch to another configured, ready framework and read back the setting. Submit a short task in a new session and verify the framework used and the response. Restore the original framework and read back the setting.

On November 18, 2026, the isolated development build used `deepseek-flash` as its default model. The connection check passed. The SDK's `doctor` action returned `ready: true`, and Claude Code and the model provider were both ready.

## Local Acceptance Results

- All three 0.2.0 adapter packages built successfully. All 24 regression tests passed, covering instance binding, concurrent startup, submission receipts, concurrent agent switching, and packaging.
- Codex and Claude Code passed tests with temporary local configurations. These covered installation, upgrades, skill discovery, SDK health checks, and removal. After an adapter was removed, the other packages could still read the same temporary receipt.
- All three runners were tested with the official SDK and a controlled local service. After a simulated lost submission response, another package recovered the task and the submission count was one. Artifact downloads, framework updates, and read-back checks passed.
- WorkBuddy 5.11.3 passed the live task test. WorkBuddy showed the Open Science skill and submitted a task using DeepSeek Flash. The first submission failed before creating a Run because the `claude.cmd` launcher configured for DEV was missing. After rebuilding the launcher from the existing Claude Code 2.1.327 installation, a retry with a new request ID returned a completed status and `native-workbuddy-flash.txt`. The effective model in the DEV session was `deepseek-flash`. Codex recovered the same Run from the shared receipt and used the SDK to download and verify the artifact.
- Codex passed the routine live task test. Codex used the packaged skill to submit a task in a dedicated DEV test session. The internal framework was Claude Code and the session model was `deepseek-flash`. Another packaged runner recovered the Run from the shared receipt, then used the SDK to download and verify the artifact after the task continued.
- External Claude Code passed the live host test. After switching its proxy configuration to HTTP, Claude Code 2.1.327 used `deepseek-flash[1m]` and the packaged skill to submit a real test task. A new CLI session used the same receipt to recover the original Run, read the completed result, and download and verify the artifact. The effective model in the DEV session was `deepseek-flash`. [Claude Code proxy configuration](https://code.claude.com/docs/en/network-config#proxy-configuration)
- The dedicated agent switching test passed. After switching to Open Science Agent, a short task completed using `deepseek-flash`. Server usage records matched the session configuration. During the first attempt, the framework was restored before task preparation finished and the receipt recorded a preparation failure. After a successful retry, Claude Code was restored, the default model remained `deepseek-flash`, and `doctor` returned `ready: true`.
- Version 0.2.0 was installed and enabled in the active Codex and Claude Code user configurations. A new Codex instance discovered `open-science:open-science`, and the Claude Code plugin details showed the `open-science` skill. The installed runners in both hosts defaulted to DEV and recovered the same receipt from the WorkBuddy acceptance test.
- Both targets use manual launch. Foreground focus preservation still needs to be verified for the DEV desktop launcher.
