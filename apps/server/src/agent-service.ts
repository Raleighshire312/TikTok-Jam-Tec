import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { Redactor } from "./redaction.js";
import { JsonStore } from "./store.js";
import { diagnoseTrace, isTraceFailureEvent, summarizeFirstFailure } from "./trace-diagnosis.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  RunTrace,
  RunnerObserver,
  RunnerTraceEventInput,
  SendMessageInput,
  TraceEvent,
  TraceEventDetail,
  TraceKind,
  TraceSpanMetadata,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

function rootSpanId(runId: string): string {
  return runId + ":root";
}

function modelSpanId(runId: string): string {
  return runId + ":model";
}

function messageSpanId(messageId: string): string {
  return "message:" + messageId;
}

function mergeTraceDetail(
  current: TraceEventDetail | null,
  next: TraceEventDetail | null,
): TraceEventDetail | null {
  if (!current) return next;
  if (!next) return current;
  return { ...current, ...next };
}

function mergeTraceMetadata(
  current: TraceSpanMetadata | null,
  next: TraceSpanMetadata | null,
): TraceSpanMetadata | null {
  if (!current) return next;
  if (!next) return current;
  return { ...current, ...next };
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly redactor: Redactor;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
  ) {
    this.redactor = new Redactor(config);
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      const completedAt = now();
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = completedAt;
        }
      }
      for (const event of database.traceEvents) {
        if (!event.completedAt && (event.status === "queued" || event.status === "running")) {
          event.status = "cancelled";
          event.completedAt = completedAt;
          event.durationMs =
            event.startedAt === null ? null : Date.parse(completedAt) - Date.parse(event.startedAt);
          event.detail = mergeTraceDetail(event.detail, {
            note: "Server restarted before this step finished",
          });
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = completedAt;
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      sessionId: randomUUID(),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
      database.traceEvents = database.traceEvents.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getTrace(runId: string): RunTrace {
    const snapshot = this.store.snapshot();
    const run = snapshot.runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    const traceEvents = snapshot.traceEvents
      .filter((event) => event.runId === runId)
      .sort((left, right) => left.sequence - right.sequence);
    const usage = traceEvents
      .map((event) => event.usage)
      .filter((value): value is NonNullable<typeof value> => value !== null)
      .at(-1);
    const failedSteps = traceEvents.filter(
      (event) => event.kind !== "lifecycle" && isTraceFailureEvent(event),
    ).length;
    const redactionCount = traceEvents.filter((event) => event.redacted).length;
    return {
      run,
      traceEvents,
      summary: {
        durationMs:
          run.startedAt && run.completedAt
            ? Date.parse(run.completedAt) - Date.parse(run.startedAt)
            : null,
        stepCount: traceEvents.filter((event) => event.kind !== "lifecycle").length,
        failedSteps,
        redactionCount,
        inputTokens: usage?.inputTokens ?? run.usage?.inputTokens ?? null,
        cachedInputTokens: usage?.cachedInputTokens ?? run.usage?.cachedInputTokens ?? null,
        outputTokens: usage?.outputTokens ?? run.usage?.outputTokens ?? null,
        diagnosis: diagnoseTrace(run, traceEvents),
        firstFailure: summarizeFirstFailure(run, traceEvents),
      },
    };
  }

  async sendMessage(
    agentId: string,
    prompt: string,
    retryOfRunId: string | null = null,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }

    const redactedPrompt = this.redactor.redactText(prompt.trim());
    let run!: AgentRun;
    let message!: Message;
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }

      let retryAttempt = 1;
      if (retryOfRunId) {
        const retryRun = database.runs.find((item) => item.id === retryOfRunId);
        if (!retryRun || retryRun.agentId !== agentId) {
          throw new HttpError(404, "Retry source run not found for this Agent");
        }
        if (retryRun.status === "queued" || retryRun.status === "running") {
          throw new HttpError(409, "Finish the referenced run before retrying it");
        }
        retryAttempt = retryRun.attempt + 1;
      }

      const timestamp = now();
      run = {
        id: randomUUID(),
        agentId,
        traceId: randomUUID(),
        sessionId: storedAgent.sessionId,
        agentVersion: this.config.agentVersion,
        retryOfRunId,
        attempt: retryAttempt,
        status: "queued",
        prompt: redactedPrompt.value,
        output: null,
        error: null,
        usage: null,
        startedAt: null,
        completedAt: null,
        createdAt: timestamp,
      };
      message = {
        id: randomUUID(),
        agentId,
        runId: run.id,
        role: "user",
        content: redactedPrompt.value,
        createdAt: timestamp,
      };
      database.runs.push(run);
      database.messages.push(message);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;

      this.appendTraceEvent(database, run.id, {
        source: "service",
        kind: "lifecycle",
        status: "queued",
        label: "Run",
        spanId: rootSpanId(run.id),
        actorType: "agent",
        metadata: this.buildRuntimeMetadata(storedAgent.codexThreadId),
      });
      this.appendTraceEvent(database, run.id, {
        source: "service",
        kind: "message",
        status: "completed",
        label: "User message",
        spanId: messageSpanId(message.id),
        parentSpanId: rootSpanId(run.id),
        actorType: "human",
        startedAt: timestamp,
        completedAt: timestamp,
        detail: { text: redactedPrompt.value },
      });
      return structuredClone(storedAgent);
    });

    const execution = this.executeRun(agentAtStart, run, prompt.trim());
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container" ? this.config.containerEngine : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun, rawPrompt: string): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (!storedRun) return;
      storedRun.status = "running";
      storedRun.startedAt = now();
      this.appendTraceEvent(database, run.id, {
        source: "service",
        kind: "lifecycle",
        status: "running",
        label: "Run",
        spanId: rootSpanId(run.id),
        actorType: "agent",
        startedAt: storedRun.startedAt,
        metadata: this.buildRuntimeMetadata(agentAtStart.codexThreadId),
      });
      this.appendTraceEvent(database, run.id, {
        source: "service",
        kind: "model_call",
        status: "running",
        label: "Model call",
        spanId: modelSpanId(run.id),
        parentSpanId: rootSpanId(run.id),
        actorType: "agent",
        startedAt: storedRun.startedAt,
        metadata: this.buildRuntimeMetadata(agentAtStart.codexThreadId),
      });
    });

    let traceQueue = Promise.resolve();
    const observer: RunnerObserver = {
      onEvent: (event) => {
        traceQueue = traceQueue.then(() => this.recordTraceEvent(run.id, event));
        return traceQueue;
      },
    };

    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run(
        {
          runId: run.id,
          agentId: agentAtStart.id,
          workspacePath: agentAtStart.workspacePath,
          prompt: rawPrompt,
          threadId: agentAtStart.codexThreadId,
        },
        observer,
      );
      await traceQueue;
      const completedAt = now();
      const redactedOutput = this.redactor.redactText(result.output);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = redactedOutput.value;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: redactedOutput.value,
          createdAt: completedAt,
        });
        this.closeOpenTraceEvents(database, run.id, "completed", completedAt, "Run completed");
        this.appendTraceEvent(database, run.id, {
          source: "service",
          kind: "lifecycle",
          status: "completed",
          label: "Run",
          spanId: rootSpanId(run.id),
          actorType: "agent",
          completedAt,
          metadata: this.buildRuntimeMetadata(result.threadId),
          usage: result.usage
            ? {
                ...result.usage,
                totalTokens: (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
              }
            : null,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      await traceQueue.catch(() => undefined);
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      const redactedError = this.redactor.redactText(message);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = redactedError.value;
          storedRun.completedAt = completedAt;
        }
        this.closeOpenTraceEvents(
          database,
          run.id,
          cancelled ? "cancelled" : "failed",
          completedAt,
          redactedError.value,
        );
        this.appendTraceEvent(database, run.id, {
          source: "service",
          kind: "lifecycle",
          status: cancelled ? "cancelled" : "failed",
          label: "Run",
          spanId: rootSpanId(run.id),
          actorType: "agent",
          completedAt,
          detail: { error: redactedError.value },
          metadata: this.buildRuntimeMetadata(agent?.codexThreadId ?? agentAtStart.codexThreadId),
        });
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : redactedError.value;
          agent.updatedAt = completedAt;
        }
      });
    }
  }

  private async recordTraceEvent(runId: string, event: RunnerTraceEventInput): Promise<void> {
    await this.store.mutate((database) => {
      this.appendTraceEvent(database, runId, event);
    });
  }

  private appendTraceEvent(
    database: {
      runs: AgentRun[];
      traceEvents: TraceEvent[];
    },
    runId: string,
    event: RunnerTraceEventInput,
  ): void {
    const run = database.runs.find((item) => item.id === runId);
    if (!run) return;

    const spanId = event.spanId ?? randomUUID();
    const startedAt = event.startedAt ?? (event.status === "running" ? now() : null);
    const completedAt =
      event.completedAt ??
      (event.status === "completed" || event.status === "failed" || event.status === "cancelled"
        ? now()
        : null);
    const sanitizedDetail = this.sanitizeTraceDetail(event.kind, event.detail ?? null);
    const sanitizedMetadata = this.sanitizeTraceMetadata(event.metadata ?? null);
    const existing = database.traceEvents.find(
      (item) => item.runId === runId && item.spanId === spanId,
    );

    if (existing) {
      existing.source = event.source;
      existing.kind = event.kind;
      existing.status = event.status;
      existing.label = event.label;
      existing.parentSpanId = event.parentSpanId ?? existing.parentSpanId;
      existing.actorType = event.actorType ?? existing.actorType;
      existing.itemId = event.itemId ?? existing.itemId;
      existing.startedAt = existing.startedAt ?? startedAt;
      existing.completedAt = completedAt ?? existing.completedAt;
      existing.durationMs =
        event.durationMs ??
        (existing.startedAt && existing.completedAt
          ? Date.parse(existing.completedAt) - Date.parse(existing.startedAt)
          : existing.durationMs);
      existing.detail = mergeTraceDetail(existing.detail, sanitizedDetail.value);
      existing.usage = event.usage ?? existing.usage;
      existing.metadata = mergeTraceMetadata(existing.metadata, sanitizedMetadata.value);
      existing.redacted = existing.redacted || sanitizedDetail.redacted || sanitizedMetadata.redacted;
      return;
    }

    database.traceEvents.push({
      id: randomUUID(),
      runId,
      agentId: run.agentId,
      traceId: run.traceId,
      spanId,
      parentSpanId: event.parentSpanId ?? null,
      sessionId: run.sessionId,
      agentVersion: run.agentVersion,
      actorType: event.actorType ?? "agent",
      metadata: sanitizedMetadata.value,
      sequence:
        database.traceEvents.reduce(
          (max, item) => (item.runId === runId ? Math.max(max, item.sequence) : max),
          0,
        ) + 1,
      source: event.source,
      kind: event.kind,
      status: event.status,
      label: event.label,
      itemId: event.itemId ?? null,
      startedAt,
      completedAt,
      durationMs:
        event.durationMs ??
        (startedAt && completedAt ? Date.parse(completedAt) - Date.parse(startedAt) : null),
      detail: sanitizedDetail.value,
      usage: event.usage ?? null,
      redacted: sanitizedDetail.redacted || sanitizedMetadata.redacted,
      createdAt: now(),
    });
  }

  private closeOpenTraceEvents(
    database: {
      traceEvents: TraceEvent[];
    },
    runId: string,
    status: "completed" | "failed" | "cancelled",
    completedAt: string,
    note: string,
  ): void {
    for (const event of database.traceEvents) {
      if (
        event.runId === runId &&
        !event.completedAt &&
        (event.status === "queued" || event.status === "running")
      ) {
        event.status = status;
        event.completedAt = completedAt;
        event.durationMs =
          event.startedAt === null ? null : Date.parse(completedAt) - Date.parse(event.startedAt);
        event.detail = mergeTraceDetail(event.detail, { note });
      }
    }
  }

  private buildRuntimeMetadata(providerSessionId: string | null): TraceSpanMetadata {
    return {
      providerSessionId,
      arkBaseUrl: this.config.arkBaseUrl,
      arkModelId: this.config.arkModel || null,
      runtimeProvider: this.config.runtimeProvider,
      sandboxMode: this.config.codexSandboxMode,
      runtimeInstanceId: this.config.runtimeInstanceId,
      containerEngine: this.config.runtimeProvider === "container" ? this.config.containerEngine : null,
      containerImage:
        this.config.runtimeProvider === "container" ? this.config.containerRuntimeImage : null,
      platform: process.platform,
      architecture: process.arch,
    };
  }

  private sanitizeTraceDetail(
    kind: TraceKind,
    detail: TraceEventDetail | null,
  ): { value: TraceEventDetail | null; redacted: boolean } {
    if (!detail) return { value: null, redacted: false };
    let redacted = false;
    const next: TraceEventDetail = {};

    const assignText = (key: keyof TraceEventDetail, value: string | undefined) => {
      if (value === undefined) return;
      const result = this.redactor.redactText(value);
      (next as Record<string, string | number | undefined>)[key] = result.value;
      redacted = redacted || result.redacted;
    };

    if (kind === "reasoning") {
      next.note = "Reasoning step observed";
      return { value: next, redacted: false };
    }

    assignText("text", detail.text);
    assignText("command", detail.command);
    if (typeof detail.exitCode === "number") next.exitCode = detail.exitCode;
    assignText("filePath", detail.filePath);
    assignText("changeType", detail.changeType);
    assignText("toolName", detail.toolName);
    assignText("query", detail.query);
    assignText("error", detail.error);
    assignText("note", detail.note);

    return {
      value: Object.keys(next).length > 0 ? next : null,
      redacted,
    };
  }

  private sanitizeTraceMetadata(
    metadata: TraceSpanMetadata | null,
  ): { value: TraceSpanMetadata | null; redacted: boolean } {
    if (!metadata) return { value: null, redacted: false };
    let redacted = false;
    const next: TraceSpanMetadata = {};

    const assign = (key: keyof TraceSpanMetadata, value: string | null | undefined) => {
      if (value === undefined) return;
      if (value === null) {
        (next as Record<string, string | null | undefined>)[key] = null;
        return;
      }
      const result = this.redactor.redactText(value);
      (next as Record<string, string | null | undefined>)[key] = result.value;
      redacted = redacted || result.redacted;
    };

    assign("providerSessionId", metadata.providerSessionId);
    assign("arkBaseUrl", metadata.arkBaseUrl);
    assign("arkModelId", metadata.arkModelId);
    if (metadata.runtimeProvider !== undefined) next.runtimeProvider = metadata.runtimeProvider;
    assign("sandboxMode", metadata.sandboxMode);
    assign("runtimeInstanceId", metadata.runtimeInstanceId);
    assign("containerEngine", metadata.containerEngine);
    assign("containerImage", metadata.containerImage);
    assign("toolName", metadata.toolName);
    assign("platform", metadata.platform);
    assign("architecture", metadata.architecture);

    return {
      value: Object.keys(next).length > 0 ? next : null,
      redacted,
    };
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
