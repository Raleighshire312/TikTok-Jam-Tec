export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ActorType = "human" | "agent";
export type ModelProvider = "ark" | "openai";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  sessionId: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  traceId: string;
  sessionId: string;
  agentVersion: string;
  retryOfRunId: string | null;
  attempt: number;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export type TraceSource = "service" | "codex";
export type TraceKind =
  | "lifecycle"
  | "message"
  | "command"
  | "file_change"
  | "tool_call"
  | "web_search"
  | "reasoning"
  | "model_call"
  | "error"
  | "usage"
  | "unknown";
export type TraceStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "info";

export interface TraceSpanMetadata {
  providerSessionId?: string | null;
  modelProvider?: ModelProvider | null;
  modelBaseUrl?: string | null;
  modelId?: string | null;
  arkBaseUrl?: string | null;
  arkModelId?: string | null;
  runtimeProvider?: "local-process" | "container" | null;
  sandboxMode?: string | null;
  runtimeInstanceId?: string | null;
  containerEngine?: string | null;
  containerImage?: string | null;
  toolName?: string | null;
  platform?: string | null;
  architecture?: string | null;
}

export interface TraceEvent {
  id: string;
  runId: string;
  agentId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  sessionId: string;
  agentVersion: string;
  actorType: ActorType;
  metadata: TraceSpanMetadata | null;
  sequence: number;
  source: TraceSource;
  kind: TraceKind;
  status: TraceStatus;
  label: string;
  itemId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  detail: {
    text?: string;
    command?: string;
    exitCode?: number;
    filePath?: string;
    changeType?: string;
    toolName?: string;
    query?: string;
    error?: string;
    note?: string;
  } | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | null;
  redacted: boolean;
  createdAt: string;
}

export type TraceDiagnosisSeverity = "success" | "info" | "warning" | "error";

export interface TraceDiagnosis {
  severity: TraceDiagnosisSeverity;
  headline: string;
  cause: string;
  evidenceEventId: string | null;
  suggestedAction: string;
}

export interface FirstFailureSummary {
  spanId: string;
  kind: TraceKind;
  label: string;
  command: string | null;
  toolName: string | null;
  exitCode: number | null;
  durationMs: number | null;
  error: string | null;
}

export interface RunTraceSummary {
  durationMs: number | null;
  stepCount: number | null;
  failedSteps: number | null;
  redactionCount: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  diagnosis: TraceDiagnosis;
  firstFailure: FirstFailureSummary | null;
}

export interface RunTrace {
  run: AgentRun;
  traceEvents: TraceEvent[];
  summary: RunTraceSummary;
}

export interface SystemInfo {
  modelProvider: ModelProvider;
  modelConfigured: boolean;
  modelBaseUrl: string;
  modelId: string | null;
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
