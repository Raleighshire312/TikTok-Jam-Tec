# AgentTrace One-Page Architecture Diagram

Use this diagram for the TikTok Tech Jam Track 1 Glass Box deliverable. It shows the middleware boundary, trace data flow, persistent audit store, runner instrumentation, and the external Ark trust boundary.

```mermaid
flowchart TB
    Browser["Browser UI<br/>Playground + AgentTrace Inspector<br/>Run history, filters, evidence, export"] --> API["Fastify API<br/>REST + optional bearer auth<br/>/api/runs/:id/trace"]

    API --> Service

    subgraph Middleware["AgentTrace Glass Box Middleware"]
      Service["AgentService<br/>Run lifecycle owner<br/>traceId, sessionId, attempt"]
      Recorder["Trace recorder queue<br/>deterministic sequence order"]
      Redactor["Redactor<br/>secrets, bearer tokens, key/token/password values"]
      Diagnosis["Trace diagnosis + export<br/>first failure, suggested action, JSON artifact"]
      Store["JsonStore v3<br/>agents, messages, runs, traceEvents<br/>spanId, parentSpanId, metadata, usage"]

      Service --> Recorder
      Recorder --> Redactor
      Redactor --> Store
      Store --> Diagnosis
      Diagnosis --> API
    end

    Service --> Runner["AgentRunner interface"]
    Service --> Workspace["Agent workspace<br/>files created and changed by runs"]

    Runner --> Local["Local runner<br/>Codex CLI child process"]
    Runner --> Container["Container runner<br/>disposable runtime"]

    Local --> Normalizer["Trace normalizer / span builder<br/>commands, files, tools, searches, model usage, errors"]
    Container --> Normalizer
    Normalizer -->|"runtime event observer"| Recorder

    Local --> Ark["Volcengine Ark Responses API"]
    Container --> Ark

    subgraph Trust["External trust boundary"]
      Ark
    end
```

## What The Diagram Proves

- AgentTrace is backend middleware, not a UI-only log screen.
- Runs are represented as correlated traces with `traceId`, `spanId`, `parentSpanId`, session, attempt, and agent version.
- Runtime events are normalized before storage.
- Prompts, outputs, errors, and event details pass through redaction before persistence or display.
- The inspector reads the audit trail through the API and can identify a failed step quickly.
- Ark remains outside the local trust boundary; credentials are never stored in trace data.
