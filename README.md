# AgentTrace

AgentTrace is a TikTok Tech Jam Track 1 Glass Box extension built on top of the Volc Agent Launchpad starter kit. It adds backend trace recording, audit-friendly run history, runtime step correlation, and secret redaction so judges can inspect what an agent actually did while a task was running.

## Selected Track

`Glass Box: trace and audit`

This project intentionally does not implement Kill Switch policy enforcement in v1. The focus is traceability, failure diagnosis, and safe demo output.

## What AgentTrace Adds

- Correlated run timeline stored in the backend
- Deterministic per-run diagnosis with evidence linking and suggested next action
- Run lifecycle events from queue to terminal state
- Runtime steps for commands, file changes, tool calls, searches, messages, usage, and errors
- Secret redaction for stored prompts, messages, outputs, errors, and trace details
- Responsive right-side inspector with run history, timeline filters, structured evidence, export, durations, failed steps, usage, and redaction counts
- Automatic database migration from starter kit schema version 1 to version 3

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full component view.

```mermaid
flowchart LR
    Browser["Browser Playground + AgentTrace Inspector"] --> API["Fastify API"]
    API --> Service["AgentService"]
    Service --> Redactor["Central redactor"]
    Service --> Store["JSON store v3<br/>runs + traceEvents"]
    Service --> Runner{"AgentRunner"}
    Runner -->|Local process| Codex["Codex CLI"]
    Runner -->|Container| Runtime["Disposable runtime container"]
    Codex --> Model["Selected model provider"]
    Runtime --> Model
```

Provider credentials stay outside persisted trace data. AgentTrace stores only redacted user-visible details and minimal structured runtime metadata.

## Local Setup

### Requirements

- Node.js 22+
- npm 10+
- Either local Codex CLI or a container engine for the starter runtime path
- Either Volcengine Ark credentials or an OpenAI API key for real runs

### Install and configure

```bash
npm install
cp .env.example .env
```

For local development, use paths like:

```dotenv
APP_DATA_DIR=.data
AGENT_WORKSPACE_ROOT=workspaces
CODEX_HOME=codex-home
RUNTIME_PROVIDER=local-process
MODEL_PROVIDER=ark
ARK_API_KEY=your-private-key
ARK_MODEL=ep-your-model
```

Or use OpenAI:

```dotenv
APP_DATA_DIR=.data
AGENT_WORKSPACE_ROOT=workspaces
CODEX_HOME=codex-home
RUNTIME_PROVIDER=local-process
MODEL_PROVIDER=openai
OPENAI_API_KEY=your-openai-api-key
OPENAI_MODEL=gpt-5-codex
```

### Start the app

```bash
npm run dev
```

- Web UI: [http://localhost:5173](http://localhost:5173)
- API: [http://localhost:3000](http://localhost:3000)

### Validate

```bash
npm run check
```

## Demo Script

Use the repeatable script in [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) to show one successful run, one failing run, evidence highlighting, filters, export, and redaction.

## Acceptance Notes

- The middleware executes in the backend, not as a mock UI
- Both success and failure cases are visible in the trace
- Stored prompts and runtime details are redacted before persistence
- Existing agents, messages, and runs survive schema migration
- Deleting an Agent also deletes its trace records

## Current Limitations

- The product is still single-user and uses a shared access token, not real identity
- Policy enforcement and kill-switch behavior are out of scope for this track
- Container instrumentation is implemented, but Docker or Podman still needs to be installed locally for that runtime mode
- Final live rehearsal still requires real private credentials in `.env`

## References

- [Architecture](docs/ARCHITECTURE.md)
- [One-page architecture diagram](docs/AGENTTRACE_ARCHITECTURE.md)
- [Architecture diagram SVG](docs/agenttrace-architecture.svg)
- [Hackathon extension guide](docs/HACKATHON_EXTENSION_GUIDE.md)
- [Demo script](docs/DEMO_SCRIPT.md)
- [Local POC](docs/LOCAL_POC.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Security policy](SECURITY.md)

## License

[MIT](LICENSE)
