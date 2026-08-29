import type { RunTrace, TraceEvent, TraceKind, TraceStatus } from "./types";

export interface TraceFilters {
  search: string;
  kind: TraceKind | "all";
  status: TraceStatus | "all";
  failedOnly: boolean;
}

export const defaultTraceFilters: TraceFilters = {
  search: "",
  kind: "all",
  status: "all",
  failedOnly: false,
};

export function isFailureEvent(event: TraceEvent): boolean {
  return (
    event.status === "failed" ||
    event.status === "cancelled" ||
    event.kind === "error" ||
    (event.kind === "command" &&
      typeof event.detail?.exitCode === "number" &&
      event.detail.exitCode !== 0)
  );
}

function eventSearchText(event: TraceEvent): string {
  return [
    event.label,
    event.traceId,
    event.spanId,
    event.parentSpanId,
    event.sessionId,
    event.agentVersion,
    event.actorType,
    event.source,
    event.kind,
    event.status,
    event.itemId,
    event.detail?.command,
    event.detail?.filePath,
    event.detail?.toolName,
    event.detail?.query,
    event.detail?.error,
    event.detail?.text,
    event.detail?.note,
    event.detail?.changeType,
    event.metadata?.providerSessionId,
    event.metadata?.arkBaseUrl,
    event.metadata?.arkModelId,
    event.metadata?.runtimeProvider,
    event.metadata?.sandboxMode,
    event.metadata?.runtimeInstanceId,
    event.metadata?.containerEngine,
    event.metadata?.containerImage,
    event.metadata?.toolName,
    event.metadata?.platform,
    event.metadata?.architecture,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
}

export function filterTraceEvents(events: TraceEvent[], filters: TraceFilters): TraceEvent[] {
  const search = filters.search.trim().toLowerCase();
  return events.filter((event) => {
    if (filters.kind !== "all" && event.kind !== filters.kind) return false;
    if (filters.status !== "all" && event.status !== filters.status) return false;
    if (filters.failedOnly && !isFailureEvent(event)) return false;
    if (search && !eventSearchText(event).includes(search)) return false;
    return true;
  });
}

export function buildTraceExport(trace: RunTrace, exportedAt = new Date().toISOString()) {
  return {
    schemaVersion: 3,
    exportedAt,
    run: trace.run,
    summary: trace.summary,
    lineage: {
      traceId: trace.run.traceId,
      sessionId: trace.run.sessionId,
      retryOfRunId: trace.run.retryOfRunId,
      attempt: trace.run.attempt,
      agentVersion: trace.run.agentVersion,
    },
    eventCount: trace.traceEvents.length,
    traceEvents: trace.traceEvents,
  };
}

export function downloadTraceExport(trace: RunTrace): void {
  const payload = JSON.stringify(buildTraceExport(trace), null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "agenttrace-" + trace.run.id + ".json";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
