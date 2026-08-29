import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import type {
  AgentRunner,
  RunnerObserver,
  RunnerRequest,
  RunnerResult,
  RunUsage,
  TraceEventDetail,
  TraceKind,
  TraceSpanMetadata,
  TraceStatus,
} from "./types.js";

const execFileAsync = promisify(execFile);

function operationSpanId(runId: string, suffix: string): string {
  return runId + ":" + suffix;
}

export interface ParsedEvents {
  runId: string;
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
  observer: RunnerObserver | null;
  items: Map<
    string,
    {
      spanId: string;
      kind: TraceKind;
      label: string;
      startedAt: string;
      detail: TraceEventDetail | null;
      metadata: TraceSpanMetadata | null;
    }
  >;
}

function eventTimestamp(): string {
  return new Date().toISOString();
}

function usageFromObject(usage: Record<string, unknown>): RunUsage {
  return {
    ...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
    ...(typeof usage.cached_input_tokens === "number"
      ? { cachedInputTokens: usage.cached_input_tokens }
      : {}),
    ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
  };
}

function compactDetail(detail: Record<string, unknown>): TraceEventDetail | null {
  const entries = Object.entries(detail).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as TraceEventDetail) : null;
}

function emit(parsed: ParsedEvents, event: Parameters<NonNullable<RunnerObserver["onEvent"]>>[0]) {
  void parsed.observer?.onEvent(event);
}

function itemIdFor(item: Record<string, unknown>, event: Record<string, unknown>): string | null {
  if (typeof item.id === "string") return item.id;
  if (typeof event.item_id === "string") return event.item_id;
  return null;
}

function mapItemKind(type: string): TraceKind {
  if (type === "command_execution") return "command";
  if (type === "file_change") return "file_change";
  if (type.includes("mcp") || type.includes("tool")) return "tool_call";
  if (type.includes("search")) return "web_search";
  if (type === "agent_message") return "message";
  if (type.includes("reason")) return "reasoning";
  return "unknown";
}

function itemLabel(type: string, item: Record<string, unknown>): string {
  if (type === "command_execution") return "Command";
  if (type === "file_change") return "File change";
  if (type === "agent_message") return "Assistant message";
  if (type.includes("reason")) return "Reasoning step observed";
  if (type.includes("mcp") || type.includes("tool")) {
    return typeof item.name === "string" ? item.name : "Tool call";
  }
  if (type.includes("search")) return "Web search";
  return type.replaceAll("_", " ");
}

function itemMetadata(type: string, item: Record<string, unknown>): TraceSpanMetadata | null {
  if (type.includes("mcp") || type.includes("tool")) {
    const toolName =
      typeof item.name === "string"
        ? item.name
        : typeof item.tool_name === "string"
          ? item.tool_name
          : null;
    return toolName ? { toolName } : null;
  }
  return null;
}

function itemDetail(type: string, item: Record<string, unknown>): TraceEventDetail | null {
  if (type === "command_execution") {
    return compactDetail({
      command:
        typeof item.command === "string"
          ? item.command
          : typeof item.cmd === "string"
            ? item.cmd
            : undefined,
      exitCode: typeof item.exit_code === "number" ? item.exit_code : undefined,
      text: typeof item.output === "string" ? item.output : undefined,
    });
  }
  if (type === "file_change") {
    return compactDetail({
      filePath:
        typeof item.path === "string"
          ? item.path
          : typeof item.file_path === "string"
            ? item.file_path
            : undefined,
      changeType:
        typeof item.change_type === "string"
          ? item.change_type
          : typeof item.kind === "string"
            ? item.kind
            : undefined,
    });
  }
  if (type.includes("mcp") || type.includes("tool")) {
    return compactDetail({
      toolName:
        typeof item.name === "string"
          ? item.name
          : typeof item.tool_name === "string"
            ? item.tool_name
            : undefined,
    });
  }
  if (type.includes("search")) {
    return compactDetail({
      query:
        typeof item.query === "string"
          ? item.query
          : typeof item.search_query === "string"
            ? item.search_query
            : undefined,
    });
  }
  if (type === "agent_message") {
    return typeof item.text === "string" ? { text: item.text } : null;
  }
  if (type.includes("reason")) {
    return { note: "Reasoning step observed" };
  }
  return null;
}

function itemStatus(eventType: string, item: Record<string, unknown>): TraceStatus {
  const raw = typeof item.status === "string" ? item.status : null;
  if (eventType === "item.started") return "running";
  if (raw === "failed") return "failed";
  if (raw === "cancelled") return "cancelled";
  if (raw === "completed" || eventType === "item.completed") {
    if (typeof item.exit_code === "number" && item.exit_code !== 0) return "failed";
    return "completed";
  }
  return "info";
}

export function buildCodexArgs(
  request: RunnerRequest,
  sandboxMode: AppConfig["codexSandboxMode"],
  workspacePath = request.workspacePath,
): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    sandboxMode,
    "--skip-git-repo-check",
    "-C",
    workspacePath,
  ];
  if (request.threadId) {
    args.push("resume", request.threadId, request.prompt);
  } else {
    args.push(request.prompt);
  }
  return args;
}

export function parseCodexEventLine(line: string, parsed: ParsedEvents): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    emit(parsed, {
      source: "codex",
      kind: "error",
      status: "failed",
      label: "Malformed event",
      spanId: operationSpanId(parsed.runId, "error:malformed"),
      actorType: "agent",
      detail: { error: "Codex emitted malformed JSON" },
    });
    return;
  }

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    parsed.threadId = event.thread_id;
    emit(parsed, {
      source: "codex",
      kind: "lifecycle",
      status: "info",
      label: "Codex session started",
      spanId: operationSpanId(parsed.runId, "session:" + event.thread_id),
      actorType: "agent",
      metadata: { providerSessionId: event.thread_id },
      detail: { note: "Codex thread attached" },
    });
  }

  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") {
      parsed.messages.push(item.text);
    }
  }

  if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
    const usage = event.usage as Record<string, unknown>;
    parsed.usage = usageFromObject(usage);
    emit(parsed, {
      source: "codex",
      kind: "model_call",
      status: "completed",
      label: "Model call",
      spanId: operationSpanId(parsed.runId, "model"),
      actorType: "agent",
      usage: {
        ...parsed.usage,
        totalTokens: (parsed.usage.inputTokens ?? 0) + (parsed.usage.outputTokens ?? 0),
      },
    });
  }

  if (event.type === "error") {
    const message =
      typeof event.message === "string"
        ? event.message
        : typeof event.error === "string"
          ? event.error
          : "Codex reported an unknown error";
    parsed.errors.push(message);
    emit(parsed, {
      source: "codex",
      kind: "error",
      status: "failed",
      label: "Runtime error",
      spanId: operationSpanId(parsed.runId, "error:" + parsed.errors.length),
      actorType: "agent",
      detail: { error: message },
    });
  }

  if (
    (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") &&
    event.item &&
    typeof event.item === "object"
  ) {
    const item = event.item as Record<string, unknown>;
    const type = typeof item.type === "string" ? item.type : "unknown";
    const itemId = itemIdFor(item, event);
    const kind = mapItemKind(type);
    const label = itemLabel(type, item);
    const detail = itemDetail(type, item);
    const status = itemStatus(String(event.type), item);
    const metadata = itemMetadata(type, item);
    const spanId = itemId ? operationSpanId(parsed.runId, "item:" + itemId) : operationSpanId(parsed.runId, "event:" + eventTimestamp());
    const started = itemId ? parsed.items.get(itemId) : null;
    const startedAt =
      started?.startedAt ??
      (typeof item.started_at === "string" ? item.started_at : eventTimestamp());

    if (event.type === "item.started" && itemId) {
      parsed.items.set(itemId, { spanId, kind, label, startedAt, detail, metadata });
    }

    if (event.type === "item.completed" && itemId) {
      parsed.items.delete(itemId);
    }

    emit(parsed, {
      source: "codex",
      kind,
      status,
      label,
      spanId: started?.spanId ?? spanId,
      parentSpanId: operationSpanId(parsed.runId, "root"),
      actorType: "agent",
      metadata: started?.metadata ?? metadata,
      itemId,
      startedAt: event.type === "item.started" ? startedAt : started?.startedAt ?? startedAt,
      completedAt:
        event.type === "item.completed"
          ? typeof item.completed_at === "string"
            ? item.completed_at
            : eventTimestamp()
          : null,
      durationMs:
        event.type === "item.completed"
          ? Date.parse(typeof item.completed_at === "string" ? item.completed_at : eventTimestamp()) -
            Date.parse(started?.startedAt ?? startedAt)
          : null,
      detail: started?.detail && detail ? { ...started.detail, ...detail } : (detail ?? started?.detail ?? null),
    });
  }
}

export function reconcileOpenTraceItems(
  parsed: ParsedEvents,
  status: "completed" | "failed" | "cancelled",
  note: string,
): void {
  const completedAt = eventTimestamp();
  for (const [itemId, item] of parsed.items.entries()) {
    emit(parsed, {
      source: "codex",
      kind: item.kind,
      status,
      label: item.label,
      spanId: item.spanId,
      parentSpanId: operationSpanId(parsed.runId, "root"),
      actorType: "agent",
      metadata: item.metadata,
      itemId,
      startedAt: item.startedAt,
      completedAt,
      durationMs: Date.parse(completedAt) - Date.parse(item.startedAt),
      detail: { ...(item.detail ?? {}), note },
    });
    parsed.items.delete(itemId);
  }
}

export class CodexRunner implements AgentRunner {
  private readonly active = new Map<
    string,
    {
      child: ChildProcess;
      cancelled: boolean;
      timedOut: boolean;
      outputExceeded: boolean;
      settled: Promise<void>;
      forceKillTimer: NodeJS.Timeout | null;
    }
  >();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.codexBin, ["--version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) {
      return false;
    }
    active.cancelled = true;
    this.terminate(active);
    await active.settled;
    return true;
  }

  async run(request: RunnerRequest, observer?: RunnerObserver): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Codex process");
    }

    const args = buildCodexArgs(request, this.config.codexSandboxMode);
    const child = spawn(this.config.codexBin, args, {
      cwd: request.workspacePath,
      env: this.childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active = {
      child,
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      forceKillTimer: null as NodeJS.Timeout | null,
    };
    this.active.set(request.agentId, active);

    const parsed: ParsedEvents = {
      runId: request.runId,
      messages: [],
      threadId: request.threadId,
      usage: null,
      errors: [],
      observer: observer ?? null,
      items: new Map(),
    };
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        this.terminate(active);
        return;
      }
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          parseCodexEventLine(line, parsed);
        }
      } else {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) {
          stderr = stderr.slice(-16_384);
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      this.terminate(active);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (stdout.trim()) {
        parseCodexEventLine(stdout.trim(), parsed);
      }
      if (active.cancelled) {
        reconcileOpenTraceItems(parsed, "cancelled", "Run cancelled");
        throw new RunCancelledError();
      }
      if (active.timedOut) {
        reconcileOpenTraceItems(parsed, "failed", "Run timed out");
        throw new Error("Codex timed out after " + this.config.codexTimeoutMs + " ms");
      }
      if (active.outputExceeded) {
        reconcileOpenTraceItems(parsed, "failed", "Run exceeded output limit");
        throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
      }
      if (exitCode !== 0) {
        reconcileOpenTraceItems(parsed, "failed", "Runtime process exited early");
        const detail = parsed.errors.at(-1) ?? stderr.trim() ?? "No error detail";
        throw new Error("Codex exited with code " + exitCode + ": " + detail);
      }
      reconcileOpenTraceItems(parsed, "completed", "Step completed when runtime exited");
      const output = parsed.messages.at(-1)?.trim();
      if (!output) {
        throw new Error("Codex completed without an agent message");
      }
      return {
        output,
        threadId: parsed.threadId,
        usage: parsed.usage,
      };
    } finally {
      clearTimeout(timeout);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.active.delete(request.agentId);
    }
  }

  private terminate(active: {
    child: ChildProcess;
    forceKillTimer: NodeJS.Timeout | null;
  }): void {
    if (active.child.exitCode !== null || active.child.signalCode !== null) return;
    active.child.kill("SIGTERM");
    if (!active.forceKillTimer) {
      active.forceKillTimer = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
      active.forceKillTimer.unref();
    }
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const inheritedNames = [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "TERM",
    ] as const;
    const environment: NodeJS.ProcessEnv = {
      CODEX_HOME: this.config.codexHome,
      ARK_API_KEY: this.config.arkApiKey,
      NO_COLOR: "1",
    };
    for (const name of inheritedNames) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
