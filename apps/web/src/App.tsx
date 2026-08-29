import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  Download,
  Eye,
  FilePenLine,
  Info,
  RotateCcw,
  RefreshCcw,
  Search,
  ShieldAlert,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import { api, ApiError, setAuthToken } from "./api";
import {
  defaultTraceFilters,
  downloadTraceExport,
  filterTraceEvents,
  isFailureEvent,
} from "./trace-utils";
import type {
  Agent,
  AgentRun,
  Message,
  RunTrace,
  SystemInfo,
  TraceDiagnosis,
  TraceEvent,
  TraceKind,
  TraceStatus,
} from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

const terminalRunStatuses = new Set(["completed", "failed", "cancelled"]);

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDateTime(value: string | null): string {
  if (!value) return "Pending";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "Pending";
  if (durationMs < 1_000) return durationMs + " ms";
  const seconds = durationMs / 1_000;
  if (seconds < 60) return seconds.toFixed(seconds >= 10 ? 0 : 1) + " s";
  return Math.floor(seconds / 60) + "m " + Math.round(seconds % 60) + "s";
}

function describeRun(run: AgentRun, trace: RunTrace | null): string {
  if (run.status === "completed" && (trace?.summary.failedSteps ?? 0) > 0) {
    return "Completed with step failures";
  }
  if (run.status === "queued") return "Queued";
  if (run.status === "running") return "Running";
  if (run.status === "failed") return "Failed";
  if (run.status === "cancelled") return "Cancelled";
  return "Completed";
}

function runTone(run: AgentRun, trace: RunTrace | null): string {
  if (run.status === "completed" && (trace?.summary.failedSteps ?? 0) > 0) return "warning";
  if (run.status === "completed") return "completed";
  if (run.status === "failed") return "failed";
  if (run.status === "cancelled") return "cancelled";
  if (run.status === "running") return "running";
  return "queued";
}

function traceTone(event: TraceEvent): string {
  if (isFailureEvent(event) || event.status === "failed") return "failed";
  if (event.status === "cancelled") return "cancelled";
  if (event.status === "completed") return "completed";
  if (event.status === "running") return "running";
  return "queued";
}

function diagnosisTone(severity: TraceDiagnosis["severity"]): string {
  if (severity === "error") return "failed";
  if (severity === "warning") return "warning";
  if (severity === "success") return "completed";
  return "running";
}

function eventSummary(event: TraceEvent): string {
  if (event.detail?.command) return event.detail.command;
  if (event.detail?.filePath) return event.detail.filePath;
  if (event.detail?.toolName) return event.detail.toolName;
  if (event.detail?.query) return event.detail.query;
  if (event.detail?.error) return event.detail.error;
  if (event.detail?.text) return event.detail.text;
  if (event.detail?.note) return event.detail.note;
  return event.source === "service" ? "Platform lifecycle event" : "Runtime event";
}

function evidenceIdFor(event: TraceEvent): string {
  return event.spanId || event.id;
}

function formatLabel(value: string): string {
  return value
    .split("_")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatNumber(value: number | null | undefined): string {
  if (typeof value !== "number") return "0";
  return value.toLocaleString();
}

function formatOptional(value: string | null | undefined): string {
  return value && value.trim().length > 0 ? value : "Unavailable";
}

function DiagnosisIcon({ severity }: { severity: TraceDiagnosis["severity"] }) {
  const size = 16;
  if (severity === "success") return <CheckCircle2 size={size} />;
  if (severity === "warning") return <AlertTriangle size={size} />;
  if (severity === "error") return <ShieldAlert size={size} />;
  return <Info size={size} />;
}

function TraceEventDetails({
  event,
  highlighted,
}: {
  event: TraceEvent;
  highlighted: boolean;
}) {
  const rows: Array<{ label: string; value: string; code?: boolean }> = [];

  rows.push({ label: "Source", value: formatLabel(event.source) });
  rows.push({ label: "Kind", value: formatLabel(event.kind) });
  rows.push({ label: "Status", value: formatLabel(event.status) });
  rows.push({ label: "Span ID", value: event.spanId, code: true });
  rows.push({ label: "Trace ID", value: event.traceId, code: true });
  rows.push({ label: "Session ID", value: event.sessionId, code: true });
  rows.push({ label: "Actor", value: formatLabel(event.actorType) });
  if (event.parentSpanId) rows.push({ label: "Parent span", value: event.parentSpanId, code: true });

  if (event.detail?.command) rows.push({ label: "Command", value: event.detail.command, code: true });
  if (typeof event.detail?.exitCode === "number") rows.push({ label: "Exit code", value: String(event.detail.exitCode) });
  if (event.detail?.filePath) rows.push({ label: "File", value: event.detail.filePath, code: true });
  if (event.detail?.changeType) rows.push({ label: "Change", value: event.detail.changeType });
  if (event.detail?.toolName) rows.push({ label: "Tool", value: event.detail.toolName });
  if (event.detail?.query) rows.push({ label: "Search", value: event.detail.query });
  if (event.detail?.error) rows.push({ label: "Error", value: event.detail.error });
  if (event.detail?.text) rows.push({ label: "Text", value: event.detail.text });
  if (event.detail?.note) rows.push({ label: "Note", value: event.detail.note });

  rows.push({ label: "Started", value: formatDateTime(event.startedAt ?? event.createdAt) });
  if (event.completedAt) rows.push({ label: "Completed", value: formatDateTime(event.completedAt) });
  rows.push({ label: "Duration", value: formatDuration(event.durationMs) });

  if (typeof event.usage?.inputTokens === "number") {
    rows.push({ label: "Input tokens", value: formatNumber(event.usage.inputTokens) });
  }
  if (typeof event.usage?.cachedInputTokens === "number") {
    rows.push({
      label: "Cached input",
      value: formatNumber(event.usage.cachedInputTokens),
    });
  }
  if (typeof event.usage?.outputTokens === "number") {
    rows.push({ label: "Output tokens", value: formatNumber(event.usage.outputTokens) });
  }
  if (typeof event.usage?.totalTokens === "number") {
    rows.push({ label: "Total tokens", value: formatNumber(event.usage.totalTokens) });
  }

  const metadataRows: Array<[string, string | null | undefined, boolean?]> = [
    ["Provider session", event.metadata?.providerSessionId, true],
    ["Ark endpoint", event.metadata?.arkBaseUrl],
    ["Ark model", event.metadata?.arkModelId],
    ["Runtime provider", event.metadata?.runtimeProvider],
    ["Sandbox", event.metadata?.sandboxMode],
    ["Runtime instance", event.metadata?.runtimeInstanceId],
    ["Container engine", event.metadata?.containerEngine],
    ["Container image", event.metadata?.containerImage],
    ["Tool metadata", event.metadata?.toolName],
    ["Platform", event.metadata?.platform],
    ["Architecture", event.metadata?.architecture],
  ];

  for (const [label, value, code] of metadataRows) {
    if (value) rows.push({ label, value, code });
  }

  return (
    <details className="trace-event-detail" open={highlighted}>
      <summary>{eventSummary(event)}</summary>
      <div className="trace-detail-grid">
        {rows.map((row) => (
          <div className="trace-detail-row" key={row.label}>
            <span>{row.label}</span>
            {row.code ? <code>{row.value}</code> : <strong>{row.value}</strong>}
          </div>
        ))}
      </div>
    </details>
  );
}

function InspectorFieldGrid({
  rows,
}: {
  rows: Array<{ label: string; value: string; code?: boolean }>;
}) {
  return (
    <div className="trace-detail-grid trace-summary-grid">
      {rows.map((row) => (
        <div className="trace-detail-row" key={row.label}>
          <span>{row.label}</span>
          {row.code ? <code>{row.value}</code> : <strong>{row.value}</strong>}
        </div>
      ))}
    </div>
  );
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function RunPill({ run, trace }: { run: AgentRun; trace: RunTrace | null }) {
  return <span className={"run-pill run-pill-" + runTone(run, trace)}>{describeRun(run, trace)}</span>;
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

function TraceIcon({ event }: { event: TraceEvent }) {
  const size = 15;
  if (event.kind === "command") return <TerminalSquare size={size} />;
  if (event.kind === "file_change") return <FilePenLine size={size} />;
  if (event.kind === "tool_call") return <Wrench size={size} />;
  if (event.kind === "web_search") return <Search size={size} />;
  if (event.kind === "usage") return <Activity size={size} />;
  if (event.kind === "error") return <ShieldAlert size={size} />;
  if (event.kind === "message") return <Bot size={size} />;
  return <Clock3 size={size} />;
}

function TraceInspector({
  runs,
  selectedRunId,
  onSelectRun,
  trace,
  loading,
  onRetryRun,
  onClose,
}: {
  runs: AgentRun[];
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
  trace: RunTrace | null;
  loading: boolean;
  onRetryRun: (run: AgentRun) => void;
  onClose?: () => void;
}) {
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;
  const traceForRun = trace && trace.run.id === selectedRunId ? trace : null;
  const [filters, setFilters] = useState(defaultTraceFilters);

  useEffect(() => {
    setFilters(defaultTraceFilters);
  }, [selectedRunId]);

  const allEvents = traceForRun?.traceEvents ?? [];
  const filteredEvents = traceForRun ? filterTraceEvents(allEvents, filters) : [];
  const diagnosis = traceForRun?.summary.diagnosis ?? null;
  const evidenceEventId = diagnosis?.evidenceEventId ?? null;
  const firstFailure = traceForRun?.summary.firstFailure ?? null;
  const hasActiveFilters =
    filters.search.trim().length > 0 ||
    filters.kind !== "all" ||
    filters.status !== "all" ||
    filters.failedOnly;
  const availableKinds = [...new Set(allEvents.map((event) => event.kind))] as TraceKind[];
  const availableStatuses = [...new Set(allEvents.map((event) => event.status))] as TraceStatus[];

  const focusEvidence = useCallback((eventId: string) => {
    window.requestAnimationFrame(() => {
      const element = document.getElementById("trace-event-" + eventId);
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
      (element as HTMLElement | null)?.focus();
    });
  }, []);

  const resetFilters = useCallback(() => {
    setFilters(defaultTraceFilters);
  }, []);

  const viewEvidence = useCallback(() => {
    if (!evidenceEventId) return;
    if (!filteredEvents.some((event) => evidenceIdFor(event) === evidenceEventId)) {
      setFilters(defaultTraceFilters);
    }
    window.setTimeout(() => focusEvidence(evidenceEventId), 50);
  }, [evidenceEventId, filteredEvents, focusEvidence]);

  const exportTrace = useCallback(() => {
    if (!traceForRun) return;
    downloadTraceExport(traceForRun);
  }, [traceForRun]);

  const setQuickFilter = useCallback((preset: "failed" | "running" | "tool_call" | "file_change") => {
    if (preset === "failed") {
      setFilters({ ...defaultTraceFilters, failedOnly: true });
      return;
    }
    if (preset === "running") {
      setFilters({ ...defaultTraceFilters, status: "running" });
      return;
    }
    setFilters({ ...defaultTraceFilters, kind: preset });
  }, []);

  return (
    <aside className="trace-panel">
      <div className="trace-panel-header">
        <div>
          <span className="eyebrow">Glass Box</span>
          <h2>AgentTrace</h2>
        </div>
        {onClose ? (
          <button className="trace-close" onClick={onClose} aria-label="Close trace panel">
            ×
          </button>
        ) : null}
      </div>

      <div className="trace-track-card">
        <div className="trace-track-row">
          <Eye size={16} />
          <strong>Selected track</strong>
        </div>
        <span>Trace and audit middleware with redaction-aware runtime evidence.</span>
      </div>

      <div className="trace-runs">
        <div className="trace-section-title">
          <span>Runs</span>
          <span>{runs.length}</span>
        </div>
        <div className="trace-run-list">
          {runs.length === 0 ? (
            <div className="trace-empty">Run history appears here after the first task.</div>
          ) : (
            runs.map((run) => (
              <button
                className={"trace-run-card " + (run.id === selectedRunId ? "selected" : "")}
                key={run.id}
                onClick={() => onSelectRun(run.id)}
              >
                <div>
                  <strong>{describeRun(run, traceForRun && traceForRun.run.id === run.id ? traceForRun : null)}</strong>
                  <span>{formatDateTime(run.createdAt)}</span>
                </div>
                <RunPill run={run} trace={traceForRun && traceForRun.run.id === run.id ? traceForRun : null} />
              </button>
            ))
          )}
        </div>
      </div>

      {selectedRun ? (
        <>
          <div className="trace-section-title">
            <span>Run summary</span>
            {loading ? <Spinner /> : null}
          </div>
          <div className="trace-metrics">
            <div className="trace-metric">
              <span>Status</span>
              <strong>{describeRun(selectedRun, traceForRun)}</strong>
            </div>
            <div className="trace-metric">
              <span>Duration</span>
              <strong>
                {formatDuration(
                  traceForRun?.summary.durationMs ??
                    (selectedRun.startedAt && selectedRun.completedAt
                      ? Date.parse(selectedRun.completedAt) - Date.parse(selectedRun.startedAt)
                      : null),
                )}
              </strong>
            </div>
            <div className="trace-metric">
              <span>Steps</span>
              <strong>{traceForRun?.summary.stepCount ?? 0}</strong>
            </div>
            <div className="trace-metric">
              <span>Failed steps</span>
              <strong>{traceForRun?.summary.failedSteps ?? 0}</strong>
            </div>
            <div className="trace-metric">
              <span>Output tokens</span>
              <strong>{formatNumber(traceForRun?.summary.outputTokens ?? selectedRun.usage?.outputTokens)}</strong>
            </div>
            <div className="trace-metric">
              <span>Redactions</span>
              <strong>{formatNumber(traceForRun?.summary.redactionCount)}</strong>
            </div>
          </div>

          {diagnosis ? (
            <div className={"trace-diagnosis trace-diagnosis-" + diagnosisTone(diagnosis.severity)}>
              <div className="trace-diagnosis-head">
                <div className="trace-diagnosis-title">
                  <DiagnosisIcon severity={diagnosis.severity} />
                  <div>
                    <span>Diagnosis</span>
                    <strong>{diagnosis.headline}</strong>
                  </div>
                </div>
                <div className="trace-diagnosis-actions">
                  <button className="trace-inline-button" onClick={viewEvidence} disabled={!evidenceEventId}>
                    View evidence
                  </button>
                  <button className="trace-inline-button" onClick={exportTrace}>
                    <Download size={14} />
                    Download Trace JSON
                  </button>
                  <button
                    className="trace-inline-button"
                    onClick={() => selectedRun && onRetryRun(selectedRun)}
                    disabled={!selectedRun}
                  >
                    <RefreshCcw size={14} />
                    Retry
                  </button>
                </div>
              </div>
              <p>{diagnosis.cause}</p>
              <div className="trace-diagnosis-footer">
                <span>{diagnosis.suggestedAction}</span>
                <span>
                  {(traceForRun?.summary.redactionCount ?? 0) > 0
                    ? "Export contains only persisted redacted data."
                    : "Export uses the persisted trace artifact."}
                </span>
              </div>
            </div>
          ) : null}

          {traceForRun ? (
            <div className="trace-summary-stack">
              <div className="trace-section-title">
                <span>Identity</span>
                <span>v3</span>
              </div>
              <InspectorFieldGrid
                rows={[
                  { label: "Run ID", value: traceForRun.run.id, code: true },
                  { label: "Trace ID", value: traceForRun.run.traceId, code: true },
                  { label: "Session ID", value: traceForRun.run.sessionId, code: true },
                  { label: "Attempt", value: String(traceForRun.run.attempt) },
                  { label: "Retry of", value: formatOptional(traceForRun.run.retryOfRunId), code: Boolean(traceForRun.run.retryOfRunId) },
                  { label: "Agent version", value: traceForRun.run.agentVersion },
                ]}
              />
              <div className="trace-section-title">
                <span>Runtime</span>
                <span>{traceForRun.traceEvents.length}</span>
              </div>
              <InspectorFieldGrid
                rows={[
                  { label: "Ark endpoint", value: formatOptional(traceForRun.traceEvents.find((event) => event.metadata?.arkBaseUrl)?.metadata?.arkBaseUrl) },
                  { label: "Ark model", value: formatOptional(traceForRun.traceEvents.find((event) => event.metadata?.arkModelId)?.metadata?.arkModelId) },
                  { label: "Provider session", value: formatOptional(traceForRun.traceEvents.find((event) => event.metadata?.providerSessionId)?.metadata?.providerSessionId), code: Boolean(traceForRun.traceEvents.find((event) => event.metadata?.providerSessionId)?.metadata?.providerSessionId) },
                  { label: "Runtime provider", value: formatOptional(traceForRun.traceEvents.find((event) => event.metadata?.runtimeProvider)?.metadata?.runtimeProvider) },
                  { label: "Sandbox", value: formatOptional(traceForRun.traceEvents.find((event) => event.metadata?.sandboxMode)?.metadata?.sandboxMode) },
                ]}
              />
              {firstFailure ? (
                <>
                  <div className="trace-section-title">
                    <span>First failure</span>
                    <span>{formatLabel(firstFailure.kind)}</span>
                  </div>
                  <InspectorFieldGrid
                    rows={[
                      { label: "Span ID", value: firstFailure.spanId, code: true },
                      { label: "Label", value: firstFailure.label },
                      { label: "Command", value: formatOptional(firstFailure.command), code: Boolean(firstFailure.command) },
                      { label: "Tool", value: formatOptional(firstFailure.toolName) },
                      { label: "Exit code", value: firstFailure.exitCode === null ? "Unavailable" : String(firstFailure.exitCode) },
                      { label: "Duration", value: formatDuration(firstFailure.durationMs) },
                      { label: "Error", value: formatOptional(firstFailure.error) },
                    ]}
                  />
                </>
              ) : null}
            </div>
          ) : null}

          <div className="trace-section-title">
            <span>Timeline</span>
            <span>{traceForRun ? filteredEvents.length + " of " + allEvents.length : 0}</span>
          </div>
          <div className="trace-filters">
            <div className="trace-chip-row">
              <button className="trace-chip" onClick={() => setQuickFilter("failed")} type="button">
                Failed
              </button>
              <button className="trace-chip" onClick={() => setQuickFilter("running")} type="button">
                Running
              </button>
              <button className="trace-chip" onClick={() => setQuickFilter("tool_call")} type="button">
                Tool
              </button>
              <button className="trace-chip" onClick={() => setQuickFilter("file_change")} type="button">
                File change
              </button>
            </div>
            <label className="trace-filter trace-filter-search">
              <span>Search</span>
              <input
                type="search"
                placeholder="Command, file, tool, error..."
                value={filters.search}
                onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
              />
            </label>
            <label className="trace-filter">
              <span>Kind</span>
              <select
                value={filters.kind}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    kind: event.target.value as TraceKind | "all",
                  }))
                }
              >
                <option value="all">All kinds</option>
                {availableKinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {formatLabel(kind)}
                  </option>
                ))}
              </select>
            </label>
            <label className="trace-filter">
              <span>Status</span>
              <select
                value={filters.status}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    status: event.target.value as TraceStatus | "all",
                  }))
                }
              >
                <option value="all">All statuses</option>
                {availableStatuses.map((status) => (
                  <option key={status} value={status}>
                    {formatLabel(status)}
                  </option>
                ))}
              </select>
            </label>
            <label className="trace-filter trace-filter-toggle">
              <input
                type="checkbox"
                checked={filters.failedOnly}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, failedOnly: event.target.checked }))
                }
              />
              <span>Failed only</span>
            </label>
            <div className="trace-filter-summary">
              <span>{filteredEvents.length} visible events</span>
              <button className="trace-inline-button" onClick={resetFilters} disabled={!hasActiveFilters}>
                <RotateCcw size={14} />
                Reset
              </button>
            </div>
          </div>
          <div className="trace-timeline">
            {!traceForRun && loading ? (
              <div className="trace-empty">Loading redacted trace evidence for this run.</div>
            ) : traceForRun && allEvents.length > 0 && filteredEvents.length === 0 ? (
              <div className="trace-empty trace-empty-action">
                <div>
                  <strong>No events match these filters.</strong>
                  <span>Try another search, widen the kind or status, or reset back to the full timeline.</span>
                </div>
                <button className="trace-inline-button" onClick={resetFilters}>
                  Reset filters
                </button>
              </div>
            ) : traceForRun && allEvents.length > 0 ? (
              filteredEvents.map((event) => (
                <article
                  className={
                    "trace-event trace-event-" +
                    traceTone(event) +
                    (evidenceIdFor(event) === evidenceEventId ? " trace-event-evidence" : "")
                  }
                  key={event.id}
                  id={"trace-event-" + evidenceIdFor(event)}
                  tabIndex={-1}
                >
                  <div className="trace-event-icon">
                    <TraceIcon event={event} />
                  </div>
                  <div className="trace-event-copy">
                    <div className="trace-event-head">
                      <strong>{event.label}</strong>
                      <span>{formatDuration(event.durationMs)}</span>
                    </div>
                    <div className="trace-event-meta">
                      <span>{event.status}</span>
                      <span>{formatDateTime(event.startedAt ?? event.createdAt)}</span>
                      {event.redacted ? <span>Redacted</span> : null}
                      {typeof event.detail?.exitCode === "number" ? <span>Exit {event.detail.exitCode}</span> : null}
                      {evidenceIdFor(event) === evidenceEventId ? <span>Evidence</span> : null}
                    </div>
                    <TraceEventDetails event={event} highlighted={evidenceIdFor(event) === evidenceEventId} />
                  </div>
                </article>
              ))
            ) : selectedRun.status === "running" ? (
              <div className="trace-empty">
                The run is still active. Timeline evidence appears here as commands, tools, searches, and files are recorded.
              </div>
            ) : selectedRun.status === "queued" ? (
              <div className="trace-empty">
                This run is queued. Keep the inspector open and AgentTrace will fill in the timeline once execution begins.
              </div>
            ) : selectedRun.status === "cancelled" ? (
              <div className="trace-empty">
                This run was cancelled before runtime evidence was fully captured.
              </div>
            ) : (
              <div className="trace-empty">
                No runtime trace is available for this run yet. The run metadata is persisted, but no step-level evidence was recorded.
              </div>
            )}
          </div>
        </>
      ) : null}
    </aside>
  );
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTraceDrawer, setShowTraceDrawer] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [retryOfRunId, setRetryOfRunId] = useState<string | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const selectedRunIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;
  selectedRunIdRef.current = selectedRunId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );
  const activeRun = useMemo(
    () => runs.find((run) => !terminalRunStatuses.has(run.status)) ?? null,
    [runs],
  );

  const mergeRun = useCallback((run: AgentRun) => {
    setRuns((current) =>
      [run, ...current.filter((item) => item.id !== run.id)].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      ),
    );
  }, []);

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const refreshRuns = useCallback(async (agentId: string) => {
    const result = await api.runs(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setRuns(result.runs);
      setSelectedRunId((current) =>
        current && result.runs.some((run) => run.id === current)
          ? current
          : (result.runs[0]?.id ?? null),
      );
    }
    return result.runs;
  }, []);

  const loadTrace = useCallback(
    async (runId: string) => {
      setTraceLoading(true);
      try {
        const result = await api.runTrace(runId);
        if (mountedRef.current && selectedRunIdRef.current === runId) {
          setTrace(result);
          mergeRun(result.run);
        }
      } finally {
        if (mountedRef.current && selectedRunIdRef.current === runId) {
          setTraceLoading(false);
        }
      }
    },
    [mergeRun],
  );

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  const pollRun = useCallback(
    async (runId: string, agentId: string) => {
      if (pollingRunIds.current.has(runId)) return;
      pollingRunIds.current.add(runId);
      try {
        while (mountedRef.current) {
          await new Promise((resolve) => window.setTimeout(resolve, 900));
          if (!mountedRef.current) return;
          const result = await api.run(runId);
          mergeRun(result.run);
          if (selectedRunIdRef.current === runId) {
            const traceResult = await api.runTrace(runId);
            if (mountedRef.current && selectedRunIdRef.current === runId) {
              setTrace(traceResult);
            }
          }
          if (terminalRunStatuses.has(result.run.status)) {
            await Promise.all([refreshMessages(agentId), refreshAgents(), refreshRuns(agentId)]);
            return;
          }
        }
      } finally {
        pollingRunIds.current.delete(runId);
      }
    },
    [mergeRun, refreshAgents, refreshMessages, refreshRuns],
  );

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setShowSettings(false);
    setShowTraceDrawer(false);
    setTrace(null);
    setRetryOfRunId(null);
    if (!selectedId) {
      setMessages([]);
      setRuns([]);
      setSelectedRunId(null);
      return;
    }
    void Promise.all([refreshMessages(selectedId), refreshRuns(selectedId)])
      .then(([, nextRuns]) => {
        const latest = nextRuns[0] ?? null;
        if (latest && !terminalRunStatuses.has(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [pollRun, refreshMessages, refreshRuns, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  useEffect(() => {
    if (!selectedRunId) {
      setTrace(null);
      setTraceLoading(false);
      return;
    }
    void loadTrace(selectedRunId).catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [loadTrace, selectedRunId]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    const retrySourceRunId = retryOfRunId;
    setPrompt("");
    setRetryOfRunId(null);
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content, retrySourceRunId);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        mergeRun(result.run);
        setSelectedRunId(result.run.id);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      void pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await refreshAgents();
    }
  };

  const beginRetry = useCallback((run: AgentRun) => {
    setPrompt(run.prompt);
    setRetryOfRunId(run.id);
    setSelectedRunId(run.id);
    window.requestAnimationFrame(() => {
      const element = document.querySelector(".composer textarea") as HTMLTextAreaElement | null;
      element?.focus();
      element?.setSelectionRange(element.value.length, element.value.length);
    });
  }, []);

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">AgentTrace</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">AgentTrace</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open AgentTrace"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>AgentTrace</strong>
            <span>Glass Box middleware</span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                  {runs[0] ? <RunPill run={runs[0]} trace={trace?.run.id === runs[0].id ? trace : null} /> : null}
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button className="button button-ghost trace-toggle" onClick={() => setShowTraceDrawer(true)}>
                  Trace
                </button>
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button className="button button-ghost" onClick={toggleAgent} disabled={busy}>
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <div className="workspace-grid">
              <section className="playground">
                <div className="playground-topbar">
                  <div>
                    <span className="eyebrow">Playground</span>
                    <h2>Build something with your Agent</h2>
                  </div>
                  <div className="session-info">
                    <span className="pulse" />
                    {selected.codexThreadId ? "Session connected" : "New session"}
                  </div>
                </div>

                <div className="messages">
                  {messages.length === 0 && !activeRun ? (
                    <div className="welcome">
                      <div className="welcome-orbit">
                        <div>⌁</div>
                      </div>
                      <h3>What should {selected.name} build?</h3>
                      <p>
                        The Agent can inspect files, write code, run commands, and continue the
                        same Codex session across messages.
                      </p>
                      <div className="prompt-grid">
                        {starterPrompts.map((item) => (
                          <button key={item} onClick={() => setPrompt(item)}>
                            <span>↗</span>
                            {item}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    messages.map((message) => (
                      <article className={"message message-" + message.role} key={message.id}>
                        <div className="message-meta">
                          <strong>{message.role === "user" ? "You" : selected.name}</strong>
                          <span>{formatTime(message.createdAt)}</span>
                        </div>
                        <div className="message-body">{message.content}</div>
                      </article>
                    ))
                  )}
                  {activeRun && !terminalRunStatuses.has(activeRun.status) && (
                    <article className="message message-assistant thinking">
                      <div className="message-meta">
                        <strong>{selected.name}</strong>
                        <span>working in the Agent workspace</span>
                      </div>
                      <div className="thinking-row">
                        <Spinner />
                        Codex is reading, editing, or running commands…
                      </div>
                    </article>
                  )}
                  {runs[0]?.status === "failed" && (
                    <article className="run-error">
                      <strong>Run failed</strong>
                      <span>{runs[0].error}</span>
                    </article>
                  )}
                  <div ref={messageEnd} />
                </div>

                <form className="composer" onSubmit={sendMessage}>
                  {retryOfRunId ? (
                    <div className="retry-banner">
                      <strong>Retry prepared</strong>
                      <span>This next run will be linked to the selected failed attempt.</span>
                      <button type="button" className="trace-inline-button" onClick={() => setRetryOfRunId(null)}>
                        Clear
                      </button>
                    </div>
                  ) : null}
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder={
                      selected.status === "stopped"
                        ? "Start this Agent to continue…"
                        : "Describe what you want the Agent to do…"
                    }
                    disabled={
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun !== null && !terminalRunStatuses.has(activeRun.status))
                    }
                    rows={3}
                  />
                  <div className="composer-footer">
                    <span>
                      Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                    </span>
                    <button
                      className="send-button"
                      disabled={
                        !prompt.trim() ||
                        selected.status === "stopped" ||
                        selected.status === "busy" ||
                        (activeRun !== null && !terminalRunStatuses.has(activeRun.status))
                      }
                      aria-label="Send message"
                    >
                      ↑
                    </button>
                  </div>
                </form>
              </section>

              <TraceInspector
                runs={runs}
                selectedRunId={selectedRunId}
                onSelectRun={setSelectedRunId}
                trace={trace}
                loading={traceLoading}
                onRetryRun={beginRetry}
              />
            </div>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">AgentTrace</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and inspect the trace here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showTraceDrawer && selected ? (
        <div className="trace-drawer-backdrop" onMouseDown={() => setShowTraceDrawer(false)}>
          <div className="trace-drawer" onMouseDown={(event) => event.stopPropagation()}>
            <TraceInspector
              runs={runs}
              selectedRunId={selectedRunId}
              onSelectRun={setSelectedRunId}
              trace={trace}
              loading={traceLoading}
              onRetryRun={beginRetry}
              onClose={() => setShowTraceDrawer(false)}
            />
          </div>
        </div>
      ) : null}

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
