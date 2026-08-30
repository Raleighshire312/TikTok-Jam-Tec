# AgentTrace Architecture

AgentTrace keeps the starter kit flow intact, then inserts trace capture and redaction into the backend path that already owns run execution.

## One-page view

See [AgentTrace one-page architecture diagram](AGENTTRACE_ARCHITECTURE.md) for the submission-ready version.

```mermaid
flowchart TB
    Browser["Browser UI<br/>Playground + AgentTrace Inspector"] --> API["Fastify API<br/>REST + optional bearer auth"]
    API --> Service["AgentService<br/>run lifecycle owner"]
    Service --> Recorder["Trace recorder queue"]
    Recorder --> Redactor["Redactor"]
    Redactor --> Store["JsonStore v3<br/>agents, messages, runs, traceEvents"]
    Store --> Diagnosis["Trace diagnosis + export"]
    Diagnosis --> API
    Service --> Workspace["Agent workspace"]
    Service --> Runner{"AgentRunner"}
    Runner -->|local-process| Codex["Codex CLI child process"]
    Runner -->|container| Runtime["Disposable runtime container"]
    Codex --> Normalizer["Trace normalizer / span builder"]
    Runtime --> Normalizer
    Normalizer -->|runtime event observer| Recorder
    Codex --> Ark["Volcengine Ark Responses API"]
    Runtime --> Ark

    subgraph TrustBoundary["Ark trust boundary"]
      Ark
    end
```

## Flow

1. The browser sends a prompt to the Fastify API.
2. `AgentService` creates a queued run, stores the redacted prompt, and appends the first lifecycle trace event.
3. The runner executes Codex and streams JSON events.
4. Runtime events are normalized into a small `TraceEvent` span model and passed back through the observer.
5. `AgentService` redacts safe detail fields again before persisting them into `traceEvents`.
6. The trace API returns ordered spans, summary metrics, diagnosis, first-failure evidence, and retry metadata.
7. The browser polls the run and trace endpoints until the run reaches a terminal state.
8. The inspector renders ordered steps, durations, failed commands, usage, filters, export, and redaction counts.

## Main Components

### AgentService

- Owns run lifecycle state
- Ensures one active run per Agent
- Assigns trace, session, attempt, and agent version metadata
- Records lifecycle trace events
- Closes unfinished trace steps on restart, cancellation, timeout, or failure
- Builds diagnosis and first-failure summaries for the trace endpoint

### Redactor

- Replaces configured secrets
- Replaces bearer tokens and common API-key formats
- Redacts values attached to key, token, secret, and password fields
- Prevents raw prompt, output, and error strings from reaching disk

### JsonStore v3

- Migrates v1 starter data automatically
- Persists `traceEvents` alongside existing agent, message, and run records
- Serializes writes so rapid runtime events keep deterministic ordering

### Runners

- `CodexRunner` covers local process execution
- `ContainerCodexRunner` covers disposable local runtime containers
- Both emit the same normalized runtime event model

## Data Model

Each trace record stores:

- run, agent, trace, span, parent span, and session identifiers
- agent version, actor type, retry attempt, and runtime metadata
- deterministic sequence number
- source, kind, and status
- label
- item correlation id when available
- started and completed timestamps
- duration
- minimal safe detail
- usage
- whether redaction was applied

The store intentionally does not persist raw reasoning or unrestricted runtime payloads.
