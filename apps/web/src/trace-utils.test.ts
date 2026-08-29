import { describe, expect, it } from "vitest";
import { buildTraceExport, defaultTraceFilters, filterTraceEvents } from "./trace-utils";
import type { RunTrace, TraceEvent } from "./types";

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: "event-1",
    runId: "run-1",
    agentId: "agent-1",
    traceId: "trace-1",
    spanId: "span-1",
    parentSpanId: "run-1:root",
    sessionId: "session-1",
    agentVersion: "1.0.0",
    actorType: "agent",
    metadata: null,
    sequence: 1,
    source: "codex",
    kind: "command",
    status: "completed",
    label: "Command finished",
    itemId: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    detail: { command: "npm test" },
    usage: null,
    redacted: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeTrace(events: TraceEvent[]): RunTrace {
  return {
    run: {
      id: "run-1",
      agentId: "agent-1",
      traceId: "trace-1",
      sessionId: "session-1",
      agentVersion: "1.0.0",
      retryOfRunId: null,
      attempt: 1,
      status: "completed",
      prompt: "inspect repo",
      output: "done",
      error: null,
      usage: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:02.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    traceEvents: events,
    summary: {
      durationMs: 2000,
      stepCount: events.length,
      failedSteps: 1,
      redactionCount: 1,
      inputTokens: 5,
      cachedInputTokens: 0,
      outputTokens: 9,
      diagnosis: {
        severity: "error",
        headline: "Command exited with a non-zero status",
        cause: "npm test failed",
        evidenceEventId: events[1]?.spanId ?? null,
        suggestedAction: "Inspect the command.",
      },
      firstFailure: {
        spanId: events[1]?.spanId ?? "failure-span",
        kind: events[1]?.kind ?? "command",
        label: events[1]?.label ?? "Run tests",
        command: events[1]?.detail?.command ?? "npm test",
        toolName: null,
        exitCode: events[1]?.detail?.exitCode ?? 1,
        durationMs: events[1]?.durationMs ?? 1000,
        error: events[1]?.detail?.error ?? "Secret is [REDACTED]",
      },
    },
  };
}

describe("filterTraceEvents", () => {
  const events = [
    makeEvent({
      id: "success",
      spanId: "span-success",
      label: "Install deps",
      detail: { command: "npm install" },
    }),
    makeEvent({
      id: "failure",
      spanId: "span-failure",
      label: "Run tests",
      status: "failed",
      detail: { command: "npm test", exitCode: 1, error: "Secret is [REDACTED]" },
    }),
    makeEvent({
      id: "search",
      spanId: "span-search",
      kind: "web_search",
      status: "info",
      label: "Search docs",
      detail: { query: "vitest filter api" },
    }),
  ];

  it("filters by search text, kind, status, and failed-only", () => {
    expect(filterTraceEvents(events, { ...defaultTraceFilters, search: "tests" })).toHaveLength(1);
    expect(filterTraceEvents(events, { ...defaultTraceFilters, kind: "web_search" })).toHaveLength(1);
    expect(filterTraceEvents(events, { ...defaultTraceFilters, status: "failed" })).toHaveLength(1);
    expect(filterTraceEvents(events, { ...defaultTraceFilters, failedOnly: true })).toEqual([
      events[1],
    ]);
  });

  it("supports combined filters and reset semantics", () => {
    const filtered = filterTraceEvents(events, {
      search: "vitest",
      kind: "web_search",
      status: "info",
      failedOnly: false,
    });
    expect(filtered).toEqual([events[2]]);
    expect(filterTraceEvents(events, defaultTraceFilters)).toEqual(events);
  });
});

describe("buildTraceExport", () => {
  it("exports the same redacted trace payload used by the inspector", () => {
    const trace = makeTrace([
      makeEvent({ id: "success", spanId: "span-success", redacted: false }),
      makeEvent({
        id: "failure",
        spanId: "span-failure",
        status: "failed",
        redacted: true,
        detail: { command: "npm test", exitCode: 1, error: "Secret is [REDACTED]" },
      }),
    ]);
    const exported = buildTraceExport(trace, "2026-01-02T00:00:00.000Z");
    const serialized = JSON.stringify(exported);
    expect(exported.summary.diagnosis.evidenceEventId).toBe("span-failure");
    expect(exported.schemaVersion).toBe(3);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("super-secret-value");
  });
});
