import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type {
  AgentRunner,
  RunnerObserver,
  RunnerRequest,
  RunnerResult,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest, observer?: RunnerObserver): Promise<RunnerResult> {
    await observer?.onEvent({
      source: "codex",
      kind: "command",
      status: "completed",
      label: "Command",
      itemId: "cmd-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
      detail: { command: "echo ARK_API_KEY=test-key", text: "done" },
    });
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

async function makeServiceWithConfig(
  environment: NodeJS.ProcessEnv,
  runner: AgentRunner = new FakeRunner(),
): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ...environment,
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const storedRun = service.getRun(run.id);
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
    expect(storedRun.traceId).toBeTruthy();
    expect(storedRun.sessionId).toBe(agent.sessionId);
    expect(storedRun.attempt).toBe(1);
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("stores redacted run, message, and trace data", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(
      agent.id,
      "use ARK_API_KEY=test-key and bearer Bearer abcdefghijklmnop",
    );
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getRun(run.id).prompt).toContain("[REDACTED]");
    expect(service.getMessages(agent.id).every((message) => !message.content.includes("test-key"))).toBe(
      true,
    );
    const trace = service.getTrace(run.id);
    expect(trace.traceEvents.some((event) => event.redacted)).toBe(true);
    expect(JSON.stringify(trace)).not.toContain("test-key");
  });

  it("returns ordered trace events and summary metrics", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Tracer" });
    const { run } = await service.sendMessage(agent.id, "build a cli");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const trace = service.getTrace(run.id);
    expect(trace.traceEvents.length).toBeGreaterThanOrEqual(3);
    expect(trace.traceEvents.map((event) => event.sequence)).toEqual(
      [...trace.traceEvents.map((event) => event.sequence)].sort((a, b) => a - b),
    );
    expect(trace.summary.stepCount).toBeGreaterThan(0);
    expect(trace.summary.diagnosis.severity).toBe("success");
    expect(
      trace.summary.diagnosis.evidenceEventId === null ||
        trace.traceEvents.some(
          (event) =>
            event.id === trace.summary.diagnosis.evidenceEventId ||
            event.spanId === trace.summary.diagnosis.evidenceEventId,
        ),
    ).toBe(true);
    expect(trace.summary.firstFailure).toBeNull();
  });

  it("links retries to a terminal run and increments the attempt number", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Retry" });
    const first = await service.sendMessage(agent.id, "inspect the repo");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");

    const retried = await service.sendMessage(agent.id, "inspect the repo again", first.run.id);
    await expect.poll(() => service.getRun(retried.run.id).status).toBe("completed");

    expect(service.getRun(retried.run.id)).toMatchObject({
      retryOfRunId: first.run.id,
      attempt: 2,
      sessionId: agent.sessionId,
    });
  });

  it("accepts an OpenAI-only configuration for real runs", async () => {
    const service = await makeServiceWithConfig({
      MODEL_PROVIDER: "openai",
      OPENAI_API_KEY: "openai-test-key",
      OPENAI_MODEL: "gpt-5-codex",
    });
    const agent = await service.createAgent({ name: "OpenAI Runner" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const trace = service.getTrace(run.id);
    expect(trace.run.prompt).toContain("write hello world");
    expect(trace.traceEvents.some((event) => event.metadata?.modelProvider === "openai")).toBe(
      true,
    );
  });
});
