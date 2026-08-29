import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent, AgentRun, Database, DatabaseV1, DatabaseV2, TraceEvent } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 3,
  agents: [],
  messages: [],
  runs: [],
  traceEvents: [],
});

function legacySessionId(agentId: string): string {
  return "legacy-session-" + agentId;
}

function legacyTraceId(runId: string): string {
  return "legacy-trace-" + runId;
}

function legacySpanId(eventId: string): string {
  return "legacy-span-" + eventId;
}

function migrateAgent(agent: DatabaseV1["agents"][number] | DatabaseV2["agents"][number]): Agent {
  return {
    ...agent,
    sessionId: legacySessionId(agent.id),
  };
}

function migrateRun(
  run: DatabaseV1["runs"][number] | DatabaseV2["runs"][number],
  agentSessionId: string,
): AgentRun {
  return {
    ...run,
    traceId: legacyTraceId(run.id),
    sessionId: agentSessionId,
    agentVersion: "1.0.0",
    retryOfRunId: null,
    attempt: 1,
  };
}

function migrateTraceEvent(
  event: DatabaseV2["traceEvents"][number],
  migratedRun: AgentRun | undefined,
): TraceEvent {
  return {
    ...event,
    traceId: migratedRun?.traceId ?? legacyTraceId(event.runId),
    spanId: legacySpanId(event.id),
    parentSpanId: null,
    sessionId: migratedRun?.sessionId ?? legacySessionId(event.agentId),
    agentVersion: migratedRun?.agentVersion ?? "1.0.0",
    actorType: event.kind === "message" ? "human" : "agent",
    metadata: null,
  };
}

function migrateDatabase(parsed: Database | DatabaseV2 | DatabaseV1): Database {
  if (parsed.version === 3 && Array.isArray(parsed.traceEvents)) {
    return parsed;
  }

  if (parsed.version === 2 && Array.isArray(parsed.traceEvents)) {
    const agents = parsed.agents.map(migrateAgent);
    const sessionByAgentId = new Map(agents.map((agent) => [agent.id, agent.sessionId]));
    const runs = parsed.runs.map((run) => migrateRun(run, sessionByAgentId.get(run.agentId) ?? legacySessionId(run.agentId)));
    const runById = new Map(runs.map((run) => [run.id, run]));
    return {
      version: 3,
      agents,
      messages: parsed.messages,
      runs,
      traceEvents: parsed.traceEvents.map((event) => migrateTraceEvent(event, runById.get(event.runId))),
    };
  }

  if (parsed.version === 1 && Array.isArray(parsed.agents)) {
    const agents = parsed.agents.map(migrateAgent);
    const sessionByAgentId = new Map(agents.map((agent) => [agent.id, agent.sessionId]));
    return {
      version: 3,
      agents,
      messages: parsed.messages,
      runs: parsed.runs.map((run) => migrateRun(run, sessionByAgentId.get(run.agentId) ?? legacySessionId(run.agentId))),
      traceEvents: [],
    };
  }

  throw new Error("Unsupported database format");
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.data = migrateDatabase(JSON.parse(raw) as Database | DatabaseV2 | DatabaseV1);
      if (!raw.includes('"version": 3') || !raw.includes('"sessionId"') || !raw.includes('"traceId"')) {
        await this.persist(this.data);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
