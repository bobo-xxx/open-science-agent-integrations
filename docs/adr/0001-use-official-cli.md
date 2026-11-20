# Use the official Open-Science CLI for all external hosts

Codex, Claude Code, and WorkBuddy share a skill and runner. The runner will use the official CLI from the matching Open-Science installation for all operations, retiring the adapters' direct SDK execution path. Keeping the runner gives the three hosts one implementation for instance selection, task receipt recovery, and artifact downloads that preserve existing files.

## First release

- Use the official Open-Science 1.3.0 Windows desktop release as the baseline.
- Start new sessions or continue existing ones by Session ID or task receipt. Finding a session by title depends on an upstream CLI command to list sessions.
- When the selected instance is offline, ask the user to open that instance through its normal desktop entry point.

[Migration and acceptance plan](../cli-migration.md) · [Open-Science 1.3.0 CLI guide](https://github.com/aipoch/open-science/blob/v1.3.0/packages/open-science/CLI.md)
