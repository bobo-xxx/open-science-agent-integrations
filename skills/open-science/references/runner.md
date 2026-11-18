# SDK runner

Run `node <skill-directory>/scripts/runner.mjs [--config <absolute-path>] [--instance <id>] [--no-start]`. Send one JSON object on stdin. The runner replies with one JSON line. Connected requests return `{"ok":true,"instanceId":...,"result":...}`. Failures return `{"ok":false,"error":{"code":...,"message":...}}` with exit code 1. Submit and run errors include the supplied identifier for recovery.

On PowerShell use an object and UTF-8 input. Replace the runner path with the actual path in the installed skill.

```powershell
@{ action = 'health' } | ConvertTo-Json -Compress | node '<absolute-runner-path>'
```

For non-ASCII prompts on Windows PowerShell 5.1, set the pipe's `$OutputEncoding` to `[System.Text.UTF8Encoding]::new($false)` for the call or pipe a UTF-8 request file from a shell that preserves its bytes. Keep prompts in JSON data, outside executable command text.

Configuration is selected by `--config`, then `OPEN_SCIENCE_INTEGRATIONS_CONFIG`, then `~/.open-science-agent-integrations/config.json`. All three hosts use the same file. Use `instances` to see configured targets and the default. `--instance <id>` selects a target for that call. A verified launcher with `preservesFocus: true` may start its own offline target. Use `--no-start` for a probe that leaves offline targets stopped.

| Action | Other request fields |
| --- | --- |
| `instances` | None. Reads local configuration. |
| `receipts` | Optional `instanceId`, `projectId`, `sessionId`, `runId`, `limit` (1–100). Reads the local index. |
| `health`, `doctor`, `runtimes`, `projects`, `agent-routing` | None |
| `switch-agent` | `framework`, `expectedFramework` from `agent-routing` |
| `create-project` | `name`, optional `description` |
| `sessions` | `projectId` optional |
| `session`, `session-config`, `artifacts`, `plan` | `sessionId` |
| `project-defaults` | `projectId` |
| `submit` | `requestId`, `run` |
| `submission` | `requestId` |
| `run`, `cancel` | `runId` |
| `wait` | `runId`, optional `timeoutMs` from 1 to 25000, default 10000 |
| `respond-plan` | `sessionId`, `response` |
| `download` | `artifactId`, absolute `destination` on the local machine |

Successful submission returns a receipt. `pending` means the run is being admitted. `accepted` includes the Run ID. `failed` or `interrupted` requires inspecting the returned error and current state. A wait deadline ends local observation. Use `cancel` to stop a run at the user's request. The runner uses durable submissions, which require the `durable-submissions` service capability.

The local reservation is saved before the SDK submits the request. Reusing its ID queries the original submission. A local receipt can exist before the service returns one. If a lookup is inconclusive, keep the ID and report the uncertainty to the user. An indexed request or Run always resolves to its original target, even after the default changes. Restore the binding if the original target has changed. For a known request or Run ID without a local receipt, provide the target explicitly with `--instance`.

For calls that use a Session or artifact ID, select the instance from the preceding Run reply with `--instance <id>`. Those IDs are resolved inside that instance.

```json
{"action":"submit","requestId":"<new-uuid>","run":{"project":"<project-id>","prompt":"Summarize the project's recent results in two sentences."}}
```

`run` accepts the public SDK's `sessionId`, absolute `cwd`, `permissionProfile`, `permissionPrompts`, `turnIntent`, `skillIds`, `specialist`, `autoReviewEnabled`, `memoryEnabled`, `delegationPolicy`, `agentConfiguration`, `computeHostIds`, and `enabledComputeHostIds`. Omit overrides to use the instance's existing preferences. `permissionPrompts: "none"` rejects unresolved interactions and cannot be combined with `turnIntent: "plan-first"`.

`respond-plan` accepts `{"decision":"approved","artifactVersionId":"<version-from-plan>","expectedRevision":7}`, the same shape with `"rejected"`, or `{"feedback":"<user feedback>"}`. Read the latest plan before submitting a decision and use its exact version and revision. If a decision becomes stale, read again and surface the updated plan.

`switch-agent` writes the selected Open Science instance's saved framework. Read `agent-routing` first and use `configured.framework` as `expectedFramework`. The supported IDs are `open-science-agent`, `claude-code`, `opencode`, `codex`, `codebuddy`, and `pi`. A saved framework can still need models or runtime setup. Verify with `doctor` before a requested execution test. If SDK validation rejects a routing change, report its error and leave other settings alone.

Switches from the three adapters share an instance lock. On `routing_busy` or `routing_changed`, read the current setting before retrying. The public SDK has no atomic compare-and-set for edits performed from the Open Science interface or other clients, so the runner checks the setting again after the write.

Choose an unused destination in an existing local directory for downloads. The runner publishes the complete file at the destination and refuses to replace existing files. The destination filesystem must support hard links for this operation.
