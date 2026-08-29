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

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
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
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface DatabaseV1 {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
}

export interface Database {
  version: 2;
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
