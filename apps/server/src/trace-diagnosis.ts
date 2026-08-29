import type { AgentRun, FirstFailureSummary, TraceDiagnosis, TraceEvent } from "./types.js";

const timeoutPattern = /(timed?\s*out|timeout|deadline exceeded)/i;

function isFailureStatus(event: TraceEvent): boolean {
  return event.status === "failed" || event.status === "cancelled";
}

function evidenceIdFor(event: TraceEvent | null): string | null {
  return event?.spanId ?? event?.id ?? null;
}

export function isTraceFailureEvent(event: TraceEvent): boolean {
  return (
    isFailureStatus(event) ||
    event.kind === "error" ||
    (event.kind === "command" &&
      typeof event.detail?.exitCode === "number" &&
      event.detail.exitCode !== 0)
  );
}

function eventText(event: TraceEvent): string {
  return [
    event.label,
    event.detail?.error,
    event.detail?.note,
    event.detail?.text,
    event.detail?.command,
    event.detail?.query,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function firstDetail(event: TraceEvent | null): string | null {
  if (!event) return null;
  return (
    event.detail?.error ??
    event.detail?.note ??
    event.detail?.text ??
    event.detail?.command ??
    event.detail?.filePath ??
    event.detail?.query ??
    null
  );
}

function lastMatchingEvent(
  events: TraceEvent[],
  predicate: (event: TraceEvent) => boolean,
): TraceEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && predicate(event)) {
      return event;
    }
  }
  return null;
}

function firstMatchingEvent(
  events: TraceEvent[],
  predicate: (event: TraceEvent) => boolean,
): TraceEvent | null {
  for (const event of events) {
    if (predicate(event)) return event;
  }
  return null;
}

function buildDiagnosis(
  severity: TraceDiagnosis["severity"],
  headline: string,
  cause: string,
  evidenceEventId: string | null,
  suggestedAction: string,
): TraceDiagnosis {
  return { severity, headline, cause, evidenceEventId, suggestedAction };
}

export function summarizeFirstFailure(
  run: AgentRun,
  traceEvents: TraceEvent[],
): FirstFailureSummary | null {
  const firstFailure = firstMatchingEvent(
    traceEvents.filter((event) => event.runId === run.id),
    (event) => event.kind !== "lifecycle" && event.parentSpanId !== null && isTraceFailureEvent(event),
  );
  if (!firstFailure) return null;
  return {
    spanId: firstFailure.spanId,
    kind: firstFailure.kind,
    label: firstFailure.label,
    command: firstFailure.detail?.command ?? null,
    toolName: firstFailure.detail?.toolName ?? firstFailure.metadata?.toolName ?? null,
    exitCode: typeof firstFailure.detail?.exitCode === "number" ? firstFailure.detail.exitCode : null,
    durationMs: firstFailure.durationMs,
    error: firstFailure.detail?.error ?? firstFailure.detail?.note ?? null,
  };
}

export function diagnoseTrace(run: AgentRun, traceEvents: TraceEvent[]): TraceDiagnosis {
  const events = traceEvents.filter((event) => event.runId === run.id);

  const timeoutEvent = lastMatchingEvent(
    events,
    (event) => isTraceFailureEvent(event) && timeoutPattern.test(eventText(event)),
  );
  if (timeoutEvent) {
    return buildDiagnosis(
      "error",
      "Run timed out",
      firstDetail(timeoutEvent) ?? "A recorded step exceeded the runtime deadline.",
      evidenceIdFor(timeoutEvent),
      "Inspect the highlighted step, then reduce its scope or increase the configured timeout.",
    );
  }

  if (run.status === "cancelled") {
    const cancelledEvent = lastMatchingEvent(events, (event) => event.status === "cancelled");
    return buildDiagnosis(
      "warning",
      "Run was cancelled",
      run.error ??
        firstDetail(cancelledEvent ?? events.at(-1) ?? null) ??
        "Execution stopped before the run reached a successful terminal state.",
      evidenceIdFor(cancelledEvent),
      "Rerun the task if cancellation was accidental, or keep the trace as evidence for the partial attempt.",
    );
  }

  const commandFailure = lastMatchingEvent(
    events,
    (event) =>
      event.kind === "command" &&
      typeof event.detail?.exitCode === "number" &&
      event.detail.exitCode !== 0,
  );
  if (commandFailure) {
    return buildDiagnosis(
      "error",
      "Command exited with a non-zero status",
      firstDetail(commandFailure) ??
        "A shell command finished with exit code " + commandFailure.detail?.exitCode + ".",
      evidenceIdFor(commandFailure),
      "Review the command, exit code, and nearby file or tool spans to fix the failing step.",
    );
  }

  const runtimeError = lastMatchingEvent(
    events,
    (event) => event.kind === "error" || (event.kind !== "lifecycle" && isFailureStatus(event)),
  );
  if (runtimeError) {
    return buildDiagnosis(
      runtimeError.status === "cancelled" ? "warning" : "error",
      runtimeError.status === "cancelled" ? "Step was cancelled" : "Runtime step failed",
      firstDetail(runtimeError) ?? "A recorded step failed without a more specific command exit.",
      evidenceIdFor(runtimeError),
      "Open the highlighted evidence and inspect the failing span before retrying the run.",
    );
  }

  if (run.status === "failed") {
    return buildDiagnosis(
      "error",
      "Run failed without step-level evidence",
      run.error ?? "The run ended before an actionable trace event was captured.",
      null,
      "Check runner logs and add instrumentation around the failing path so future traces capture the exact step.",
    );
  }

  if (run.status === "running") {
    return buildDiagnosis(
      "info",
      "Run is still in progress",
      "AgentTrace is still collecting runtime evidence for this run.",
      null,
      "Wait for the run to finish or watch the timeline as new spans arrive.",
    );
  }

  if (run.status === "queued") {
    return buildDiagnosis(
      "info",
      "Run is queued",
      "The run has been accepted and is waiting to start.",
      null,
      "Keep the trace open while the runner begins execution.",
    );
  }

  const successEvent =
    lastMatchingEvent(events, (event) => event.kind !== "lifecycle" && event.status === "completed") ??
    lastMatchingEvent(events, (event) => event.status === "completed");
  if (run.status === "completed") {
    return buildDiagnosis(
      "success",
      "Run completed successfully",
      successEvent
        ? "Recorded runtime steps completed without actionable failures."
        : "The run completed and no actionable failures were recorded.",
      evidenceIdFor(successEvent),
      "Use the timeline and export to capture supporting evidence for the successful run.",
    );
  }

  return buildDiagnosis(
    "info",
    "No actionable trace evidence yet",
    "The current trace does not contain a diagnosable step.",
    null,
    "Keep instrumenting runtime events so future runs produce clearer evidence.",
  );
}
