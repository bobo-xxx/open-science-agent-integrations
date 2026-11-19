# Migrate the host adapters to the official CLI

The first CLI release targets Open Science 1.3.0 on Windows. Codex, Claude Code, and WorkBuddy keep their existing installation entry points and use the same skill and runner. The runner sends every Open Science operation to the official CLI. [Architecture decision](adr/0001-use-official-cli.md)

## Select the target and migrate configuration

- Record the matching CLI launch command and arguments for each target instance. On Windows, the desktop installation supplies a Node executable and the CLI entry point. Verify the CLI version and check the selected service version with `status --json`. A working command on PATH can belong to a different Open Science release.
- Pass the selected target's `configRoot` as `--config-root` on each service command. Report the selected instance ID in the runner's response. When its service is offline, ask the user to open that desktop instance normally and repeat the check.
- Validate the replacement configuration, keep a backup, and replace the shared file atomically. Keep instance IDs, profile roots, the default selection, and the receipt directory. When an existing target lacks a matching CLI, ask for its launcher or an explicit target decision before changing the configuration. New configurations default to the official desktop instance.
- Keep SDK configuration fields available only to the migration step. The upgraded adapters use the CLI configuration during operation. Coordinate the cutover across installed hosts or migrate a separate configuration copy for upgraded hosts while sharing the receipt directory. Rollback uses the saved configuration and previous adapter package. [Migration steps](../README.md#migrate-an-existing-configuration)

## Map the shared runner to CLI operations

Invoke the CLI with an argument array and use UTF-8 stdin for task prompts. Read machine-readable JSON and preserve CLI error codes, request IDs, and Run IDs. Use `status --json` for the running state and service version and `doctor --json` for runtime and model readiness. The CLI enforces submission support when it admits a task.

| Operation | CLI path |
| --- | --- |
| Find or create a project | `project list` or `project create` |
| Submit a task | `run --request-id <id>` with the selected project and optional Session ID |
| Inspect, wait for, or stop a task | `run status`, `run wait`, or `run cancel` |
| Inspect a session | `session status <id>` and `session config show <id>` |
| Review a Plan First result | `plan show`, followed by the user-authorized `plan approve`, `plan reject`, or `plan revise` with the required version and revision where applicable |
| Retrieve artifacts | `artifacts list` and `artifacts download` |
| Inspect or change the internal agent | `settings agent-routing show` or `settings agent-routing update --framework`, with `runtime list` and `doctor` for readiness |

Use the current settings for ordinary tasks. Map explicit task options to their documented CLI flags and report unsupported requests. Continue a session using a Session ID or an existing task receipt. If the user supplies only a title, ask them to identify the session in Open Science. [Open Science 1.3.0 CLI guide](https://github.com/aipoch/open-science/blob/v1.3.0/packages/open-science/CLI.md)

Keep the available and selected Compute Host lists distinct. The 1.3.0 CLI's `--clear-compute-hosts` clears both lists for a new Session. If the user asks to deselect the current Session's compute hosts while keeping its available hosts, report the CLI limitation and direct the user to that Session in Open Science.

On a bounded `run wait`, use `--return-on-attention` to surface Plan attention even while the Run is active. When the Run is still active without Plan attention, inspect its Session and identify any pending approval or question. Direct the user to that session in Desktop or Web when their action is needed. Download artifacts to a staging path and publish to the requested destination only when it is unused. Keep the shared lock and setting read-back for explicit internal-agent switches.

## Preserve task recovery

Persist the request ID with its target and project before invoking the CLI, then record the Run ID when known. The CLI waits for admission on `run`. Use the CLI's admission deadline or a local subprocess deadline, then look up the request if the deadline expires. Existing receipts resolve to their original target after the migration or a change of default. Use `run status --request-id <id>` to recover a submission after the CLI exits or the host loses the response.

Retry only when the user requests it, a lookup on the original instance returns the exact CLI error `submission_not_found`, the receipt has no known Run ID, and the full original request is available. The runner verifies the task parameters against the fingerprint saved with the receipt. Legacy receipts without a fingerprint support lookup and recovery. An existing service receipt or an uncertain lookup leads to a status report. The runner stores lookup metadata and a request fingerprint. Prompts, credentials, and results stay with their existing owners.

## Rollout and acceptance

1. Implement the CLI execution path in the existing shared runner and update the three packages, README, and skill instructions. Remove the direct SDK operation path from the new bundles.
2. Test migration with an existing shared configuration, a nondefault target, and legacy receipts. Verify the selected configuration and the source CLI version. Cover request loss before admission, response loss after admission, cross-host recovery, ordinary Session waiting states, collision-safe artifact downloads, and the selected-only Compute Host request.
3. Install and discover the new package in each real host. Run a short Flash task against the official desktop instance and use the skill to submit it, read the result, and download an artifact. Exercise one Session ID continuation and one cross-host recovery. Verify an explicit internal-agent switch in a separate short Flash task, then restore the original setting.
4. Verify that updating or removing one host adapter preserves the shared configuration and receipts. Release the CLI adapters after the real-host and automated checks pass.
