# CLI runner

Run `node <skill-directory>/scripts/runner.mjs [--config <absolute-path>] [--instance <id>]`. Send one UTF-8 JSON object on stdin. The runner replies with one JSON line. Connected requests include the selected `instanceId` and return `ok: true` with a `result`. Failures return `ok: false` with an `error.code` and `error.message`. The runner exits 1 on failure and preserves a CLI `exitCode` or `completionStatus` when available. Submit and Run errors include known identifiers for recovery. When a wait returns a Run, read that Run's `status` to distinguish successful research, failure, cancellation, and an active Run.

On PowerShell use an object and UTF-8 input. Replace the runner path with the actual path in the installed skill.

```powershell
@{ action = 'health' } | ConvertTo-Json -Compress | node '<absolute-runner-path>' --instance '<instance-id>'
```

For non-ASCII prompts on Windows PowerShell 5.1, set the pipe's `$OutputEncoding` to `[System.Text.UTF8Encoding]::new($false)` for the call or pipe a UTF-8 request file from a shell that preserves its bytes. Keep prompts in JSON data, outside executable command text.

Configuration is selected by `--config`, then `OPEN_SCIENCE_INTEGRATIONS_CONFIG`, then `~/.open-science-agent-integrations/config.json`. All three hosts use the same file. Use `instances` to see configured targets and the default. `--instance <id>` selects a target for that call. `health` returns `connected`, the service `version`, and `cliVersion` after verifying the selected connection. Use `doctor` and check `result.ready` for runtime and model readiness. The official CLI checks submission support when admitting a task. If the service is offline, ask the user to open that instance normally.

| Action | Other request fields |
| --- | --- |
| `instances` | None. Reads local configuration. |
| `receipts` | Optional `instanceId`, `projectId`, `sessionId`, `runId`, `limit` (1–100). Reads the local index. |
| `health`, `doctor`, `runtimes`, `projects`, `agent-routing` | None |
| `switch-agent` | `framework`, `expectedFramework` from `agent-routing` |
| `create-project` | `name`, optional `description` |
| `session`, `session-config`, `artifacts`, `plan` | `sessionId` |
| `project-defaults` | `projectId` |
| `submit` | `requestId`, `run`, optional boolean `retryIfMissing` |
| `submission` | `requestId` |
| `run`, `cancel` | `runId` |
| `wait` | `runId`, optional `timeoutMs` from 1 to 25000, default 10000 |
| `respond-plan` | `sessionId`, `response` |
| `download` | `artifactId` from the listed item's `id`, absolute `destination` on the local machine |

Initial `submit` waits for CLI admission and returns an `accepted` receipt with `runId`, `runStatus`, and the Session ID when available. A `submission` lookup can return `pending`, `accepted`, `failed`, or `interrupted`. Inspect an accepted Run by ID, and report its actual status separately from receipt status. A wait deadline ends local observation. Use `cancel` to stop a Run at the user's request.

The runner saves the local receipt before invoking the CLI, so it can exist before the service has a receipt. On a timeout or unconfirmed admission, use the same request ID to recover the service receipt. `submission` is a read-only service query. Repeating `submit` with the same ID uses the same query by default. The runner resolves an indexed request or Run from its original target even after the default changes. Restore the binding if the original target has changed. For a known request or Run ID without a local receipt, provide the target explicitly with `--instance`.

For calls that use a Session or artifact ID, pass the instance ID from the preceding Run reply. Continue a session using its ID or the Session ID from an existing Run. A title-only request requires the user to identify the Session in Open Science.

```json
{"action":"submit","requestId":"<new-uuid>","run":{"project":"<project-id>","prompt":"Summarize the project's recent results in two sentences."}}
```

The `run` object in `submit` accepts `sessionId`, absolute `cwd`, `permissionProfile`, `permissionPrompts`, `turnIntent`, `skillIds`, `specialist`, `autoReviewEnabled`, `memoryEnabled`, `delegationPolicy`, `agentConfiguration`, `computeHostIds`, and `enabledComputeHostIds`. Omit overrides to keep the current settings. An explicit `agentConfiguration.providerId` requires a model or a null model to use that provider's default. Interactive Plan First requires leaving `permissionPrompts` unset. Use the existing Session settings to change available Compute Hosts before resuming. For a new Session, pass both Compute Host arrays empty to clear both lists. To clear just one list, use the Session's Compute Host settings in Open Science. [Official 1.3.0 CLI guide](https://github.com/aipoch/open-science/blob/v1.3.0/packages/open-science/CLI.md)

`respond-plan` accepts `{"decision":"approved","artifactVersionId":"<version-from-plan>","expectedRevision":7}`, the same shape with `"rejected"`, or `{"feedback":"<user feedback>"}`. Read the latest plan before submitting a decision and use its exact version and revision. If a decision becomes stale, read again and surface the updated plan.

`switch-agent` writes the selected Open Science instance's saved framework. Read `agent-routing` first and use `configured.framework` as `expectedFramework`. Supported IDs are `open-science-agent`, `claude-code`, `opencode`, `codex`, `codebuddy`, and `pi`. Use `doctor` before execution to verify runtime and model readiness. If the CLI rejects a routing change, report its error.

Switches from the three adapters share an instance lock. The runner reads the setting after an update to check the outcome. On `routing_busy` or `routing_changed`, read the current setting before retrying.

The Open Science CLI downloads by the listed version's `id`. Some entries also have an `artifactId` that groups versions. Choose an unused destination in an existing local directory. The runner publishes the complete file at the destination and refuses to replace existing files. The destination filesystem must support hard links.

## Research Films

Film actions require a matching CLI and local service with Research Film support. The standalone service can run with the desktop app closed. Use the instance and Session of the source conversation. Choose `research-explanation` for a narrated explanation of the findings or `operation-replay` for a narrated account of recorded operations. The export is a self-contained HTML player.

Every Film action accepts `projectId`, `sessionId`, `mode`, and an optional `branchId`. When the branch is omitted, the service uses the active branch. Keep the returned `branchId` and pass it with the same `--instance` on each follow-up call.

| Action | Additional fields |
| --- | --- |
| `film-status` | None. Inspect progress, review findings, or a published player. |
| `film-start` | Optional booleans `installNarration`, `resume`, `advisoryNarrationReview`. |
| `film-revise` | `attemptId` from `reviewFailure`, `feedback`, optional boolean `advisoryNarrationReview`. |
| `film-cancel` | None. Use when the user asks to stop active generation. |
| `film-download` | `filmId` from `result.id` and an unused absolute `.html` `destination` in an existing directory. |

1. Call `film-status` to find an existing player or inspect the source branch before starting. For new generation, use `film-start`. Pass `installNarration: true` only when the user authorizes the local narration model download. Research explanation also requires Chrome, Chromium, or Edge on the service machine for headless review.
2. Poll `film-status` after start or revision. Read `progress.phase`, `error`, `preflightError`, and `reviewFailure`. A reply can include an older `result` during a newer attempt. For a newly requested film, wait for the new published result before reporting success. If a request times out, check the same branch and mode before issuing another start, revision, or cancellation.
3. On `reviewFailure`, discuss the findings with the user and pass their feedback with the current `attemptId` to `film-revise`. If a revision conflicts, read status again to identify the current failure. For a resumable interruption, use `film-start` with `resume: true` when `canResume` is true. For Research explanation, `advisoryNarrationReview: true` makes the narration score advisory when explicitly requested and retains other checks. Revision and resume can inherit the attempt's review policy.
4. Download the chosen published player with `film-download`. The runner publishes only the completed file and preserves existing destinations.

```json
{"action":"film-status","projectId":"<project-id>","sessionId":"<session-id>","mode":"research-explanation"}
```

```json
{"action":"film-download","projectId":"<project-id>","sessionId":"<session-id>","mode":"research-explanation","branchId":"<returned-branch-id>","filmId":"<result-id>","destination":"C:/path/to/research-film.html"}
```

## Retry a missing submission

When the user requests a retry, look up the original request with `submission` on its bound instance. If the CLI returns `submission_not_found`, the local task receipt has no known Run ID, and you still have the exact original request, resend that `submit` with `retryIfMissing: true`. Keep the original `requestId` and the complete `run` object, including the same project, Session, prompt, and options.

The runner requires the same CLI error code when it repeats the lookup before resending. It also verifies the original parameters against the saved request fingerprint. It returns any existing service receipt, including `accepted`, `failed`, or `interrupted`, for inspection. If it returns `retry_unverifiable` for a legacy receipt, or the lookup is inconclusive, keep the original ID and report the blocker.
