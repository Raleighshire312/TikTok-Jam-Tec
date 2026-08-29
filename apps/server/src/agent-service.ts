import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { Redactor } from "./redaction.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  RunnerObserver,
  RunnerTraceEventInput,
  TraceEvent,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

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
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const event of database.traceEvents) {
        if (!event.completedAt && (event.status === "queued" || event.status === "running")) {
          event.status = "cancelled";
          event.completedAt = now();
          event.durationMs =
            event.startedAt === null
              ? null
              : Date.parse(event.completedAt) - Date.parse(event.startedAt);
          event.detail = {
            ...(event.detail ?? {}),
            note: "Server restarted before this step finished",
          };
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
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

  getTrace(runId: string): { run: AgentRun; traceEvents: TraceEvent[]; summary: Record<string, number | null> } {
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
      (event) =>
        event.kind !== "lifecycle" &&
        (event.status === "failed" || event.status === "cancelled"),
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
      },
    };
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const redactedPrompt = this.redactor.redactText(prompt);
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt: redactedPrompt.value,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: redactedPrompt.value,
      createdAt: timestamp,
    };
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
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      this.appendTraceEvent(database, runId, agentId, {
        source: "service",
        kind: "lifecycle",
        status: "queued",
        label: "Run queued",
        detail: { text: redactedPrompt.value },
      });
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run, prompt);
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
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun, rawPrompt: string): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
        this.appendTraceEvent(database, run.id, run.agentId, {
          source: "service",
          kind: "lifecycle",
          status: "running",
          label: "Run started",
          startedAt: storedRun.startedAt,
        });
      }
    });
    let traceQueue = Promise.resolve();
    const observer: RunnerObserver = {
      onEvent: (event) => {
        traceQueue = traceQueue.then(() => this.recordTraceEvent(run.id, run.agentId, event));
        return traceQueue;
      },
    };
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        runId: run.id,
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: rawPrompt,
        threadId: agentAtStart.codexThreadId,
      }, observer);
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
        this.appendTraceEvent(database, run.id, run.agentId, {
          source: "service",
          kind: "lifecycle",
          status: "completed",
          label: "Run completed",
          completedAt,
          usage: result.usage
            ? {
                ...result.usage,
                totalTokens:
                  (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
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
        this.appendTraceEvent(database, run.id, run.agentId, {
          source: "service",
          kind: "lifecycle",
          status: cancelled ? "cancelled" : "failed",
          label: cancelled ? "Run cancelled" : "Run failed",
          completedAt,
          detail: { error: redactedError.value },
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

  private async recordTraceEvent(
    runId: string,
    agentId: string,
    event: RunnerTraceEventInput,
  ): Promise<void> {
    await this.store.mutate((database) => {
      this.appendTraceEvent(database, runId, agentId, event);
    });
  }

  private appendTraceEvent(
    database: {
      traceEvents: TraceEvent[];
    },
    runId: string,
    agentId: string,
    event: RunnerTraceEventInput,
  ): void {
    const startedAt = event.startedAt ?? (event.status === "running" ? now() : null);
    const completedAt =
      event.completedAt ??
      (event.status === "completed" || event.status === "failed" || event.status === "cancelled"
        ? now()
        : null);
    const redactedDetail = this.redactor.redactUnknown(event.detail ?? null);
    database.traceEvents.push({
      id: randomUUID(),
      runId,
      agentId,
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
      detail: redactedDetail.value,
      usage: event.usage ?? null,
      redacted: redactedDetail.redacted,
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
        event.detail = { ...(event.detail ?? {}), note };
      }
    }
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
