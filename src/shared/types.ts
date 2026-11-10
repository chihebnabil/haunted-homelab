/**
 * Shared types used by the Backend and the Web_App.
 * Contains only type declarations and a few constant name lists that both sides need.
 */

// ---------------------------------------------------------------------------
// Homelab data (Data_Source output)
// ---------------------------------------------------------------------------

export type ContainerState = "running" | "exited" | "restarting" | "paused" | "created";

export interface ContainerInfo {
  name: string;
  state: ContainerState;
  /** 0..(100 * cores) as Docker reports; the simulator stays within 0..100. */
  cpuPercent: number;
  memoryBytes: number;
}

export interface LogLine {
  /** RFC 3339 / ISO 8601 timestamp. */
  timestamp: string;
  text: string;
  stream?: "stdout" | "stderr";
}

export interface FilesystemUsage {
  mount: string;
  usedBytes: number;
  totalBytes: number;
}

export interface HostMetrics {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  filesystems: FilesystemUsage[];
}

export interface Snapshot {
  /** ISO time the data was read. */
  readAt: string;
  containers: ContainerInfo[];
  host: HostMetrics;
}

export interface Thresholds {
  cpuPercent: number;
  cpuDurationSeconds: number;
  memoryPercent: number;
  diskPercent: number;
}

export interface Clock {
  now(): number;
}

// ---------------------------------------------------------------------------
// Actions and proposals
// ---------------------------------------------------------------------------

export type ActionKind = "restart" | "stop";
export type ProposalStatus = "pending" | "confirmed" | "cancelled" | "expired";

export interface ActionProposalDTO {
  id: string;
  action: ActionKind;
  container: string;
  reason: string;
  /** ISO time. */
  createdAt: string;
  /** ISO time: createdAt + 5 minutes. */
  expiresAt: string;
  status: ProposalStatus;
}

export type ConfirmRejectionReason =
  | "expired"
  | "already_confirmed"
  | "already_cancelled"
  | "already_expired"
  | "not_found";

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export type AlertRuleId =
  | "host_cpu"
  | "host_memory"
  | "disk"
  | "container_exited"
  | "container_restarting"
  | "new_container_cpu"
  | "data_source_unavailable";

export type AlertSubject =
  | { kind: "host"; resource: "cpu" | "memory" }
  | { kind: "filesystem"; mount: string }
  | { kind: "container"; name: string }
  | { kind: "data_source" };

export type AlertSeverity = "warning" | "critical";

export interface AlertEvent {
  /** `${ruleId}:${subjectKey(subject)}` */
  key: string;
  ruleId: AlertRuleId;
  subject: AlertSubject;
  severity: AlertSeverity;
  /** Formatted value, e.g. "97.3%", "exited", "restarting". */
  measuredValue: string;
  /** ISO time of the triggering snapshot or failed read. */
  detectedAt: string;
}

export interface HauntingAlert extends AlertEvent {
  /** uuid; also the MessageStore id for speech. */
  id: string;
  /** Persona text, at most 40 words. */
  message: string;
  status: "active" | "resolved";
  resolvedAt?: string;
  recoveryMessageId?: string;
  recoveryMessage?: string;
  proposalId?: string;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface ChatTurn {
  role: "user" | "ghost";
  text: string;
}

export interface LogEvent {
  timestamp: string;
  level: "error" | "warning";
  text: string;
}

export interface GhostReply {
  /** Also the MessageStore id for speech. */
  id: string;
  /** Spoken text, at most 120 words. */
  text: string;
  /** Log summary events, rendered as a list and not spoken. */
  events?: LogEvent[];
  /** Non-spoken list (for example container names), rendered by the Chat_Page. */
  list?: string[];
  proposal?: ActionProposalDTO;
  /** ISO time. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Simulator incidents
// ---------------------------------------------------------------------------

export const INCIDENT_TYPES = [
  "cpu_spike",
  "memory_leak",
  "disk_full",
  "container_crash",
  "container_restart_loop",
] as const;

export type IncidentType = (typeof INCIDENT_TYPES)[number];

export interface StagedIncident {
  type: IncidentType;
  target?: string;
  /** Epoch ms. */
  stagedAt: number;
  leakBytes?: number;
}

// ---------------------------------------------------------------------------
// Public configuration (browser-safe projection)
// ---------------------------------------------------------------------------

export type DataSourceName = "docker" | "simulator";

/** Never contains the API key, the OpenRouter base URL, or the Docker endpoint. */
export interface PublicConfig {
  dataSource: DataSourceName;
  aiGateway: "openrouter";
  llmModel: string;
  ttsModel: string;
  pollIntervalMs: number;
  thresholds: Thresholds;
}

// ---------------------------------------------------------------------------
// WebSocket events (server to client)
// ---------------------------------------------------------------------------

export type ServerEvent =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "alert.raised"; alert: HauntingAlert; proposal?: ActionProposalDTO }
  | {
      type: "alert.resolved";
      alertId: string;
      resolvedAt: string;
      recoveryMessage: string;
      recoveryMessageId: string;
    }
  | { type: "proposal.updated"; proposal: ActionProposalDTO }
  | { type: "chat.message"; reply: GhostReply };

export type ServerEventType = ServerEvent["type"];

// ---------------------------------------------------------------------------
// HTTP DTOs
// ---------------------------------------------------------------------------

/** GET /api/config */
export type ConfigResponse = PublicConfig;

/** GET /api/state */
export interface StateResponse {
  snapshot?: Snapshot;
  alerts: HauntingAlert[];
  proposals: ActionProposalDTO[];
}

/** POST /api/chat body. question: 1-2000 chars; history: at most 10 turns. */
export interface ChatRequest {
  question: string;
  history: ChatTurn[];
}

/** POST /api/chat 200 */
export type ChatResponse = GhostReply;

/** Error body for 4xx/5xx responses; `error` is persona text without internal details. */
export interface ErrorResponse {
  error: string;
}

/** POST /api/proposals/:id/confirm 200 */
export interface ConfirmProposalResponse {
  proposal: ActionProposalDTO;
  reply: GhostReply;
}

/** POST /api/proposals/:id/confirm|cancel 409. `proposal` is absent when the id is unknown. */
export interface ProposalRejectedResponse {
  proposal?: ActionProposalDTO;
  reason: ConfirmRejectionReason;
}

/** POST /api/proposals/:id/cancel 200 */
export interface CancelProposalResponse {
  proposal: ActionProposalDTO;
}

/** POST /api/sim/incidents body */
export interface StageIncidentRequest {
  type: IncidentType;
  container?: string;
}

/** GET, POST, DELETE /api/sim/incidents 200 */
export type IncidentsResponse = StagedIncident[];
