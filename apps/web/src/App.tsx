import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bot,
  Clock3,
  Eye,
  FilePenLine,
  Search,
  ShieldAlert,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import { api, ApiError, setAuthToken } from "./api";
import type {
  Agent,
  AgentRun,
  Message,
  RunTrace,
  SystemInfo,
  TraceEvent,
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
  if (event.status === "failed") return "failed";
  if (event.status === "cancelled") return "cancelled";
  if (event.status === "completed") return "completed";
  if (event.status === "running") return "running";
  return "queued";
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
  onClose,
}: {
  runs: AgentRun[];
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
  trace: RunTrace | null;
  loading: boolean;
  onClose?: () => void;
}) {
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;
  const traceForRun = trace && trace.run.id === selectedRunId ? trace : null;

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
              <strong>{traceForRun?.summary.outputTokens ?? selectedRun.usage?.outputTokens ?? 0}</strong>
            </div>
            <div className="trace-metric">
              <span>Redactions</span>
              <strong>{traceForRun?.summary.redactionCount ?? 0}</strong>
            </div>
          </div>

          <div className="trace-section-title">
            <span>Timeline</span>
            <span>{traceForRun?.traceEvents.length ?? 0}</span>
          </div>
          <div className="trace-timeline">
            {!traceForRun && loading ? (
              <div className="trace-empty">Loading run trace…</div>
            ) : traceForRun && traceForRun.traceEvents.length > 0 ? (
              traceForRun.traceEvents.map((event) => (
                <article className={"trace-event trace-event-" + traceTone(event)} key={event.id}>
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
                    </div>
                    <details className="trace-event-detail">
                      <summary>{eventSummary(event)}</summary>
                      <div>{eventSummary(event)}</div>
                    </details>
                  </div>
                </article>
              ))
            ) : (
              <div className="trace-empty">No runtime trace is available for this run yet.</div>
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
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
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
