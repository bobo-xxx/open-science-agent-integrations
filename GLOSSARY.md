# Open Science Agent Integrations

This project connects external hosts to Open Science. Work to expand the Open Science SDK takes place separately.

## Terms

**External host**

The application where a user requests an operation, such as Codex, Claude Code, or WorkBuddy.

**Open Science agent**

An agent inside Open Science that accepts and executes research tasks.

**Target instance**

The Open Science environment that an external host is operating on, such as a standard installation or an isolated development build. Each instance has its own configuration and data.

**Host adapter**

A package that lets an external host discover and use Open Science capabilities.

**Task receipt**

A local record of an Open Science task submission. It contains the target instance, request ID, Run ID when known, and timestamps, so the task can be recovered from another chat or external host.
