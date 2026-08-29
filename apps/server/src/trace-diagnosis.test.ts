import { describe, expect, it } from "vitest";
import { diagnoseTrace } from "./trace-diagnosis.js";
import type { AgentRun, TraceEvent } from "./types.js";

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
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
    completedAt: "2026-01-01T00:00:03.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

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

describe("diagnoseTrace", () => {
  it("returns a success diagnosis for a completed command run", () => {
    const diagnosis = diagnoseTrace(makeRun(), [makeEvent()]);
    expect(diagnosis).toMatchObject({
      severity: "success",
      headline: "Run completed successfully",
      evidenceEventId: "span-1",
    });
  });

  it("surfaces non-zero exit codes as the primary diagnosis", () => {
    const diagnosis = diagnoseTrace(makeRun(), [
      makeEvent({
        id: "event-exit",
        spanId: "span-exit",
        detail: { command: "npm test", exitCode: 2, error: "Tests failed" },
      }),
    ]);
    expect(diagnosis).toMatchObject({
      severity: "error",
      headline: "Command exited with a non-zero status",
      evidenceEventId: "span-exit",
    });
    expect(diagnosis.cause).toContain("Tests failed");
  });

  it("reports runtime errors when no command exit code is available", () => {
    const diagnosis = diagnoseTrace(makeRun({ status: "failed", error: "Runner failed" }), [
      makeEvent({
        id: "event-error",
        spanId: "span-error",
        kind: "error",
        status: "failed",
        label: "Runtime error",
        detail: { error: "Unhandled exception" },
      }),
    ]);
    expect(diagnosis).toMatchObject({
      severity: "error",
      headline: "Runtime step failed",
      evidenceEventId: "span-error",
    });
  });

  it("reports cancellation with warning severity", () => {
    const diagnosis = diagnoseTrace(
      makeRun({ status: "cancelled", error: "Stopped by operator" }),
      [
        makeEvent({
          id: "event-cancelled",
          spanId: "span-cancelled",
          kind: "lifecycle",
          status: "cancelled",
          label: "Run cancelled",
          detail: { note: "Stopped by operator" },
        }),
      ],
    );
    expect(diagnosis).toMatchObject({
      severity: "warning",
      headline: "Run was cancelled",
      evidenceEventId: "span-cancelled",
    });
  });

  it("detects timeout-like failures before generic command failures", () => {
    const diagnosis = diagnoseTrace(makeRun({ status: "failed" }), [
      makeEvent({
        id: "event-timeout",
        spanId: "span-timeout",
        status: "failed",
        detail: {
          command: "npm run build",
          exitCode: 124,
          error: "Process timed out after 600000 ms",
        },
      }),
    ]);
    expect(diagnosis).toMatchObject({
      severity: "error",
      headline: "Run timed out",
      evidenceEventId: "span-timeout",
    });
  });

  it("falls back to a run-level failure when no actionable events exist", () => {
    const diagnosis = diagnoseTrace(makeRun({ status: "failed", error: "Runner crashed early" }), []);
    expect(diagnosis).toMatchObject({
      severity: "error",
      headline: "Run failed without step-level evidence",
      evidenceEventId: null,
    });
  });

  it("never points evidence at an event from a different run", () => {
    const diagnosis = diagnoseTrace(makeRun(), [
      makeEvent({
        id: "event-other-run",
        runId: "run-2",
        detail: { command: "npm test", exitCode: 1, error: "Wrong run" },
      }),
    ]);
    expect(diagnosis.evidenceEventId).toBeNull();
  });
});
