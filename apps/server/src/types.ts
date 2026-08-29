export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";
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
export type ActorType = "human" | "agent";

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
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface TraceEventUsage extends RunUsage {
  totalTokens?: number;
}

export interface TraceSpanMetadata {
  providerSessionId?: string | null;
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

export interface TraceEventDetail {
  text?: string;
  command?: string;
  exitCode?: number;
  filePath?: string;
  changeType?: string;
  toolName?: string;
  query?: string;
  error?: string;
  note?: string;
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
  detail: TraceEventDetail | null;
  usage: TraceEventUsage | null;
  redacted: boolean;
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
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
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

export interface DatabaseV1 {
  version: 1;
  agents: Array<Omit<Agent, "sessionId">>;
  messages: Message[];
  runs: Array<
    Omit<AgentRun, "traceId" | "sessionId" | "agentVersion" | "retryOfRunId" | "attempt">
  >;
}

export interface DatabaseV2 {
  version: 2;
  agents: Array<Omit<Agent, "sessionId">>;
  messages: Message[];
  runs: Array<
    Omit<AgentRun, "traceId" | "sessionId" | "agentVersion" | "retryOfRunId" | "attempt">
  >;
  traceEvents: Array<
    Omit<
      TraceEvent,
      | "traceId"
      | "spanId"
      | "parentSpanId"
      | "sessionId"
      | "agentVersion"
      | "actorType"
      | "metadata"
    >
  >;
}

export interface Database {
  version: 3;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  traceEvents: TraceEvent[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface SendMessageInput {
  content: string;
  retryOfRunId?: string | null;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  runId: string;
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
}

export interface RunnerTraceEventInput {
  source: TraceSource;
  kind: TraceKind;
  status: TraceStatus;
  label: string;
  spanId?: string | null;
  parentSpanId?: string | null;
  actorType?: ActorType;
  metadata?: TraceSpanMetadata | null;
  itemId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  detail?: TraceEventDetail | null;
  usage?: TraceEventUsage | null;
}

export interface RunnerObserver {
  onEvent(event: RunnerTraceEventInput): void | Promise<void>;
}

export interface AgentRunner {
  run(request: RunnerRequest, observer?: RunnerObserver): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
