import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type {
  AIAgentDefinition,
  AIAgentResult,
  AIAgentTask,
  AIAgentVersionRecord,
  AIApprovalEvent,
  AIApprovalRequest,
  AIConflictRecord,
  AICoordinationAnalytics,
  AICoordinationEvent,
  AICoordinationSession,
  AIEvidenceRecord,
  AIPlanAction,
  AIRecommendation,
  AIResponsePlan,
  AISafetyValidationReport,
  AISessionMemory,
  AISimulationResult,
  AISimulationSession,
  AISimulationType,
  AITriggerEvent,
  ClaimClassification,
  CoordinationAgentId,
  DataMode,
  SafetyValidationStatus,
  SystemEvent,
  UserRole,
} from '../src/shared/types.ts';
import {
  getAIProviderHealth,
  sanitizeUntrustedForAgent,
  synthesizeCoordinationPlanWithAI,
} from './aiProvider.ts';
import { computeDeterministicRisk, computeFreshness, haversineKm } from './engines.ts';
import { eventBus } from './events.ts';
import {
  computeShortagesAndReplenishment,
  createStockReservation,
  isWarehouseOperationalForDispatch,
  matchWarehousesForRequest,
} from './inventoryEngine.ts';
import {
  createPendingDispatch,
  optimizeMultiWarehouseAllocation,
} from './logisticsEngine.ts';
import { PERMISSIONS, type RequestActor } from './rbac.ts';
import { store } from './store.ts';

// ============================================================================
// STRICT ZOD CONTRACTS FOR AGENT OUTPUTS
// ============================================================================

export const AIEvidenceSchema = z.object({
  evidence_id: z.string().min(1),
  session_id: z.string().min(1),
  task_id: z.string().min(1),
  agent_id: z.string().min(1),
  org_id: z.string().min(1),
  source_type: z.string().min(1),
  source_id: z.string().min(1),
  claim: z.string().min(1),
  claim_classification: z.enum([
    'VERIFIED FACT',
    'CALCULATED RESULT',
    'AI INTERPRETATION',
    'ASSUMPTION',
    'UNKNOWN',
  ]),
  observed_at: z.string().nullable(),
  retrieved_at: z.string().min(1),
  source_status: z.enum(['LIVE', 'FRESH', 'STALE', 'UNAVAILABLE', 'UNVERIFIED', 'SIMULATED']),
  data_snapshot: z.record(z.string(), z.unknown()).optional(),
  mode: z.enum(['operational', 'demo']),
});

export const AIRecommendationSchema = z.object({
  recommendation_id: z.string().min(1),
  session_id: z.string().min(1),
  task_id: z.string().min(1),
  agent_id: z.string().min(1),
  org_id: z.string().min(1),
  type: z.string().min(1),
  priority: z.enum(['critical', 'high', 'medium', 'low']),
  title: z.string().min(2),
  description: z.string().min(5),
  action_type: z.enum([
    'CREATE_ALLOCATION',
    'CREATE_PENDING_DISPATCH',
    'RESERVE_STOCK',
    'ESCALATE_INCIDENT',
    'REASSESS_RISK',
    'FIELD_VERIFICATION',
    'REASSIGN_ROUTE',
    'REQUEST_REPLENISHMENT',
    'ADVISORY_ONLY',
  ]),
  proposed_parameters: z.record(z.string(), z.unknown()),
  reasoning: z.string().min(5),
  evidence_ids: z.array(z.string()),
  constraints: z.array(z.string()),
  risk: z.string().min(2),
  requires_human_approval: z.literal(true),
  created_at: z.string().min(1),
  mode: z.enum(['operational', 'demo']),
});

export const AIAgentResultSchema = z.object({
  result_id: z.string().min(1),
  agent_id: z.string().min(1),
  agent_version: z.string().min(1),
  session_id: z.string().min(1),
  task_id: z.string().min(1),
  org_id: z.string().min(1),
  status: z.enum(['COMPLETED', 'DEGRADED', 'FAILED', 'TIMED_OUT', 'CANCELLED']),
  summary: z.string().min(5),
  findings: z.array(
    z.object({
      title: z.string().min(2),
      detail: z.string().min(2),
      classification: z.enum([
        'VERIFIED FACT',
        'CALCULATED RESULT',
        'AI INTERPRETATION',
        'ASSUMPTION',
        'UNKNOWN',
      ]),
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
      evidence_ids: z.array(z.string()),
    })
  ),
  recommendations: z.array(AIRecommendationSchema),
  evidence: z.array(AIEvidenceSchema),
  missing_information: z.array(z.string()),
  warnings: z.array(z.string()),
  confidence: z.number().min(0).max(1).nullable(),
  data_freshness: z.enum(['FRESH', 'PARTIAL', 'STALE', 'UNAVAILABLE']),
  tool_calls_used: z.number().int().min(0),
  tools_invoked: z.array(z.string()),
  ai_provider_used: z.string().nullable(),
  ai_model_used: z.string().nullable(),
  ai_synthesis_status: z.enum(['LIVE_AI', 'DETERMINISTIC_ONLY', 'AI_UNAVAILABLE']),
  tokens_estimated: z.number().int().min(0),
  created_at: z.string().min(1),
  execution_time_ms: z.number().int().min(0),
  mode: z.enum(['operational', 'demo']),
});

// ============================================================================
// AGENT REGISTRY (ALL 8 SPECIALIST AGENTS)
// ============================================================================

const DEFAULT_AGENT_DEFINITIONS: Omit<
  AIAgentDefinition,
  'runtime_status' | 'last_run_at' | 'last_duration_ms' | 'total_runs' | 'failed_runs' | 'updated_at'
>[] = [
  {
    agent_id: 'agent-emergency-intel',
    name: 'Emergency Intelligence Agent',
    role: 'Incident triage, report corroboration, risk trajectory & missing-data detection',
    description:
      'Analyzes verified/unverified incident records, field reports, deterministic risk assessments, and duplicate candidates. Never verifies, rejects, or closes incidents.',
    version: '1.0.0',
    phase: 'A_PARALLEL',
    allowed_tools: ['read_incident', 'read_incident_reports', 'read_risk_assessments', 'read_alerts'],
    permissions: ['incident:read', 'risk:read'],
    read_only: true,
    can_execute_mutations: false,
    model_config: {
      provider: 'deterministic',
      primary_model: 'deterministic-rules-v1',
      fallback_model: 'deterministic-rules-v1',
      deterministic_core: true,
    },
    max_execution_time_ms: 8000,
    max_tool_calls: 8,
    output_schema: 'AIAgentResultSchema@1.0',
    error_policy: 'fail_partial',
    active: true,
  },
  {
    agent_id: 'agent-environmental-intel',
    name: 'Environmental & Weather Intelligence Agent',
    role: 'Live weather telemetry freshness, severe hazard triggers & forecast impact',
    description:
      'Evaluates Open-Meteo weather observations, rainfall/wind/heat triggers, and weather-risk scores. Never fabricates official government disaster warnings.',
    version: '1.0.0',
    phase: 'A_PARALLEL',
    allowed_tools: ['read_incident', 'read_weather_observations', 'read_alerts'],
    permissions: ['weather:read'],
    read_only: true,
    can_execute_mutations: false,
    model_config: {
      provider: 'deterministic',
      primary_model: 'deterministic-weather-v1',
      fallback_model: 'deterministic-weather-v1',
      deterministic_core: true,
    },
    max_execution_time_ms: 8000,
    max_tool_calls: 6,
    output_schema: 'AIAgentResultSchema@1.0',
    error_policy: 'fail_partial',
    active: true,
  },
  {
    agent_id: 'agent-resource-intel',
    name: 'Resource Intelligence Agent',
    role: 'Warehouse availability, stock ledger accuracy, reservations, expiry & shortages',
    description:
      'Inspects real warehouse stock, active reservations, expiring batches, incoming shipments, and demand gaps. Never treats reserved/in-transit stock as freely available or mutates stock.',
    version: '1.0.0',
    phase: 'A_PARALLEL',
    allowed_tools: [
      'read_warehouses',
      'read_inventory',
      'read_reservations',
      'read_incoming_supplies',
      'read_relief_requests',
      'read_shortages',
    ],
    permissions: ['inventory:read', 'warehouse:read'],
    read_only: true,
    can_execute_mutations: false,
    model_config: {
      provider: 'deterministic',
      primary_model: 'deterministic-inventory-v1',
      fallback_model: 'deterministic-inventory-v1',
      deterministic_core: true,
    },
    max_execution_time_ms: 8000,
    max_tool_calls: 10,
    output_schema: 'AIAgentResultSchema@1.0',
    error_policy: 'fail_partial',
    active: true,
  },
  {
    agent_id: 'agent-human-impact',
    name: 'Human Impact & Priority Agent',
    role: 'Affected population triage, vulnerable groups, unmet needs & fairness analysis',
    description:
      'Assesses affected households, vulnerable population counts, urgent relief requests, and competing under-served incidents. Never fabricates population counts or infers sensitive attributes.',
    version: '1.0.0',
    phase: 'A_PARALLEL',
    allowed_tools: ['read_incident', 'read_all_incidents', 'read_relief_requests', 'read_deliveries'],
    permissions: ['incident:read', 'relief:read'],
    read_only: true,
    can_execute_mutations: false,
    model_config: {
      provider: 'deterministic',
      primary_model: 'deterministic-human-impact-v1',
      fallback_model: 'deterministic-human-impact-v1',
      deterministic_core: true,
    },
    max_execution_time_ms: 8000,
    max_tool_calls: 8,
    output_schema: 'AIAgentResultSchema@1.0',
    error_policy: 'fail_partial',
    active: true,
  },
  {
    agent_id: 'agent-logistics-intel',
    name: 'Logistics & Route Intelligence Agent',
    role: 'Warehouse matching, fleet readiness, route hazards & ETA constraints',
    description:
      'Runs after specialist context gathering to evaluate candidate warehouses, vehicles, drivers, active dispatches, and route hazards. Always states road safety/GPS availability honestly and never dispatches autonomously.',
    version: '1.0.0',
    phase: 'B_SEQUENTIAL',
    allowed_tools: [
      'read_incident',
      'read_warehouses',
      'read_relief_requests',
      'read_allocations',
      'read_vehicles',
      'read_drivers',
      'read_route_hazards',
      'read_dispatches',
      'match_warehouses_readonly',
    ],
    permissions: ['logistics:read', 'fleet:read', 'route:read'],
    read_only: true,
    can_execute_mutations: false,
    model_config: {
      provider: 'deterministic',
      primary_model: 'deterministic-logistics-v1',
      fallback_model: 'deterministic-logistics-v1',
      deterministic_core: true,
    },
    max_execution_time_ms: 10000,
    max_tool_calls: 12,
    output_schema: 'AIAgentResultSchema@1.0',
    error_policy: 'fail_partial',
    active: true,
  },
  {
    agent_id: 'agent-response-planner',
    name: 'Response Planning Agent',
    role: 'Unified response plan synthesis, deduplicated actions & trade-off articulation',
    description:
      'Synthesizes verified findings from specialist agents into a single human-approvable response plan with alternatives, constraints, and optional Gemini narrative synthesis. Zero autonomous execution.',
    version: '1.0.0',
    phase: 'C_SYNTHESIS',
    allowed_tools: ['read_session_results', 'read_session_memory', 'invoke_ai_synthesis'],
    permissions: ['ai:coordinate'],
    read_only: true,
    can_execute_mutations: false,
    model_config: {
      provider: 'gemini',
      primary_model: 'gemini-4-hydrogen',
      fallback_model: 'gemini-3.1-flash-lite',
      deterministic_core: true,
    },
    max_execution_time_ms: 14000,
    max_tool_calls: 6,
    output_schema: 'AIAgentResultSchema@1.0',
    error_policy: 'retry_then_degrade',
    active: true,
  },
  {
    agent_id: 'agent-response-monitor',
    name: 'Response Monitoring Agent',
    role: 'Continuous change detection, trigger triage & reassessment guidance',
    description:
      'Evaluates meaningful operational deltas across active dispatches, shortages, weather shifts, and proactive triggers while preventing alert fatigue through cooldowns and deduplication.',
    version: '1.0.0',
    phase: 'D_MONITORING',
    allowed_tools: ['read_triggers', 'read_dispatches', 'read_alerts', 'read_shortages'],
    permissions: ['ai:monitoring_manage'],
    read_only: true,
    can_execute_mutations: false,
    model_config: {
      provider: 'deterministic',
      primary_model: 'deterministic-monitor-v1',
      fallback_model: 'deterministic-monitor-v1',
      deterministic_core: true,
    },
    max_execution_time_ms: 6000,
    max_tool_calls: 6,
    output_schema: 'AIAgentResultSchema@1.0',
    error_policy: 'fail_partial',
    active: true,
  },
  {
    agent_id: 'agent-safety-verifier',
    name: 'Evidence & Safety Verification Agent',
    role: 'Deterministic code-level verification of facts, stock, fleet, routes, evidence & RBAC',
    description:
      'Independently validates every proposed plan action against live database records, permissions, freshness limits, and safety invariants. Returns VALID, VALID_WITH_WARNINGS, INCOMPLETE, or REJECTED.',
    version: '1.0.0',
    phase: 'E_VERIFICATION',
    allowed_tools: [
      'read_incident',
      'read_risk_assessments',
      'read_warehouses',
      'read_inventory',
      'read_reservations',
      'read_vehicles',
      'read_drivers',
      'read_route_hazards',
      'read_session_results',
      'verify_rbac_permissions',
    ],
    permissions: ['safety:verify'],
    read_only: true,
    can_execute_mutations: false,
    model_config: {
      provider: 'deterministic',
      primary_model: 'deterministic-safety-verifier-v1',
      fallback_model: 'deterministic-safety-verifier-v1',
      deterministic_core: true,
    },
    max_execution_time_ms: 8000,
    max_tool_calls: 12,
    output_schema: 'AIAgentResultSchema@1.0',
    error_policy: 'hard_block_on_reject',
    active: true,
  },
];

export function ensureAgentRegistrySeeded(): AIAgentDefinition[] {
  const now = new Date().toISOString();
  let dirty = false;

  for (const def of DEFAULT_AGENT_DEFINITIONS) {
    const existing = store.state.aiAgents.find((a) => a.agent_id === def.agent_id);
    if (!existing) {
      store.state.aiAgents.push({
        ...def,
        runtime_status: 'IDLE',
        last_run_at: null,
        last_duration_ms: null,
        total_runs: 0,
        failed_runs: 0,
        updated_at: now,
      });
      store.state.aiAgentVersions.push({
        version_id: `ver-${def.agent_id}-${def.version}`,
        agent_id: def.agent_id,
        version: def.version,
        changelog: 'Initial Phase 6 multi-agent registration with strict read-only tool allowlist.',
        allowed_tools: [...def.allowed_tools],
        model_primary: def.model_config.primary_model,
        created_at: now,
      });
      dirty = true;
    }
  }

  if (dirty) {
    store.save();
  }
  return store.state.aiAgents;
}

export function getAgentRegistry(): AIAgentDefinition[] {
  return ensureAgentRegistrySeeded();
}

export function getAgentStatusSummary() {
  const agents = ensureAgentRegistrySeeded();
  return {
    total_agents: agents.length,
    active_agents: agents.filter((a) => a.active).length,
    running_agents: agents.filter((a) => a.runtime_status === 'RUNNING').length,
    degraded_agents: agents.filter((a) => a.runtime_status === 'DEGRADED' || a.runtime_status === 'FAILED').length,
    agents: agents.map((a) => ({
      agent_id: a.agent_id,
      name: a.name,
      role: a.role,
      phase: a.phase,
      version: a.version,
      runtime_status: a.runtime_status,
      read_only: a.read_only,
      can_execute_mutations: a.can_execute_mutations,
      allowed_tools: a.allowed_tools,
      max_tool_calls: a.max_tool_calls,
      max_execution_time_ms: a.max_execution_time_ms,
      last_run_at: a.last_run_at,
      last_duration_ms: a.last_duration_ms,
      total_runs: a.total_runs,
      failed_runs: a.failed_runs,
    })),
    provider_health: getAIProviderHealth(),
  };
}

// ============================================================================
// ORGANIZATION ISOLATION & SECURITY HELPERS
// ============================================================================

export function canAccessOrg(actor: RequestActor, targetOrgId: string): boolean {
  if (actor.role === 'super_admin') return true;
  return actor.orgId === targetOrgId;
}

export function assertOrgAccess(actor: RequestActor, targetOrgId: string, resourceLabel = 'resource'): void {
  if (!canAccessOrg(actor, targetOrgId)) {
    const err = new Error(
      `Forbidden: Cross-organization access denied for ${resourceLabel} (actor org '${actor.orgId}' cannot access '${targetOrgId}').`
    );
    (err as any).statusCode = 403;
    throw err;
  }
}

// ============================================================================
// STRICT TOOL INVOCATION GUARD (ALLOWLIST + MAX CALLS + ORG ISOLATION)
// ============================================================================

const FORBIDDEN_MUTATION_TOOLS = new Set([
  'execute_dispatch',
  'mutate_inventory',
  'delete_incident',
  'verify_incident',
  'close_incident',
  'approve_plan',
  'run_sql',
  'shell_exec',
  'unrestricted_http',
  'publish_public_alert',
]);

export interface ToolGuardContext {
  agentId: CoordinationAgentId;
  task: AIAgentTask;
  actor: RequestActor;
  mode: DataMode;
  orgId: string;
}

export function invokeAuthorizedTool<T>(
  ctx: ToolGuardContext,
  toolName: string,
  fn: () => T
): T {
  const registry = ensureAgentRegistrySeeded();
  const agent = registry.find((a) => a.agent_id === ctx.agentId);
  if (!agent) {
    throw new Error(`Security violation: Unknown agent '${ctx.agentId}'.`);
  }
  if (FORBIDDEN_MUTATION_TOOLS.has(toolName)) {
    throw new Error(
      `Security violation: Tool '${toolName}' is permanently forbidden for AI agents. Mutations require human approval.`
    );
  }
  if (!agent.allowed_tools.includes(toolName)) {
    throw new Error(
      `Security violation: Agent '${ctx.agentId}' attempted unauthorized tool '${toolName}'. Allowed tools: ${agent.allowed_tools.join(', ')}.`
    );
  }
  if (ctx.task.tool_calls_used >= agent.max_tool_calls) {
    throw new Error(
      `Execution limit exceeded: Agent '${ctx.agentId}' exceeded max_tool_calls (${agent.max_tool_calls}).`
    );
  }
  ctx.task.tool_calls_used += 1;
  return fn();
}

// ============================================================================
// HELPER: RECORD TIMELINE EVENTS & EVIDENCE
// ============================================================================

function recordSessionEvent(params: {
  session: AICoordinationSession;
  eventType: string;
  agentId?: CoordinationAgentId | 'orchestrator' | 'human';
  taskId?: string;
  summary: string;
  details?: Record<string, unknown>;
  publishRealtime?: boolean;
}): AICoordinationEvent {
  const ev: AICoordinationEvent = {
    event_id: uuidv4(),
    session_id: params.session.session_id,
    org_id: params.session.org_id,
    event_type: params.eventType,
    agent_id: params.agentId || 'orchestrator',
    task_id: params.taskId,
    summary: params.summary,
    details: params.details,
    created_at: new Date().toISOString(),
    mode: params.session.mode,
  };
  store.state.aiCoordinationEvents.unshift(ev);
  if (store.state.aiCoordinationEvents.length > 800) {
    store.state.aiCoordinationEvents.length = 800;
  }

  if (params.publishRealtime !== false) {
    eventBus.publish({
      event_type: params.eventType,
      organization_id: params.session.org_id,
      entity_id: params.session.session_id,
      source: 'ai-coordination-orchestrator',
      mode: params.session.mode,
      payload: {
        session_id: params.session.session_id,
        incident_id: params.session.incident_id,
        agent_id: params.agentId || 'orchestrator',
        task_id: params.taskId || null,
        summary: params.summary,
        ...(params.details || {}),
      },
    });
  }

  return ev;
}

function makeEvidence(params: {
  session: AICoordinationSession;
  task: AIAgentTask;
  agentId: CoordinationAgentId;
  sourceType: AIEvidenceRecord['source_type'];
  sourceId: string;
  claim: string;
  classification: ClaimClassification;
  observedAt: string | null;
  sourceStatus: AIEvidenceRecord['source_status'];
  snapshot?: Record<string, unknown>;
}): AIEvidenceRecord {
  return {
    evidence_id: `ev-${uuidv4().slice(0, 12)}`,
    session_id: params.session.session_id,
    task_id: params.task.task_id,
    agent_id: params.agentId,
    org_id: params.session.org_id,
    source_type: params.sourceType,
    source_id: params.sourceId,
    claim: params.claim,
    claim_classification: params.classification,
    observed_at: params.observedAt,
    retrieved_at: new Date().toISOString(),
    source_status: params.sourceStatus,
    data_snapshot: params.snapshot,
    mode: params.session.mode,
  };
}

function makeRecommendation(params: {
  session: AICoordinationSession;
  task: AIAgentTask;
  agentId: CoordinationAgentId;
  type: AIRecommendation['type'];
  priority: AIRecommendation['priority'];
  title: string;
  description: string;
  actionType: AIRecommendation['action_type'];
  proposedParameters: Record<string, unknown>;
  reasoning: string;
  evidenceIds: string[];
  constraints: string[];
  risk: string;
}): AIRecommendation {
  return {
    recommendation_id: `rec-${uuidv4().slice(0, 12)}`,
    session_id: params.session.session_id,
    task_id: params.task.task_id,
    agent_id: params.agentId,
    org_id: params.session.org_id,
    type: params.type,
    priority: params.priority,
    title: params.title,
    description: params.description,
    action_type: params.actionType,
    proposed_parameters: params.proposedParameters,
    reasoning: params.reasoning,
    evidence_ids: params.evidenceIds,
    constraints: params.constraints,
    risk: params.risk,
    requires_human_approval: true,
    created_at: new Date().toISOString(),
    mode: params.session.mode,
  };
}

// ============================================================================
// SCOPED ORG FILTER FOR READS
// ============================================================================

function getScopedIncidents(mode: DataMode, actor: RequestActor, orgId: string) {
  return store.state.incidents.filter((i) => {
    const incOrg = (i as any).orgId || (i as any).organizationId;
    return i.mode === mode && (actor.role === 'super_admin' || !incOrg || incOrg === orgId);
  });
}

function getScopedWarehouses(mode: DataMode) {
  return store.state.warehouses.filter((w) => w.mode === mode);
}

// ============================================================================
// SPECIALIST AGENT IMPLEMENTATIONS (AGENTS 1–8)
// ============================================================================

function runEmergencyIntelligenceAgent(
  session: AICoordinationSession,
  task: AIAgentTask,
  actor: RequestActor
): AIAgentResult {
  const started = Date.now();
  const guard: ToolGuardContext = {
    agentId: 'agent-emergency-intel',
    task,
    actor,
    mode: session.mode,
    orgId: session.org_id,
  };
  const toolsInvoked: string[] = [];
  const evidence: AIEvidenceRecord[] = [];
  const findings: AIAgentResult['findings'] = [];
  const recommendations: AIRecommendation[] = [];
  const missingInfo: string[] = [];
  const warnings: string[] = [];

  const incident = invokeAuthorizedTool(guard, 'read_incident', () => {
    toolsInvoked.push('read_incident');
    const scoped = getScopedIncidents(session.mode, actor, session.org_id);
    if (session.incident_id) {
      return scoped.find((i) => i.id === session.incident_id) || null;
    }
    return scoped.find((i) => i.status !== 'resolved' && i.status !== 'archived') || scoped[0] || null;
  });

  if (!incident) {
    missingInfo.push('No active incident found in the requested mode and organization scope.');
    return AIAgentResultSchema.parse({
      result_id: uuidv4(),
      agent_id: 'agent-emergency-intel',
      agent_version: task.agent_version,
      session_id: session.session_id,
      task_id: task.task_id,
      org_id: session.org_id,
      status: 'COMPLETED',
      summary: 'No active incident records exist in current scope for emergency intelligence analysis.',
      findings: [],
      recommendations: [],
      evidence: [],
      missing_information: missingInfo,
      warnings: ['Cannot assess emergency trajectory without an incident record.'],
      confidence: 0.2,
      data_freshness: 'UNAVAILABLE',
      tool_calls_used: task.tool_calls_used,
      tools_invoked: toolsInvoked,
      ai_provider_used: null,
      ai_model_used: null,
      ai_synthesis_status: 'DETERMINISTIC_ONLY',
      tokens_estimated: 0,
      created_at: new Date().toISOString(),
      execution_time_ms: Date.now() - started,
      mode: session.mode,
    }) as AIAgentResult;
  }

  // Prompt injection defense on untrusted incident fields
  const titleCheck = sanitizeUntrustedForAgent(incident.title);
  const descCheck = sanitizeUntrustedForAgent(incident.description);
  if (titleCheck.injectionDetected || descCheck.injectionDetected) {
    warnings.push(
      `Prompt-injection pattern detected and neutralized in incident ${incident.id} untrusted text fields (${[
        ...titleCheck.matchedFlags,
        ...descCheck.matchedFlags,
      ].join(', ')}). Treated strictly as data.`
    );
  }

  const incEv = makeEvidence({
    session,
    task,
    agentId: 'agent-emergency-intel',
    sourceType: 'incident',
    sourceId: incident.id,
    claim: `Incident "${titleCheck.sanitized}" (${incident.type}) is ${incident.status}, severity=${incident.severity}, verification=${incident.verificationStatus}, region=${incident.region}.`,
    classification: incident.verificationStatus === 'verified' ? 'VERIFIED FACT' : 'ASSUMPTION',
    observedAt: incident.updatedAt || incident.reportedAt,
    sourceStatus: incident.verificationStatus === 'verified' ? 'FRESH' : 'UNVERIFIED',
    snapshot: {
      id: incident.id,
      type: incident.type,
      severity: incident.severity,
      status: incident.status,
      verificationStatus: incident.verificationStatus,
      peopleAffected: incident.peopleAffected,
      vulnerablePopulation: incident.vulnerablePopulation,
    },
  });
  evidence.push(incEv);

  const reports = invokeAuthorizedTool(guard, 'read_incident_reports', () => {
    toolsInvoked.push('read_incident_reports');
    return store.state.incidentReports.filter((r) => r.incidentId === incident.id && r.mode === session.mode);
  });

  for (const rep of reports.slice(0, 5)) {
    const repCheck = sanitizeUntrustedForAgent(rep.summary);
    if (repCheck.injectionDetected) {
      warnings.push(
        `Prompt-injection attempt neutralized in field report ${rep.id} (${repCheck.matchedFlags.join(', ')}). Ignored embedded directives.`
      );
    }
    evidence.push(
      makeEvidence({
        session,
        task,
        agentId: 'agent-emergency-intel',
        sourceType: 'incident_report',
        sourceId: rep.id,
        claim: `Field report (${rep.sourceType}) by ${rep.reporterName}: ${repCheck.sanitized.slice(0, 180)}`,
        classification: rep.sourceType === 'field_responder' || rep.sourceType === 'command_desk' ? 'VERIFIED FACT' : 'ASSUMPTION',
        observedAt: rep.createdAt,
        sourceStatus: rep.sourceType === 'citizen' ? 'UNVERIFIED' : 'FRESH',
      })
    );
  }

  const assessments = invokeAuthorizedTool(guard, 'read_risk_assessments', () => {
    toolsInvoked.push('read_risk_assessments');
    return store.state.riskAssessments.filter((r) => r.incidentId === incident.id && r.mode === session.mode);
  });
  const latestRisk = assessments[0] || null;
  const prevRisk = assessments[1] || null;

  let freshness: AIAgentResult['data_freshness'] = 'FRESH';
  if (latestRisk) {
    const riskFresh = computeFreshness(latestRisk.createdAt, 1800);
    if (riskFresh !== 'fresh') freshness = 'STALE';
    const riskEv = makeEvidence({
      session,
      task,
      agentId: 'agent-emergency-intel',
      sourceType: 'risk_assessment',
      sourceId: latestRisk.id,
      claim: `Deterministic risk score is ${latestRisk.overallScore}/100 (${latestRisk.band}), completeness ${latestRisk.dataCompletenessPct}%, status ${latestRisk.assessmentStatus}.`,
      classification: 'CALCULATED RESULT',
      observedAt: latestRisk.createdAt,
      sourceStatus: riskFresh === 'fresh' ? 'FRESH' : 'STALE',
      snapshot: {
        overallScore: latestRisk.overallScore,
        band: latestRisk.band,
        missingFactors: latestRisk.missingFactors,
      },
    });
    evidence.push(riskEv);

    if (latestRisk.missingFactors.length > 0) {
      missingInfo.push(...latestRisk.missingFactors.map((f) => `Missing risk factor: ${f}`));
      if (freshness === 'FRESH') freshness = 'PARTIAL';
    }

    const latestScore = latestRisk.overallScore ?? 0;
    const prevScore = prevRisk?.overallScore ?? latestScore;
    const delta = prevRisk ? latestScore - prevScore : 0;
    findings.push({
      title: `Incident Risk Posture: ${latestRisk.band.toUpperCase()} (${latestScore}/100)`,
      detail: prevRisk
        ? `Risk changed by ${delta >= 0 ? '+' : ''}${delta} points since prior assessment (${prevScore} → ${latestScore}).`
        : `Single deterministic assessment on record (${latestScore}/100, completeness ${latestRisk.dataCompletenessPct}%).`,
      classification: 'CALCULATED RESULT',
      severity: latestScore >= 75 ? 'critical' : latestScore >= 55 ? 'high' : 'medium',
      evidence_ids: [incEv.evidence_id, riskEv.evidence_id],
    });
  } else {
    freshness = 'PARTIAL';
    missingInfo.push(`No deterministic risk assessment recorded yet for incident ${incident.id}.`);
    recommendations.push(
      makeRecommendation({
        session,
        task,
        agentId: 'agent-emergency-intel',
        type: 'verification',
        priority: 'high',
        title: `Run deterministic risk assessment for ${titleCheck.sanitized}`,
        description: `Incident ${incident.id} lacks a persisted deterministic risk assessment. Execute risk scoring before major resource commitments.`,
        actionType: 'REASSESS_RISK',
        proposedParameters: { incidentId: incident.id },
        reasoning: 'No deterministic risk score exists on record to ground escalation decisions.',
        evidenceIds: [incEv.evidence_id],
        constraints: ['Requires commander/analyst execution via deterministic risk endpoint.'],
        risk: 'Operating without deterministic risk baseline increases mis-prioritization risk.',
      })
    );
  }

  if (incident.verificationStatus !== 'verified') {
    warnings.push(`Incident ${incident.id} is currently '${incident.verificationStatus}' (not yet commander-verified).`);
    findings.push({
      title: 'Incident Verification Pending',
      detail: `Incident status is '${incident.verificationStatus}'. AI agents never verify or close incidents; commander confirmation is required.`,
      classification: 'VERIFIED FACT',
      severity: 'high',
      evidence_ids: [incEv.evidence_id],
    });
    recommendations.push(
      makeRecommendation({
        session,
        task,
        agentId: 'agent-emergency-intel',
        type: 'verification',
        priority: incident.severity === 'critical' ? 'critical' : 'high',
        title: `Field-verify incident ${titleCheck.sanitized}`,
        description: `Confirm ground truth, affected population, and access conditions for incident ${incident.id} before committing full-scale convoy assets.`,
        actionType: 'FIELD_VERIFICATION',
        proposedParameters: { incidentId: incident.id, currentVerificationStatus: incident.verificationStatus },
        reasoning: 'Unverified incident records must be confirmed by authorized emergency commanders.',
        evidenceIds: [incEv.evidence_id],
        constraints: ['Only emergency_commander or super_admin may verify an incident.'],
        risk: 'Dispatching scarce supplies to an unverified or duplicate report risks resource misallocation.',
      })
    );
  } else {
    findings.push({
      title: 'Incident Verified for Coordinated Response',
      detail: `Incident ${incident.id} (${incident.type}, ${incident.severity}) is verified in ${incident.region}.`,
      classification: 'VERIFIED FACT',
      severity: incident.severity === 'critical' ? 'critical' : 'high',
      evidence_ids: [incEv.evidence_id],
    });
  }

  if (reports.length === 0) {
    missingInfo.push(`No corroborating field reports linked to incident ${incident.id}.`);
  }

  const alerts = invokeAuthorizedTool(guard, 'read_alerts', () => {
    toolsInvoked.push('read_alerts');
    return store.state.alerts.filter((a) => a.incidentId === incident.id && a.mode === session.mode && a.status !== 'RESOLVED');
  });
  if (alerts.length > 0) {
    findings.push({
      title: `${alerts.length} Active Risk/Operational Alert(s) Linked`,
      detail: alerts.slice(0, 3).map((a) => `${a.severity.toUpperCase()}: ${a.title}`).join(' | '),
      classification: 'VERIFIED FACT',
      severity: alerts.some((a) => a.severity === 'critical') ? 'critical' : 'high',
      evidence_ids: [incEv.evidence_id],
    });
  }

  const confidence = latestRisk ? Number(((latestRisk.confidenceScore ?? 75) / 100).toFixed(2)) : 0.55;

  return AIAgentResultSchema.parse({
    result_id: uuidv4(),
    agent_id: 'agent-emergency-intel',
    agent_version: task.agent_version,
    session_id: session.session_id,
    task_id: task.task_id,
    org_id: session.org_id,
    status: 'COMPLETED',
    summary: `Analyzed incident ${incident.id} ("${titleCheck.sanitized}"): severity=${incident.severity}, verification=${incident.verificationStatus}, risk=${latestRisk ? `${latestRisk.overallScore}/100 (${latestRisk.band})` : 'not yet scored'}, ${reports.length} report(s).`,
    findings,
    recommendations,
    evidence,
    missing_information: Array.from(new Set(missingInfo)),
    warnings,
    confidence,
    data_freshness: freshness,
    tool_calls_used: task.tool_calls_used,
    tools_invoked: toolsInvoked,
    ai_provider_used: null,
    ai_model_used: null,
    ai_synthesis_status: 'DETERMINISTIC_ONLY',
    tokens_estimated: 0,
    created_at: new Date().toISOString(),
    execution_time_ms: Date.now() - started,
    mode: session.mode,
  }) as AIAgentResult;
}

function runEnvironmentalWeatherAgent(
  session: AICoordinationSession,
  task: AIAgentTask,
  actor: RequestActor
): AIAgentResult {
  const started = Date.now();
  const guard: ToolGuardContext = {
    agentId: 'agent-environmental-intel',
    task,
    actor,
    mode: session.mode,
    orgId: session.org_id,
  };
  const toolsInvoked: string[] = [];
  const evidence: AIEvidenceRecord[] = [];
  const findings: AIAgentResult['findings'] = [];
  const recommendations: AIRecommendation[] = [];
  const missingInfo: string[] = [];
  const warnings: string[] = [];

  const incident = invokeAuthorizedTool(guard, 'read_incident', () => {
    toolsInvoked.push('read_incident');
    const scoped = getScopedIncidents(session.mode, actor, session.org_id);
    return session.incident_id
      ? scoped.find((i) => i.id === session.incident_id) || null
      : scoped[0] || null;
  });

  const weatherList = invokeAuthorizedTool(guard, 'read_weather_observations', () => {
    toolsInvoked.push('read_weather_observations');
    return store.state.weatherObservations;
  });

  const matchedWeather = incident
    ? weatherList.find((w) => haversineKm(w.lat, w.lng, incident.lat, incident.lng) <= 35) || null
    : weatherList[0] || null;

  if (!matchedWeather) {
    missingInfo.push('No live meteorological observation is currently stored near this incident location.');
    warnings.push(
      'Weather data unavailable: environmental hazard risk cannot be confirmed without fetching live Open-Meteo telemetry. No official agency warning is assumed.'
    );
    return AIAgentResultSchema.parse({
      result_id: uuidv4(),
      agent_id: 'agent-environmental-intel',
      agent_version: task.agent_version,
      session_id: session.session_id,
      task_id: task.task_id,
      org_id: session.org_id,
      status: 'COMPLETED',
      summary: 'No fresh weather observation is available for the incident coordinates; environmental risk remains unconfirmed.',
      findings: [
        {
          title: 'Weather Telemetry Unavailable',
          detail: 'No cached or live weather observation exists within 35 km of the incident. Trigger weather refresh before finalizing weather-sensitive transport.',
          classification: 'UNKNOWN',
          severity: 'medium',
          evidence_ids: [],
        },
      ],
      recommendations: [],
      evidence,
      missing_information: missingInfo,
      warnings,
      confidence: 0.35,
      data_freshness: 'UNAVAILABLE',
      tool_calls_used: task.tool_calls_used,
      tools_invoked: toolsInvoked,
      ai_provider_used: null,
      ai_model_used: null,
      ai_synthesis_status: 'DETERMINISTIC_ONLY',
      tokens_estimated: 0,
      created_at: new Date().toISOString(),
      execution_time_ms: Date.now() - started,
      mode: session.mode,
    }) as AIAgentResult;
  }

  const fresh = computeFreshness(matchedWeather.fetchTimestamp, store.state.settings.weatherFreshnessSeconds || 900);
  const weatherEv = makeEvidence({
    session,
    task,
    agentId: 'agent-environmental-intel',
    sourceType: 'weather',
    sourceId: matchedWeather.id,
    claim: `Weather at ${matchedWeather.locationName} (${matchedWeather.provider}): ${matchedWeather.condition}, rainfall=${matchedWeather.rainfallMm}mm, wind=${matchedWeather.windSpeedKmh}km/h, temp=${matchedWeather.temperatureC}C, freshness=${fresh}.`,
    classification: 'VERIFIED FACT',
    observedAt: matchedWeather.fetchTimestamp,
    sourceStatus: fresh === 'fresh' ? 'LIVE' : 'STALE',
    snapshot: {
      condition: matchedWeather.condition,
      rainfallMm: matchedWeather.rainfallMm,
      windSpeedKmh: matchedWeather.windSpeedKmh,
      temperatureC: matchedWeather.temperatureC,
      severeTriggers: matchedWeather.severeTriggers,
    },
  });
  evidence.push(weatherEv);

  if (fresh !== 'fresh') {
    warnings.push(`Weather telemetry ${matchedWeather.id} is STALE (fetched ${matchedWeather.fetchTimestamp}). Refresh recommended.`);
  }

  const isSevere =
    (matchedWeather.rainfallMm ?? 0) >= 20 ||
    (matchedWeather.windSpeedKmh ?? 0) >= 50 ||
    matchedWeather.severeTriggers.length > 0;

  findings.push({
    title: isSevere ? 'Severe Meteorological Exposure Detected' : 'Moderate/Nominal Meteorological Conditions',
    detail: `Observed ${matchedWeather.condition} (${matchedWeather.rainfallMm} mm rain, ${matchedWeather.windSpeedKmh} km/h wind).${
      matchedWeather.severeTriggers.length > 0 ? ` Active triggers: ${matchedWeather.severeTriggers.join(', ')}.` : ''
    } Note: telemetry reflects meteorological observation, not an official government disaster declaration.`,
    classification: 'VERIFIED FACT',
    severity: isSevere ? 'high' : 'info',
    evidence_ids: [weatherEv.evidence_id],
  });

  if (isSevere && incident) {
    recommendations.push(
      makeRecommendation({
        session,
        task,
        agentId: 'agent-environmental-intel',
        type: 'safety_caution',
        priority: 'high',
        title: 'Apply weather-hardened transport & waterproofing precautions',
        description: `Elevated weather conditions (${matchedWeather.rainfallMm}mm rain / ${matchedWeather.windSpeedKmh}km/h wind) affect response corridor around ${matchedWeather.locationName}.`,
        actionType: 'ADVISORY_ONLY',
        proposedParameters: {
          incidentId: incident.id,
          weatherId: matchedWeather.id,
          rainfallMm: matchedWeather.rainfallMm,
          windSpeedKmh: matchedWeather.windSpeedKmh,
        },
        reasoning: 'High rainfall and wind degrade road passability and require weatherproof cargo protection.',
        evidenceIds: [weatherEv.evidence_id],
        constraints: ['Field units must confirm local road flooding before crossing low-lying routes.'],
        risk: 'Weather deterioration may delay convoys or damage dry-food/medical supplies.',
      })
    );
  }

  return AIAgentResultSchema.parse({
    result_id: uuidv4(),
    agent_id: 'agent-environmental-intel',
    agent_version: task.agent_version,
    session_id: session.session_id,
    task_id: task.task_id,
    org_id: session.org_id,
    status: 'COMPLETED',
    summary: `Weather at ${matchedWeather.locationName}: ${matchedWeather.condition}, ${matchedWeather.rainfallMm}mm rainfall, ${matchedWeather.windSpeedKmh}km/h wind (${fresh.toUpperCase()}).`,
    findings,
    recommendations,
    evidence,
    missing_information: missingInfo,
    warnings,
    confidence: fresh === 'fresh' ? 0.88 : 0.6,
    data_freshness: fresh === 'fresh' ? 'FRESH' : 'STALE',
    tool_calls_used: task.tool_calls_used,
    tools_invoked: toolsInvoked,
    ai_provider_used: null,
    ai_model_used: null,
    ai_synthesis_status: 'DETERMINISTIC_ONLY',
    tokens_estimated: 0,
    created_at: new Date().toISOString(),
    execution_time_ms: Date.now() - started,
    mode: session.mode,
  }) as AIAgentResult;
}

function runResourceIntelligenceAgent(
  session: AICoordinationSession,
  task: AIAgentTask,
  actor: RequestActor
): AIAgentResult {
  const started = Date.now();
  const guard: ToolGuardContext = {
    agentId: 'agent-resource-intel',
    task,
    actor,
    mode: session.mode,
    orgId: session.org_id,
  };
  const toolsInvoked: string[] = [];
  const evidence: AIEvidenceRecord[] = [];
  const findings: AIAgentResult['findings'] = [];
  const recommendations: AIRecommendation[] = [];
  const missingInfo: string[] = [];
  const warnings: string[] = [];

  const warehouses = invokeAuthorizedTool(guard, 'read_warehouses', () => {
    toolsInvoked.push('read_warehouses');
    return getScopedWarehouses(session.mode);
  });

  const inventory = invokeAuthorizedTool(guard, 'read_inventory', () => {
    toolsInvoked.push('read_inventory');
    return store.state.inventory.filter((i) => i.mode === session.mode);
  });

  const reservations = invokeAuthorizedTool(guard, 'read_reservations', () => {
    toolsInvoked.push('read_reservations');
    return store.state.stockReservations.filter(
      (r) => r.mode === session.mode && (r.status === 'Reserved' || r.status === 'Partially Reserved' || r.status === 'Allocated')
    );
  });

  const incoming = invokeAuthorizedTool(guard, 'read_incoming_supplies', () => {
    toolsInvoked.push('read_incoming_supplies');
    return store.state.incomingSupplies.filter((s) => s.mode === session.mode && s.status !== 'Received' && s.status !== 'Verified');
  });

  const requests = invokeAuthorizedTool(guard, 'read_relief_requests', () => {
    toolsInvoked.push('read_relief_requests');
    return store.state.reliefRequests.filter(
      (r) =>
        r.mode === session.mode &&
        r.status !== 'delivered' &&
        r.status !== 'closed' &&
        (!session.incident_id || r.incidentId === session.incident_id)
    );
  });

  const shortageSummary = invokeAuthorizedTool(guard, 'read_shortages', () => {
    toolsInvoked.push('read_shortages');
    return computeShortagesAndReplenishment(session.mode);
  });

  const operationalWarehouses = warehouses.filter((w) => isWarehouseOperationalForDispatch(w.status, w.active));
  const unavailableWarehouses = warehouses.filter((w) => !isWarehouseOperationalForDispatch(w.status, w.active));

  const whEv = makeEvidence({
    session,
    task,
    agentId: 'agent-resource-intel',
    sourceType: 'warehouse',
    sourceId: operationalWarehouses[0]?.id || 'warehouses-summary',
    claim: `${operationalWarehouses.length} of ${warehouses.length} warehouses are operational for dispatch (${unavailableWarehouses.length} unavailable/closed/maintenance).`,
    classification: 'VERIFIED FACT',
    observedAt: new Date().toISOString(),
    sourceStatus: warehouses.length > 0 ? 'FRESH' : 'UNAVAILABLE',
    snapshot: {
      operationalCount: operationalWarehouses.length,
      unavailableWarehouses: unavailableWarehouses.map((w) => ({ id: w.id, name: w.name, status: w.status })),
    },
  });
  evidence.push(whEv);

  if (unavailableWarehouses.length > 0) {
    warnings.push(
      `Unavailable warehouse(s) excluded from dispatch eligibility: ${unavailableWarehouses
        .map((w) => `${w.name} (${w.status})`)
        .join(', ')}.`
    );
  }

  // Strictly separate available vs reserved vs in-transit stock
  const operationalWhIds = new Set(operationalWarehouses.map((w) => w.id));
  const availByCat: Record<string, number> = {};
  const reservedByCat: Record<string, number> = {};
  const inTransitByCat: Record<string, number> = {};

  for (const stock of inventory) {
    const isOp = operationalWhIds.has(stock.warehouseId);
    if (isOp) {
      availByCat[stock.category] = (availByCat[stock.category] || 0) + Math.max(0, stock.availableQty);
    }
    reservedByCat[stock.category] = (reservedByCat[stock.category] || 0) + Math.max(0, stock.reservedQty);
    inTransitByCat[stock.category] = (inTransitByCat[stock.category] || 0) + Math.max(0, stock.inTransitQty || 0);
  }

  const demandByCat: Record<string, number> = {};
  for (const req of requests) {
    for (const item of req.items) {
      demandByCat[item.category] = (demandByCat[item.category] || 0) + item.quantity;
    }
  }

  const stockEv = makeEvidence({
    session,
    task,
    agentId: 'agent-resource-intel',
    sourceType: 'inventory',
    sourceId: inventory[0]?.id || 'inventory-ledger',
    claim: `Operational available stock across ${inventory.length} SKU records: ${Object.entries(availByCat)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ') || 'none'}. Reserved stock (${Object.values(reservedByCat).reduce((a, b) => a + b, 0)} units across ${reservations.length} reservation(s)) and in-transit stock (${Object.values(inTransitByCat).reduce((a, b) => a + b, 0)} units, ${incoming.length} incoming shipment(s)) are excluded from freely available balance.`,
    classification: 'CALCULATED RESULT',
    observedAt: inventory[0]?.updatedAt || null,
    sourceStatus: inventory.length > 0 ? 'FRESH' : 'UNAVAILABLE',
    snapshot: { availByCat, reservedByCat, inTransitByCat, demandByCat },
  });
  evidence.push(stockEv);

  const unmetCategories: { category: string; demand: number; available: number; shortage: number }[] = [];
  for (const [cat, demand] of Object.entries(demandByCat)) {
    const avail = availByCat[cat] || 0;
    if (demand > avail) {
      unmetCategories.push({ category: cat, demand, available: avail, shortage: demand - avail });
    }
  }

  if (unmetCategories.length > 0) {
    findings.push({
      title: `Immediate Stock Deficit Detected in ${unmetCategories.length} Category(ies)`,
      detail: unmetCategories
        .map((u) => `${u.category}: requested ${u.demand}, freely available ${u.available}, shortage ${u.shortage}`)
        .join(' | '),
      classification: 'CALCULATED RESULT',
      severity: 'critical',
      evidence_ids: [stockEv.evidence_id, whEv.evidence_id],
    });
    for (const u of unmetCategories) {
      recommendations.push(
        makeRecommendation({
          session,
          task,
          agentId: 'agent-resource-intel',
          type: 'replenishment',
          priority: 'critical',
          title: `Replenish or rebalance ${u.category} (shortage: ${u.shortage} units)`,
          description: `Operational warehouses hold ${u.available} freely available units of ${u.category} against ${u.demand} requested units. Reserved and in-transit quantities cannot be double-allocated.`,
          actionType: 'REQUEST_REPLENISHMENT',
          proposedParameters: {
            category: u.category,
            shortageQty: u.shortage,
            availableQty: u.available,
            demandQty: u.demand,
          },
          reasoning: 'Deterministic stock ledger check confirms available stock is below incident demand.',
          evidenceIds: [stockEv.evidence_id],
          constraints: ['Do not allocate reserved stock or unverified incoming supplies.'],
          risk: 'Unmet critical relief demand if replenishment or split reallocation is delayed.',
        })
      );
    }
  } else if (requests.length > 0) {
    findings.push({
      title: 'Operational Available Stock Covers Current Incident Requests',
      detail: `All ${requests.length} open relief request(s) can be covered by freely available stock across ${operationalWarehouses.length} operational warehouse(s).`,
      classification: 'CALCULATED RESULT',
      severity: 'info',
      evidence_ids: [stockEv.evidence_id, whEv.evidence_id],
    });
  } else {
    missingInfo.push('No open relief requests exist for this incident yet to size exact resource demand.');
  }

  const criticalShortages = shortageSummary.recommendations.filter(
    (s) => s.alertLevel === 'CRITICAL' || s.alertLevel === 'OUT_OF_STOCK'
  );
  if (criticalShortages.length > 0) {
    findings.push({
      title: `${criticalShortages.length} Critical Threshold Violation(s) System-Wide`,
      detail: criticalShortages
        .slice(0, 4)
        .map((s) => `${s.itemName} @ ${s.warehouseName}: ${s.currentAvailable} avail (min ${s.minThreshold})`)
        .join(' | '),
      classification: 'CALCULATED RESULT',
      severity: 'high',
      evidence_ids: [stockEv.evidence_id],
    });
  }

  // Recommend allocation for open unallocated requests
  for (const req of requests.slice(0, 2)) {
    const reqEv = makeEvidence({
      session,
      task,
      agentId: 'agent-resource-intel',
      sourceType: 'relief_request',
      sourceId: req.id,
      claim: `Relief request ${req.id} for ${req.locationName} (${req.urgency} urgency): ${req.items
        .map((i) => `${i.quantity} ${i.unit} ${i.itemName}`)
        .join(', ')}.`,
      classification: req.verificationStatus === 'verified' ? 'VERIFIED FACT' : 'ASSUMPTION',
      observedAt: req.createdAt,
      sourceStatus: req.verificationStatus === 'verified' ? 'FRESH' : 'UNVERIFIED',
    });
    evidence.push(reqEv);

    const existingAlloc = store.state.allocations.find(
      (a) => a.requestId === req.id && a.mode === session.mode && a.status !== 'rejected'
    );
    if (!existingAlloc && operationalWarehouses.length > 0) {
      recommendations.push(
        makeRecommendation({
          session,
          task,
          agentId: 'agent-resource-intel',
          type: 'resource_allocation',
          priority: req.urgency === 'critical' ? 'critical' : 'high',
          title: `Generate multi-warehouse allocation for request ${req.id.slice(0, 8)} (${req.locationName})`,
          description: `Prepare a deterministic multi-warehouse allocation plan for ${req.items
            .map((i) => `${i.quantity} ${i.itemName}`)
            .join(', ')} using only operational warehouses and unreserved stock.`,
          actionType: 'CREATE_ALLOCATION',
          proposedParameters: {
            requestId: req.id,
            incidentId: req.incidentId,
            items: req.items,
          },
          reasoning: 'Open relief request has no active allocation plan yet.',
          evidenceIds: [reqEv.evidence_id, stockEv.evidence_id, whEv.evidence_id],
          constraints: ['Must pass stock lock and human approval before reserving or dispatching inventory.'],
          risk: 'Delay in allocation increases stock contention from concurrent incidents.',
        })
      );
    }
  }

  return AIAgentResultSchema.parse({
    result_id: uuidv4(),
    agent_id: 'agent-resource-intel',
    agent_version: task.agent_version,
    session_id: session.session_id,
    task_id: task.task_id,
    org_id: session.org_id,
    status: 'COMPLETED',
    summary: `Audited ${warehouses.length} warehouse(s) (${operationalWarehouses.length} operational), ${inventory.length} stock record(s), ${reservations.length} active reservation(s), and ${requests.length} open relief request(s). ${
      unmetCategories.length > 0
        ? `Deficit found in ${unmetCategories.map((u) => u.category).join(', ')}.`
        : 'No immediate category deficit detected against open requests.'
    }`,
    findings,
    recommendations,
    evidence,
    missing_information: missingInfo,
    warnings,
    confidence: inventory.length > 0 ? 0.92 : 0.4,
    data_freshness: inventory.length > 0 ? 'FRESH' : 'UNAVAILABLE',
    tool_calls_used: task.tool_calls_used,
    tools_invoked: toolsInvoked,
    ai_provider_used: null,
    ai_model_used: null,
    ai_synthesis_status: 'DETERMINISTIC_ONLY',
    tokens_estimated: 0,
    created_at: new Date().toISOString(),
    execution_time_ms: Date.now() - started,
    mode: session.mode,
  }) as AIAgentResult;
}

function runHumanImpactAgent(
  session: AICoordinationSession,
  task: AIAgentTask,
  actor: RequestActor
): AIAgentResult {
  const started = Date.now();
  const guard: ToolGuardContext = {
    agentId: 'agent-human-impact',
    task,
    actor,
    mode: session.mode,
    orgId: session.org_id,
  };
  const toolsInvoked: string[] = [];
  const evidence: AIEvidenceRecord[] = [];
  const findings: AIAgentResult['findings'] = [];
  const recommendations: AIRecommendation[] = [];
  const missingInfo: string[] = [];
  const warnings: string[] = [];

  const allIncidents = invokeAuthorizedTool(guard, 'read_all_incidents', () => {
    toolsInvoked.push('read_all_incidents');
    return getScopedIncidents(session.mode, actor, session.org_id).filter(
      (i) => i.status !== 'resolved' && i.status !== 'archived'
    );
  });

  const focusIncident = session.incident_id
    ? allIncidents.find((i) => i.id === session.incident_id) || null
    : allIncidents[0] || null;

  const requests = invokeAuthorizedTool(guard, 'read_relief_requests', () => {
    toolsInvoked.push('read_relief_requests');
    return store.state.reliefRequests.filter((r) => r.mode === session.mode);
  });

  const deliveries = invokeAuthorizedTool(guard, 'read_deliveries', () => {
    toolsInvoked.push('read_deliveries');
    return store.state.deliveryConfirmations.filter((d) => d.mode === session.mode);
  });

  if (!focusIncident) {
    missingInfo.push('No active incident available for human impact evaluation.');
    return AIAgentResultSchema.parse({
      result_id: uuidv4(),
      agent_id: 'agent-human-impact',
      agent_version: task.agent_version,
      session_id: session.session_id,
      task_id: task.task_id,
      org_id: session.org_id,
      status: 'COMPLETED',
      summary: 'No active incident found to evaluate human impact or vulnerability prioritization.',
      findings: [],
      recommendations: [],
      evidence: [],
      missing_information: missingInfo,
      warnings,
      confidence: 0.25,
      data_freshness: 'UNAVAILABLE',
      tool_calls_used: task.tool_calls_used,
      tools_invoked: toolsInvoked,
      ai_provider_used: null,
      ai_model_used: null,
      ai_synthesis_status: 'DETERMINISTIC_ONLY',
      tokens_estimated: 0,
      created_at: new Date().toISOString(),
      execution_time_ms: Date.now() - started,
      mode: session.mode,
    }) as AIAgentResult;
  }

  const vulnerableRatio =
    focusIncident.peopleAffected > 0
      ? Number(((focusIncident.vulnerablePopulation / focusIncident.peopleAffected) * 100).toFixed(1))
      : null;

  const impactEv = makeEvidence({
    session,
    task,
    agentId: 'agent-human-impact',
    sourceType: 'incident',
    sourceId: focusIncident.id,
    claim: `Reported affected population: ${focusIncident.peopleAffected} people (${focusIncident.vulnerablePopulation} vulnerable${
      vulnerableRatio != null ? `, ${vulnerableRatio}%` : ''
    }).`,
    classification: focusIncident.verificationStatus === 'verified' ? 'VERIFIED FACT' : 'ASSUMPTION',
    observedAt: focusIncident.updatedAt,
    sourceStatus: focusIncident.verificationStatus === 'verified' ? 'FRESH' : 'UNVERIFIED',
    snapshot: {
      peopleAffected: focusIncident.peopleAffected,
      vulnerablePopulation: focusIncident.vulnerablePopulation,
      vulnerableRatioPct: vulnerableRatio,
    },
  });
  evidence.push(impactEv);

  if (focusIncident.peopleAffected === 0) {
    missingInfo.push(`Affected population count is 0/unreported for incident ${focusIncident.id}; do not fabricate estimates.`);
  }

  findings.push({
    title: `Human Impact Profile: ${focusIncident.peopleAffected} Affected (${focusIncident.vulnerablePopulation} Vulnerable)`,
    detail: `Vulnerable share is ${vulnerableRatio != null ? `${vulnerableRatio}%` : 'unknown'}. Immediate needs listed: ${
      focusIncident.immediateNeeds?.join(', ') || 'none explicitly specified'
    }.`,
    classification: focusIncident.verificationStatus === 'verified' ? 'VERIFIED FACT' : 'ASSUMPTION',
    severity: focusIncident.vulnerablePopulation >= 100 || focusIncident.peopleAffected >= 500 ? 'critical' : 'high',
    evidence_ids: [impactEv.evidence_id],
  });

  // Identify competing or under-served incidents (equity check)
  const otherHighNeed = allIncidents.filter(
    (i) =>
      i.id !== focusIncident.id &&
      (i.severity === 'critical' || i.severity === 'high' || i.vulnerablePopulation >= 50)
  );
  if (otherHighNeed.length > 0) {
    const underserved = otherHighNeed.filter((inc) => {
      const incReqs = requests.filter((r) => r.incidentId === inc.id);
      return incReqs.every((r) => r.status === 'submitted' || r.status === 'verified' || r.status === 'prioritized');
    });
    if (underserved.length > 0) {
      const eqEv = makeEvidence({
        session,
        task,
        agentId: 'agent-human-impact',
        sourceType: 'incident',
        sourceId: underserved[0].id,
        claim: `${underserved.length} concurrent high-need incident(s) currently have unfulfilled relief demand (${underserved
          .map((u) => `${u.title}: ${u.peopleAffected} affected`)
          .join('; ')}).`,
        classification: 'CALCULATED RESULT',
        observedAt: new Date().toISOString(),
        sourceStatus: 'FRESH',
      });
      evidence.push(eqEv);
      findings.push({
        title: `Fairness & Competing Humanitarian Demand (${underserved.length} Incident(s))`,
        detail: `Do not exhaust all warehouse buffers on one incident without preserving reserve allocations for: ${underserved
          .map((u) => `${u.title} (${u.vulnerablePopulation} vulnerable)`)
          .join(', ')}.`,
        classification: 'CALCULATED RESULT',
        severity: 'high',
        evidence_ids: [eqEv.evidence_id],
      });
    }
  }

  const partialDeliveries = deliveries.filter((d) => d.status === 'PARTIALLY_DELIVERED');
  if (partialDeliveries.length > 0) {
    warnings.push(
      `${partialDeliveries.length} partial delivery confirmation(s) exist with remaining unmet items requiring follow-up dispatch.`
    );
  }

  if (focusIncident.vulnerablePopulation >= 50) {
    recommendations.push(
      makeRecommendation({
        session,
        task,
        agentId: 'agent-human-impact',
        type: 'humanitarian_priority',
        priority: 'critical',
        title: `Prioritize vulnerable population relief (${focusIncident.vulnerablePopulation} vulnerable persons)`,
        description: `Ensure medical kits, clean drinking water, and shelter supplies for incident ${focusIncident.id} are prioritized ahead of non-urgent restocking.`,
        actionType: 'ADVISORY_ONLY',
        proposedParameters: {
          incidentId: focusIncident.id,
          vulnerablePopulation: focusIncident.vulnerablePopulation,
          peopleAffected: focusIncident.peopleAffected,
        },
        reasoning: 'High vulnerable headcount requires life-safety prioritization under humanitarian equity rules.',
        evidenceIds: [impactEv.evidence_id],
        constraints: ['Maintain fairness reserve for concurrent high-vulnerability incidents.'],
        risk: 'Delayed medical/water delivery disproportionately harms vulnerable groups.',
      })
    );
  }

  return AIAgentResultSchema.parse({
    result_id: uuidv4(),
    agent_id: 'agent-human-impact',
    agent_version: task.agent_version,
    session_id: session.session_id,
    task_id: task.task_id,
    org_id: session.org_id,
    status: 'COMPLETED',
    summary: `Incident ${focusIncident.id} affects ${focusIncident.peopleAffected} people (${focusIncident.vulnerablePopulation} vulnerable). ${otherHighNeed.length} concurrent high-need incident(s) monitored for fairness.`,
    findings,
    recommendations,
    evidence,
    missing_information: missingInfo,
    warnings,
    confidence: focusIncident.peopleAffected > 0 ? 0.85 : 0.45,
    data_freshness: focusIncident.peopleAffected > 0 ? 'FRESH' : 'PARTIAL',
    tool_calls_used: task.tool_calls_used,
    tools_invoked: toolsInvoked,
    ai_provider_used: null,
    ai_model_used: null,
    ai_synthesis_status: 'DETERMINISTIC_ONLY',
    tokens_estimated: 0,
    created_at: new Date().toISOString(),
    execution_time_ms: Date.now() - started,
    mode: session.mode,
  }) as AIAgentResult;
}

function runLogisticsRouteAgent(
  session: AICoordinationSession,
  task: AIAgentTask,
  actor: RequestActor
): AIAgentResult {
  const started = Date.now();
  const guard: ToolGuardContext = {
    agentId: 'agent-logistics-intel',
    task,
    actor,
    mode: session.mode,
    orgId: session.org_id,
  };
  const toolsInvoked: string[] = [];
  const evidence: AIEvidenceRecord[] = [];
  const findings: AIAgentResult['findings'] = [];
  const recommendations: AIRecommendation[] = [];
  const missingInfo: string[] = [];
  const warnings: string[] = [
    'ROAD CONDITIONS NOT VERIFIED: Route planning does not guarantee disaster road passability without field confirmation.',
  ];

  const incident = invokeAuthorizedTool(guard, 'read_incident', () => {
    toolsInvoked.push('read_incident');
    const scoped = getScopedIncidents(session.mode, actor, session.org_id);
    return session.incident_id ? scoped.find((i) => i.id === session.incident_id) || null : scoped[0] || null;
  });

  const warehouses = invokeAuthorizedTool(guard, 'read_warehouses', () => {
    toolsInvoked.push('read_warehouses');
    return getScopedWarehouses(session.mode);
  });

  const vehicles = invokeAuthorizedTool(guard, 'read_vehicles', () => {
    toolsInvoked.push('read_vehicles');
    return store.state.vehicles.filter((v) => v.mode === session.mode);
  });

  const drivers = invokeAuthorizedTool(guard, 'read_drivers', () => {
    toolsInvoked.push('read_drivers');
    return store.state.drivers.filter((d) => d.mode === session.mode);
  });

  const hazards = invokeAuthorizedTool(guard, 'read_route_hazards', () => {
    toolsInvoked.push('read_route_hazards');
    return store.state.routeHazards.filter((h) => h.mode === session.mode && h.active);
  });

  const requests = invokeAuthorizedTool(guard, 'read_relief_requests', () => {
    toolsInvoked.push('read_relief_requests');
    return store.state.reliefRequests.filter(
      (r) => r.mode === session.mode && r.status !== 'delivered' && r.status !== 'closed' && (!incident || r.incidentId === incident.id)
    );
  });

  const dispatches = invokeAuthorizedTool(guard, 'read_dispatches', () => {
    toolsInvoked.push('read_dispatches');
    return store.state.dispatches.filter((d) => d.mode === session.mode);
  });

  const availableVehicles = vehicles.filter(
    (v) => v.status === 'available' && v.maintenanceStatus !== 'in_maintenance' && v.maintenanceStatus !== 'out_of_service'
  );
  const availableDrivers = drivers.filter((d) => d.status === 'Available');

  const fleetEv = makeEvidence({
    session,
    task,
    agentId: 'agent-logistics-intel',
    sourceType: 'vehicle',
    sourceId: availableVehicles[0]?.id || 'fleet-pool',
    claim: `Fleet readiness: ${availableVehicles.length}/${vehicles.length} vehicle(s) available; ${availableDrivers.length}/${drivers.length} driver(s) available.`,
    classification: 'VERIFIED FACT',
    observedAt: new Date().toISOString(),
    sourceStatus: vehicles.length > 0 ? 'FRESH' : 'UNAVAILABLE',
    snapshot: {
      availableVehicles: availableVehicles.map((v) => ({
        id: v.id,
        callsign: v.callsign,
        warehouseId: v.warehouseId,
        capacityUnits: v.capacityUnits,
      })),
      availableDriverCount: availableDrivers.length,
    },
  });
  evidence.push(fleetEv);

  if (availableVehicles.length === 0) {
    warnings.push('No available vehicles currently idle in fleet; dispatch requires vehicle reallocation or external partner support.');
  }
  if (availableDrivers.length === 0) {
    missingInfo.push('No available drivers currently unassigned.');
  }

  // Evaluate nearby hazards
  const nearbyHazards = incident
    ? hazards.filter((h) => haversineKm(h.lat, h.lng, incident.lat, incident.lng) <= 50)
    : hazards;

  for (const hz of nearbyHazards.slice(0, 5)) {
    const hzDesc = sanitizeUntrustedForAgent(hz.description);
    const hzEv = makeEvidence({
      session,
      task,
      agentId: 'agent-logistics-intel',
      sourceType: 'route_hazard',
      sourceId: hz.id,
      claim: `Active route hazard (${hz.type}, ${hz.severity}, verified=${hz.verified}): ${hzDesc.sanitized}`,
      classification: hz.verified ? 'VERIFIED FACT' : 'ASSUMPTION',
      observedAt: hz.createdAt,
      sourceStatus: hz.verified ? 'FRESH' : 'UNVERIFIED',
      snapshot: { id: hz.id, type: hz.type, severity: hz.severity, verified: hz.verified },
    });
    evidence.push(hzEv);
  }

  if (nearbyHazards.length > 0) {
    findings.push({
      title: `${nearbyHazards.length} Active Corridor Route Hazard(s) Within 50 km`,
      detail: nearbyHazards
        .map((h) => `${h.type} (${h.severity}, ${h.verified ? 'verified' : 'unverified'})`)
        .join(' | '),
      classification: 'VERIFIED FACT',
      severity: nearbyHazards.some((h) => h.severity === 'critical' || h.severity === 'high') ? 'critical' : 'high',
      evidence_ids: evidence.filter((e) => e.source_type === 'route_hazard').map((e) => e.evidence_id),
    });
  }

  // Match candidate warehouses for top open request
  const topRequest = requests[0] || null;
  if (topRequest) {
    const matches = invokeAuthorizedTool(guard, 'match_warehouses_readonly', () => {
      toolsInvoked.push('match_warehouses_readonly');
      return matchWarehousesForRequest(topRequest);
    });

    const bestMatch = matches[0] || null;
    if (bestMatch) {
      const wh = warehouses.find((w) => w.id === bestMatch.warehouseId);
      const distLabel = bestMatch.estimatedDistanceKm != null ? `${bestMatch.estimatedDistanceKm} km` : 'distance N/A';
      const matchEv = makeEvidence({
        session,
        task,
        agentId: 'agent-logistics-intel',
        sourceType: 'warehouse',
        sourceId: bestMatch.warehouseId,
        claim: `Top matched warehouse: ${bestMatch.warehouseName} (${distLabel}, fulfillable ${bestMatch.fulfillableQty}/${bestMatch.requestedQty}, shortage ${bestMatch.shortageQty}).`,
        classification: 'CALCULATED RESULT',
        observedAt: new Date().toISOString(),
        sourceStatus: wh && isWarehouseOperationalForDispatch(wh.status, wh.active) ? 'FRESH' : 'STALE',
        snapshot: {
          warehouseId: bestMatch.warehouseId,
          warehouseName: bestMatch.warehouseName,
          estimatedDistanceKm: bestMatch.estimatedDistanceKm,
          fulfillableQty: bestMatch.fulfillableQty,
          shortageQty: bestMatch.shortageQty,
        },
      });
      evidence.push(matchEv);

      const candidateVehicle =
        availableVehicles.find((v) => v.warehouseId === bestMatch.warehouseId) || availableVehicles[0] || null;
      const candidateDriver =
        availableDrivers.find((d) => !candidateVehicle?.driverId || d.id === candidateVehicle.driverId) ||
        availableDrivers[0] ||
        null;

      findings.push({
        title: `Recommended Staging Hub: ${bestMatch.warehouseName} (${distLabel})`,
        detail: `${bestMatch.reason}. Candidate vehicle: ${candidateVehicle ? `${candidateVehicle.callsign} (cap ${candidateVehicle.capacityUnits})` : 'NONE AVAILABLE'}. Driver: ${candidateDriver ? candidateDriver.name : 'NONE AVAILABLE'}.`,
        classification: 'CALCULATED RESULT',
        severity: candidateVehicle ? 'info' : 'high',
        evidence_ids: [matchEv.evidence_id, fleetEv.evidence_id],
      });

      if (candidateVehicle && wh && isWarehouseOperationalForDispatch(wh.status, wh.active)) {
        const existingAlloc = store.state.allocations.find(
          (a) => a.requestId === topRequest.id && a.mode === session.mode && a.status !== 'rejected'
        );
        recommendations.push(
          makeRecommendation({
            session,
            task,
            agentId: 'agent-logistics-intel',
            type: 'dispatch_plan',
            priority: topRequest.urgency === 'critical' ? 'critical' : 'high',
            title: `Stage pending dispatch from ${bestMatch.warehouseName} using ${candidateVehicle.callsign}`,
            description: `Prepare a pending dispatch for request ${topRequest.id.slice(0, 8)} (${topRequest.locationName}) using vehicle ${candidateVehicle.callsign}${
              candidateDriver ? ` and driver ${candidateDriver.name}` : ''
            }. Dispatch remains PENDING_APPROVAL until authorized commander approval.`,
            actionType: 'CREATE_PENDING_DISPATCH',
            proposedParameters: {
              requestId: topRequest.id,
              allocationId: existingAlloc?.id || null,
              warehouseId: bestMatch.warehouseId,
              vehicleId: candidateVehicle.id,
              driverId: candidateDriver?.id || null,
              avoidHazards: nearbyHazards.length > 0,
            },
            reasoning: `Warehouse ${bestMatch.warehouseName} offers highest combined proximity and available stock match.`,
            evidenceIds: [matchEv.evidence_id, fleetEv.evidence_id],
            constraints: [
              'Requires approved allocation and explicit commander dispatch approval.',
              'ROAD CONDITIONS NOT VERIFIED — confirm local road passability before departure.',
            ],
            risk: nearbyHazards.length > 0 ? 'Active route hazard detected nearby; select lowest-risk alternate corridor.' : 'Standard transit risk; live GPS availability depends on field unit telemetry.',
          })
        );
      }
    }
  } else {
    missingInfo.push('No open relief request linked to incident for route/dispatch planning.');
  }

  const delayedDispatches = dispatches.filter(
    (d) => d.etaStatus === 'DELAYED' || d.status === 'DELAYED'
  );
  if (delayedDispatches.length > 0) {
    findings.push({
      title: `${delayedDispatches.length} Active Delayed/Rerouted Dispatch(es)`,
      detail: delayedDispatches.map((d) => `${d.vehicleCallsign} → ${d.destinationName} (${d.status})`).join(' | '),
      classification: 'VERIFIED FACT',
      severity: 'high',
      evidence_ids: [fleetEv.evidence_id],
    });
  }

  return AIAgentResultSchema.parse({
    result_id: uuidv4(),
    agent_id: 'agent-logistics-intel',
    agent_version: task.agent_version,
    session_id: session.session_id,
    task_id: task.task_id,
    org_id: session.org_id,
    status: 'COMPLETED',
    summary: `Evaluated ${warehouses.length} warehouse(s), ${availableVehicles.length}/${vehicles.length} available vehicle(s), ${availableDrivers.length} driver(s), and ${nearbyHazards.length} nearby route hazard(s).`,
    findings,
    recommendations,
    evidence,
    missing_information: missingInfo,
    warnings,
    confidence: availableVehicles.length > 0 ? 0.86 : 0.55,
    data_freshness: warehouses.length > 0 ? 'FRESH' : 'UNAVAILABLE',
    tool_calls_used: task.tool_calls_used,
    tools_invoked: toolsInvoked,
    ai_provider_used: null,
    ai_model_used: null,
    ai_synthesis_status: 'DETERMINISTIC_ONLY',
    tokens_estimated: 0,
    created_at: new Date().toISOString(),
    execution_time_ms: Date.now() - started,
    mode: session.mode,
  }) as AIAgentResult;
}

// ============================================================================
// CONFLICT DETECTION & RESOLUTION ENGINE
// ============================================================================

function detectAndRecordConflicts(params: {
  session: AICoordinationSession;
  results: AIAgentResult[];
  planId: string;
}): AIConflictRecord[] {
  const { session, results, planId } = params;
  const conflicts: AIConflictRecord[] = [];
  const now = new Date().toISOString();

  const resAgent = results.find((r) => r.agent_id === 'agent-resource-intel');
  const logAgent = results.find((r) => r.agent_id === 'agent-logistics-intel');
  const envAgent = results.find((r) => r.agent_id === 'agent-environmental-intel');
  const humAgent = results.find((r) => r.agent_id === 'agent-human-impact');

  // Conflict 1: Logistics proposed warehouse vs Resource detected shortage or warehouse closure
  const dispatchRec = logAgent?.recommendations.find((r) => r.action_type === 'CREATE_PENDING_DISPATCH');
  const replRecs = resAgent?.recommendations.filter((r) => r.action_type === 'REQUEST_REPLENISHMENT') || [];
  if (dispatchRec && replRecs.length > 0) {
    const whId = String(dispatchRec.proposed_parameters.warehouseId || '');
    const wh = store.state.warehouses.find((w) => w.id === whId);
    const conflict: AIConflictRecord = {
      conflict_id: `conf-${uuidv4().slice(0, 10)}`,
      session_id: session.session_id,
      plan_id: planId,
      org_id: session.org_id,
      incident_id: session.incident_id,
      conflict_type: 'WAREHOUSE_SHORTAGE_VS_PREFERENCE',
      severity: 'high',
      involved_agents: ['agent-logistics-intel', 'agent-resource-intel'],
      title: `Staging hub ${wh?.name || whId} proposed while category shortage exists`,
      description: `Logistics Agent proposed dispatching from ${wh?.name || whId}, while Resource Agent confirmed freely available stock deficit (${replRecs
        .map((r) => r.title)
        .join('; ')}).`,
      conflicting_claims: [
        {
          agent_id: 'agent-logistics-intel',
          claim: dispatchRec.title,
          evidence_ids: dispatchRec.evidence_ids,
        },
        {
          agent_id: 'agent-resource-intel',
          claim: replRecs[0].title,
          evidence_ids: replRecs[0].evidence_ids,
        },
      ],
      revalidated_fact:
        'Live ledger confirms available stock is lower than total request quantity; only freely available unreserved stock can be allocated via split-fulfillment while replenishment is ordered.',
      resolution_status: 'ESCALATED_HUMAN',
      resolution_strategy:
        'Use partial/split allocation for immediately available unreserved units and escalate shortage replenishment to commander.',
      resolved_by: null,
      resolved_at: null,
      resolution_note: null,
      created_at: now,
      mode: session.mode,
    };
    conflicts.push(conflict);
  }

  // Conflict 2: Active route hazards vs high-priority dispatch
  const hazardEvidence = logAgent?.evidence.filter((e) => e.source_type === 'route_hazard') || [];
  if (dispatchRec && hazardEvidence.length > 0) {
    conflicts.push({
      conflict_id: `conf-${uuidv4().slice(0, 10)}`,
      session_id: session.session_id,
      plan_id: planId,
      org_id: session.org_id,
      incident_id: session.incident_id,
      conflict_type: 'ROUTE_HAZARD_VS_PRIORITY',
      severity: 'high',
      involved_agents: ['agent-logistics-intel', 'agent-human-impact'],
      title: 'Urgent delivery priority conflicts with active corridor route hazard',
      description: `${hazardEvidence.length} active route hazard(s) reported near the delivery corridor for urgent incident ${session.incident_id || 'target'}.`,
      conflicting_claims: [
        {
          agent_id: 'agent-human-impact',
          claim: humAgent?.summary || 'High-priority vulnerable population requires rapid relief delivery.',
          evidence_ids: humAgent?.evidence.map((e) => e.evidence_id) || [],
        },
        {
          agent_id: 'agent-logistics-intel',
          claim: hazardEvidence[0].claim,
          evidence_ids: hazardEvidence.map((e) => e.evidence_id),
        },
      ],
      revalidated_fact:
        'Active hazard records exist in route_hazards table; safest verified alternate route or field road verification is mandatory before dispatch.',
      resolution_status: 'ESCALATED_HUMAN',
      resolution_strategy:
        'Require lowest-risk alternate route selection and commander sign-off before releasing convoy.',
      resolved_by: null,
      resolved_at: null,
      resolution_note: null,
      created_at: now,
      mode: session.mode,
    });
  }

  // Conflict 3: Severe weather vs dispatch
  const severeWeather = envAgent?.findings.some((f) => f.severity === 'high' || f.severity === 'critical');
  if (dispatchRec && severeWeather) {
    conflicts.push({
      conflict_id: `conf-${uuidv4().slice(0, 10)}`,
      session_id: session.session_id,
      plan_id: planId,
      org_id: session.org_id,
      incident_id: session.incident_id,
      conflict_type: 'WEATHER_RISK_VS_DISPATCH',
      severity: 'medium',
      involved_agents: ['agent-environmental-intel', 'agent-logistics-intel'],
      title: 'Severe weather exposure along proposed dispatch corridor',
      description: 'Environmental Agent flagged severe rainfall/wind triggers concurrent with Logistics dispatch proposal.',
      conflicting_claims: [
        {
          agent_id: 'agent-environmental-intel',
          claim: envAgent?.summary || 'Severe meteorological conditions observed.',
          evidence_ids: envAgent?.evidence.map((e) => e.evidence_id) || [],
        },
        {
          agent_id: 'agent-logistics-intel',
          claim: dispatchRec.title,
          evidence_ids: dispatchRec.evidence_ids,
        },
      ],
      revalidated_fact: 'Live weather telemetry confirms elevated weather hazard; dispatch requires waterproofed transport and field clearance.',
      resolution_status: 'RESOLVED_DETERMINISTIC',
      resolution_strategy: 'Attached weather safety constraint to pending dispatch plan; final go/no-go reserved for human commander.',
      resolved_by: 'deterministic-conflict-engine',
      resolved_at: now,
      resolution_note: 'Safety constraint appended automatically without blocking commander review.',
      created_at: now,
      mode: session.mode,
    });
  }

  // Conflict 4: Competing high-need incidents
  const equityFinding = humAgent?.findings.find((f) => f.title.includes('Competing Humanitarian Demand'));
  if (equityFinding && (dispatchRec || replRecs.length > 0)) {
    conflicts.push({
      conflict_id: `conf-${uuidv4().slice(0, 10)}`,
      session_id: session.session_id,
      plan_id: planId,
      org_id: session.org_id,
      incident_id: session.incident_id,
      conflict_type: 'COMPETING_INCIDENT_DEMAND',
      severity: 'high',
      involved_agents: ['agent-human-impact', 'agent-resource-intel'],
      title: 'Competing high-vulnerability incidents require reserve protection',
      description: equityFinding.detail,
      conflicting_claims: [
        {
          agent_id: 'agent-human-impact',
          claim: equityFinding.detail,
          evidence_ids: equityFinding.evidence_ids,
        },
        {
          agent_id: 'agent-resource-intel',
          claim: resAgent?.summary || 'Resource allocation proposed for focus incident.',
          evidence_ids: resAgent?.evidence.map((e) => e.evidence_id) || [],
        },
      ],
      revalidated_fact: 'Multiple active incidents in the same operational mode have unfulfilled demand.',
      resolution_status: 'ESCALATED_HUMAN',
      resolution_strategy: 'Preserve minimum safety threshold buffers across shared warehouses or require commander priority override.',
      resolved_by: null,
      resolved_at: null,
      resolution_note: null,
      created_at: now,
      mode: session.mode,
    });
  }

  for (const c of conflicts) {
    store.state.aiConflicts.unshift(c);
    recordSessionEvent({
      session,
      eventType: 'ai.conflict.detected',
      agentId: 'orchestrator',
      summary: `Conflict detected (${c.conflict_type}): ${c.title}`,
      details: { conflict_id: c.conflict_id, severity: c.severity, resolution_status: c.resolution_status },
    });
  }
  if (store.state.aiConflicts.length > 400) store.state.aiConflicts.length = 400;

  return conflicts;
}

// ============================================================================
// AGENT 6: RESPONSE PLANNING AGENT
// ============================================================================

async function runResponsePlanningAgent(params: {
  session: AICoordinationSession;
  task: AIAgentTask;
  actor: RequestActor;
  specialistResults: AIAgentResult[];
  skipLiveAI?: boolean;
}): Promise<{
  result: AIAgentResult;
  plan: AIResponsePlan;
  planActions: AIPlanAction[];
  conflicts: AIConflictRecord[];
}> {
  const started = Date.now();
  const { session, task, actor, specialistResults, skipLiveAI } = params;
  const guard: ToolGuardContext = {
    agentId: 'agent-response-planner',
    task,
    actor,
    mode: session.mode,
    orgId: session.org_id,
  };
  const toolsInvoked: string[] = [];

  const allRecs = invokeAuthorizedTool(guard, 'read_session_results', () => {
    toolsInvoked.push('read_session_results');
    return specialistResults.flatMap((r) => r.recommendations);
  });

  const priorMemory = invokeAuthorizedTool(guard, 'read_session_memory', () => {
    toolsInvoked.push('read_session_memory');
    return store.state.aiSessionMemory
      .filter(
        (m) =>
          m.mode === session.mode &&
          m.org_id === session.org_id &&
          (!session.incident_id || m.incident_id === session.incident_id)
      )
      .slice(0, 8);
  });

  // Deduplicate recommendations by action_type + title
  const seenKeys = new Set<string>();
  const dedupedRecs: AIRecommendation[] = [];
  for (const rec of allRecs) {
    const key = `${rec.action_type}:${rec.title.toLowerCase()}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      dedupedRecs.push(rec);
    }
  }

  const planId = `plan-${uuidv4().slice(0, 12)}`;
  const conflicts = detectAndRecordConflicts({ session, results: specialistResults, planId });

  const emerg = specialistResults.find((r) => r.agent_id === 'agent-emergency-intel');
  const env = specialistResults.find((r) => r.agent_id === 'agent-environmental-intel');
  const res = specialistResults.find((r) => r.agent_id === 'agent-resource-intel');
  const log = specialistResults.find((r) => r.agent_id === 'agent-logistics-intel');
  const hum = specialistResults.find((r) => r.agent_id === 'agent-human-impact');

  const allEvidenceIds = Array.from(
    new Set(specialistResults.flatMap((r) => r.evidence.map((e) => e.evidence_id)))
  );
  const allMissing = Array.from(new Set(specialistResults.flatMap((r) => r.missing_information)));
  const allWarnings = Array.from(new Set(specialistResults.flatMap((r) => r.warnings)));

  // Optional live AI narrative synthesis (strictly grounded, never fabricated on failure)
  const synthesisPayload = JSON.stringify({
    objective: session.objective,
    incident_id: session.incident_id,
    agent_summaries: specialistResults.map((r) => ({
      agent_id: r.agent_id,
      summary: r.summary,
      warnings: r.warnings,
      missing_information: r.missing_information,
    })),
    proposed_actions: dedupedRecs.map((r) => ({
      title: r.title,
      action_type: r.action_type,
      priority: r.priority,
    })),
    conflicts: conflicts.map((c) => ({
      type: c.conflict_type,
      title: c.title,
      resolution_status: c.resolution_status,
    })),
    prior_memory_count: priorMemory.length,
  });

  const aiSynth = await invokeAuthorizedTool(guard, 'invoke_ai_synthesis', () => {
    toolsInvoked.push('invoke_ai_synthesis');
    return synthesizeCoordinationPlanWithAI({
      groundedSummaryJson: synthesisPayload,
      timeoutMs: Math.min(session.limits.timeout_ms, 8000),
      maxTokenBudget: session.limits.token_budget,
      skipLiveAI,
    });
  });

  const plannerEvidence: AIEvidenceRecord[] = [];
  if (aiSynth.available && aiSynth.output) {
    plannerEvidence.push(
      makeEvidence({
        session,
        task,
        agentId: 'agent-response-planner',
        sourceType: 'ai_synthesis',
        sourceId: `${aiSynth.provider}:${aiSynth.model}`,
        claim: aiSynth.output.executive_summary,
        classification: 'AI INTERPRETATION',
        observedAt: new Date().toISOString(),
        sourceStatus: 'LIVE',
      })
    );
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString(); // 2h plan validity

  const planActions: AIPlanAction[] = dedupedRecs.map((rec) => ({
    action_id: `act-${uuidv4().slice(0, 10)}`,
    plan_id: planId,
    session_id: session.session_id,
    org_id: session.org_id,
    recommendation_id: rec.recommendation_id,
    title: rec.title,
    description: rec.description,
    action_type: rec.action_type,
    priority: rec.priority,
    proposed_parameters: rec.proposed_parameters,
    modified_parameters: null,
    evidence_ids: rec.evidence_ids,
    constraints: rec.constraints,
    risk: rec.risk,
    status: 'PROPOSED',
    requires_human_approval: true,
    executed_at: null,
    executed_by: null,
    execution_result: null,
    execution_error: null,
    mode: session.mode,
  }));

  const placeholderSafety: AISafetyValidationReport = {
    validation_id: `val-pending-${planId}`,
    session_id: session.session_id,
    plan_id: planId,
    status: 'INCOMPLETE',
    checked_at: now,
    checks: [],
    blocking_issues: [],
    warnings: [],
    missing_evidence: [],
    verified_evidence_count: 0,
    unverified_claim_count: 0,
    rbac_verified: false,
    stale_data_detected: false,
  };

  const plan: AIResponsePlan = {
    plan_id: planId,
    session_id: session.session_id,
    incident_id: session.incident_id,
    org_id: session.org_id,
    version: 1,
    title: `Coordinated Response Plan${session.incident_title ? ` — ${session.incident_title}` : ''}`,
    incident_summary: emerg?.summary || 'Incident summary unavailable.',
    risk_summary: `${emerg?.findings[0]?.detail || 'No deterministic risk delta available.'} | Weather: ${env?.summary || 'Unavailable.'}`,
    human_impact_summary: hum?.summary || 'Human impact data unavailable.',
    resource_strategy: res?.summary || 'Resource intelligence summary unavailable.',
    logistics_and_route_plan: log?.summary || 'Logistics plan unavailable.',
    alternative_options: [
      {
        title: 'Conservative Phased Staging (Split Allocation)',
        summary: 'Allocate immediately available unreserved stock first while awaiting field verification and replenishment.',
        tradeoffs: 'Preserves safety buffer for concurrent incidents; may require a second convoy wave.',
      },
      {
        title: 'Full Multi-Warehouse Escalation',
        summary: 'Combine stock across multiple operational hubs with commander priority override.',
        tradeoffs: 'Maximizes immediate incident fulfillment; increases transit complexity and fuel/fleet load.',
      },
    ],
    unresolved_conflicts: conflicts
      .filter((c) => c.resolution_status === 'OPEN' || c.resolution_status === 'ESCALATED_HUMAN')
      .map((c) => `${c.conflict_type}: ${c.title}`),
    missing_information: allMissing,
    verification_needed: Array.from(
      new Set([
        ...allWarnings.filter((w) => w.toLowerCase().includes('verif') || w.toLowerCase().includes('road')),
        ...(dedupedRecs
          .filter((r) => r.action_type === 'FIELD_VERIFICATION')
          .map((r) => r.title)),
      ])
    ),
    evidence_ids: [...allEvidenceIds, ...plannerEvidence.map((e) => e.evidence_id)],
    safety_validation: placeholderSafety,
    status: 'PENDING_APPROVAL',
    expires_at: expiresAt,
    approved_by: null,
    approved_at: null,
    rejection_reason: null,
    modification_notes: null,
    ai_synthesis_note: aiSynth.available && aiSynth.output
      ? `[AI INTERPRETATION · ${aiSynth.provider}/${aiSynth.model}] ${aiSynth.output.executive_summary} Uncertainty: ${aiSynth.output.uncertainty_statement}`
      : `[DETERMINISTIC SYNTHESIS ONLY] ${aiSynth.error || 'Live AI prose synthesis unavailable.'}`,
    requires_human_approval: true,
    created_at: now,
    updated_at: now,
    mode: session.mode,
  };

  const result = AIAgentResultSchema.parse({
    result_id: uuidv4(),
    agent_id: 'agent-response-planner',
    agent_version: task.agent_version,
    session_id: session.session_id,
    task_id: task.task_id,
    org_id: session.org_id,
    status: aiSynth.available ? 'COMPLETED' : 'DEGRADED',
    summary: `Synthesized unified response plan ${planId} with ${planActions.length} human-approvable action(s), ${conflicts.length} detected conflict(s), and ${plan.evidence_ids.length} grounded evidence reference(s).`,
    findings: [
      {
        title: `Unified Plan Generated (${planActions.length} Proposed Action(s))`,
        detail: plan.ai_synthesis_note || plan.incident_summary,
        classification: aiSynth.available ? 'AI INTERPRETATION' : 'CALCULATED RESULT',
        severity: conflicts.length > 0 ? 'high' : 'info',
        evidence_ids: plannerEvidence.map((e) => e.evidence_id),
      },
    ],
    recommendations: [],
    evidence: plannerEvidence,
    missing_information: allMissing,
    warnings: aiSynth.available ? [] : [`AI narrative provider unavailable (${aiSynth.error}); deterministic plan preserved without fabrication.`],
    confidence: allMissing.length === 0 ? 0.88 : 0.72,
    data_freshness: allMissing.length === 0 ? 'FRESH' : 'PARTIAL',
    tool_calls_used: task.tool_calls_used,
    tools_invoked: toolsInvoked,
    ai_provider_used: aiSynth.provider,
    ai_model_used: aiSynth.model,
    ai_synthesis_status: aiSynth.available ? 'LIVE_AI' : 'AI_UNAVAILABLE',
    tokens_estimated: aiSynth.tokensEstimated,
    created_at: now,
    execution_time_ms: Date.now() - started,
    mode: session.mode,
  }) as AIAgentResult;

  return { result, plan, planActions, conflicts };
}

// ============================================================================
// AGENT 7: RESPONSE MONITORING AGENT
// ============================================================================

function runResponseMonitoringAgent(
  session: AICoordinationSession,
  task: AIAgentTask,
  actor: RequestActor
): AIAgentResult {
  const started = Date.now();
  const guard: ToolGuardContext = {
    agentId: 'agent-response-monitor',
    task,
    actor,
    mode: session.mode,
    orgId: session.org_id,
  };
  const toolsInvoked: string[] = [];
  const evidence: AIEvidenceRecord[] = [];
  const findings: AIAgentResult['findings'] = [];

  const activeTriggers = invokeAuthorizedTool(guard, 'read_triggers', () => {
    toolsInvoked.push('read_triggers');
    return store.state.aiTriggerEvents.filter(
      (t) => t.mode === session.mode && t.status === 'ACTIVE' && (actor.role === 'super_admin' || t.org_id === session.org_id)
    );
  });

  const activeDispatches = invokeAuthorizedTool(guard, 'read_dispatches', () => {
    toolsInvoked.push('read_dispatches');
    return store.state.dispatches.filter(
      (d) => d.mode === session.mode && d.status !== 'delivered' && d.status !== 'cancelled'
    );
  });

  const delayed = activeDispatches.filter((d) => d.status === 'DELAYED' || d.etaStatus === 'DELAYED');

  const monEv = makeEvidence({
    session,
    task,
    agentId: 'agent-response-monitor',
    sourceType: 'dispatch',
    sourceId: delayed[0]?.id || activeDispatches[0]?.id || 'monitor-state',
    claim: `Monitoring snapshot: ${activeTriggers.length} active proactive trigger(s), ${activeDispatches.length} active dispatch(es) (${delayed.length} delayed).`,
    classification: 'VERIFIED FACT',
    observedAt: new Date().toISOString(),
    sourceStatus: 'FRESH',
  });
  evidence.push(monEv);

  findings.push({
    title: 'Operational Change & Trigger Watch',
    detail:
      activeTriggers.length > 0 || delayed.length > 0
        ? `${activeTriggers.length} active trigger(s) and ${delayed.length} delayed dispatch(es) warrant ongoing commander monitoring.`
        : 'No unacknowledged monitoring triggers or delayed dispatches detected.',
    classification: 'VERIFIED FACT',
    severity: delayed.length > 0 || activeTriggers.some((t) => t.severity === 'critical') ? 'high' : 'info',
    evidence_ids: [monEv.evidence_id],
  });

  return AIAgentResultSchema.parse({
    result_id: uuidv4(),
    agent_id: 'agent-response-monitor',
    agent_version: task.agent_version,
    session_id: session.session_id,
    task_id: task.task_id,
    org_id: session.org_id,
    status: 'COMPLETED',
    summary: `Monitored ${activeTriggers.length} active trigger(s) and ${activeDispatches.length} active dispatch(es) (${delayed.length} delayed).`,
    findings,
    recommendations: [],
    evidence,
    missing_information: [],
    warnings: [],
    confidence: 0.9,
    data_freshness: 'FRESH',
    tool_calls_used: task.tool_calls_used,
    tools_invoked: toolsInvoked,
    ai_provider_used: null,
    ai_model_used: null,
    ai_synthesis_status: 'DETERMINISTIC_ONLY',
    tokens_estimated: 0,
    created_at: new Date().toISOString(),
    execution_time_ms: Date.now() - started,
    mode: session.mode,
  }) as AIAgentResult;
}

// ============================================================================
// AGENT 8: DETERMINISTIC EVIDENCE & SAFETY VERIFICATION AGENT
// ============================================================================

export function runDeterministicSafetyValidation(params: {
  session: AICoordinationSession;
  plan: AIResponsePlan;
  planActions: AIPlanAction[];
  allEvidence: AIEvidenceRecord[];
  actor: RequestActor;
  task?: AIAgentTask;
}): { report: AISafetyValidationReport; agentResult?: AIAgentResult } {
  const started = Date.now();
  const { session, plan, planActions, allEvidence, actor, task } = params;
  const checks: AISafetyValidationReport['checks'] = [];
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
  const missingEvidence: string[] = [];
  let staleDetected = false;

  const toolsInvoked: string[] = [];
  const guard: ToolGuardContext | null = task
    ? {
        agentId: 'agent-safety-verifier',
        task,
        actor,
        mode: session.mode,
        orgId: session.org_id,
      }
    : null;

  const runTool = <T>(toolName: string, fn: () => T): T => {
    if (guard) {
      return invokeAuthorizedTool(guard, toolName, () => {
        toolsInvoked.push(toolName);
        return fn();
      });
    }
    return fn();
  };

  // 1. Incident existence & active state
  const incident = runTool('read_incident', () =>
    plan.incident_id
      ? store.state.incidents.find((i) => i.id === plan.incident_id && i.mode === session.mode) || null
      : null
  );
  if (plan.incident_id) {
    if (!incident) {
      blockingIssues.push(`Referenced incident ${plan.incident_id} does not exist in mode '${session.mode}'.`);
      checks.push({
        check_name: 'Incident Existence',
        category: 'incident',
        passed: false,
        severity: 'blocking',
        detail: `Incident ${plan.incident_id} not found.`,
      });
    } else if (incident.status === 'resolved' || incident.status === 'archived') {
      blockingIssues.push(`Incident ${incident.id} is already '${incident.status}' and cannot receive new dispatches.`);
      checks.push({
        check_name: 'Incident Active State',
        category: 'incident',
        passed: false,
        severity: 'blocking',
        detail: `Incident status is '${incident.status}'.`,
      });
    } else {
      checks.push({
        check_name: 'Incident Existence & Active State',
        category: 'incident',
        passed: true,
        severity: 'info',
        detail: `Incident ${incident.id} is active (${incident.status}, verification=${incident.verificationStatus}).`,
      });
      if (incident.verificationStatus !== 'verified') {
        warnings.push(`Incident ${incident.id} is '${incident.verificationStatus}'; verify before live dispatch execution.`);
      }
    }
  }

  // 2. Risk freshness
  const risk = runTool('read_risk_assessments', () =>
    plan.incident_id
      ? store.state.riskAssessments.find((r) => r.incidentId === plan.incident_id && r.mode === session.mode) || null
      : null
  );
  if (plan.incident_id && risk) {
    const fresh = computeFreshness(risk.createdAt, 1800);
    if (fresh !== 'fresh') {
      staleDetected = true;
      warnings.push(`Latest risk assessment ${risk.id} is stale (${risk.createdAt}).`);
    }
    checks.push({
      check_name: 'Risk Assessment Freshness',
      category: 'risk',
      passed: fresh === 'fresh',
      severity: fresh === 'fresh' ? 'info' : 'warning',
      detail: `Assessment ${risk.id} score=${risk.overallScore}/100 (${fresh}).`,
    });
  } else if (plan.incident_id) {
    missingEvidence.push(`Deterministic risk assessment missing for incident ${plan.incident_id}.`);
    checks.push({
      check_name: 'Risk Assessment Presence',
      category: 'risk',
      passed: false,
      severity: 'warning',
      detail: 'No risk assessment found.',
    });
  }

  // 3. Warehouse operational status, stock availability & fleet checks per action
  const warehouses = runTool('read_warehouses', () => store.state.warehouses.filter((w) => w.mode === session.mode));
  const inventory = runTool('read_inventory', () => store.state.inventory.filter((i) => i.mode === session.mode));
  const vehicles = runTool('read_vehicles', () => store.state.vehicles.filter((v) => v.mode === session.mode));
  const drivers = runTool('read_drivers', () => store.state.drivers.filter((d) => d.mode === session.mode));

  for (const act of planActions) {
    const paramsObj = act.modified_parameters || act.proposed_parameters;
    if (act.requires_human_approval !== true) {
      blockingIssues.push(`Action ${act.action_id} is missing mandatory requires_human_approval=true flag.`);
    }
    if (act.evidence_ids.length === 0) {
      missingEvidence.push(`Action "${act.title}" lacks linked evidence IDs.`);
    }

    if (act.action_type === 'CREATE_PENDING_DISPATCH') {
      const whId = String(paramsObj.warehouseId || '');
      const vehId = String(paramsObj.vehicleId || '');
      const drvId = paramsObj.driverId ? String(paramsObj.driverId) : null;

      const wh = warehouses.find((w) => w.id === whId);
      if (!wh || !isWarehouseOperationalForDispatch(wh.status, wh.active)) {
        blockingIssues.push(`Dispatch action "${act.title}" references non-operational or missing warehouse '${whId}'.`);
        checks.push({
          check_name: `Warehouse Operational (${whId})`,
          category: 'warehouse',
          passed: false,
          severity: 'blocking',
          detail: wh ? `Warehouse ${wh.name} status is '${wh.status}'.` : `Warehouse ${whId} not found.`,
        });
      } else {
        checks.push({
          check_name: `Warehouse Operational (${wh.name})`,
          category: 'warehouse',
          passed: true,
          severity: 'info',
          detail: `Warehouse ${wh.name} is operational.`,
        });
      }

      const veh = vehicles.find((v) => v.id === vehId);
      if (!veh || veh.status !== 'available' || veh.maintenanceStatus === 'in_maintenance' || veh.maintenanceStatus === 'out_of_service') {
        blockingIssues.push(`Dispatch action "${act.title}" references unavailable vehicle '${vehId}'.`);
        checks.push({
          check_name: `Vehicle Availability (${vehId})`,
          category: 'fleet',
          passed: false,
          severity: 'blocking',
          detail: veh ? `Vehicle ${veh.callsign} status is '${veh.status}'.` : `Vehicle ${vehId} not found.`,
        });
      } else {
        checks.push({
          check_name: `Vehicle Availability (${veh.callsign})`,
          category: 'fleet',
          passed: true,
          severity: 'info',
          detail: `Vehicle ${veh.callsign} is available (capacity ${veh.capacityUnits}).`,
        });
      }

      if (drvId) {
        const drv = drivers.find((d) => d.id === drvId);
        if (!drv || drv.status !== 'Available') {
          blockingIssues.push(`Dispatch action "${act.title}" references unavailable driver '${drvId}'.`);
          checks.push({
            check_name: `Driver Availability (${drvId})`,
            category: 'fleet',
            passed: false,
            severity: 'blocking',
            detail: drv ? `Driver ${drv.name} status is '${drv.status}'.` : `Driver ${drvId} not found.`,
          });
        }
      }
    }

    if (act.action_type === 'RESERVE_STOCK') {
      const stockId = String(paramsObj.stockId || '');
      const qty = Number(paramsObj.quantity || 0);
      const stock = inventory.find((s) => s.id === stockId);
      if (!stock || stock.availableQty < qty || qty <= 0) {
        blockingIssues.push(
          `Reservation action "${act.title}" exceeds available unreserved stock (requested ${qty}, available ${stock?.availableQty ?? 0}).`
        );
        checks.push({
          check_name: 'Stock Availability & Double-Allocation Prevention',
          category: 'inventory',
          passed: false,
          severity: 'blocking',
          detail: `Available=${stock?.availableQty ?? 0}, Requested=${qty}.`,
        });
      } else {
        checks.push({
          check_name: 'Stock Availability & Double-Allocation Prevention',
          category: 'inventory',
          passed: true,
          severity: 'info',
          detail: `${stock.itemName} has ${stock.availableQty} freely available >= ${qty}.`,
        });
      }
    }
  }

  // 4. Evidence grounding & staleness
  const verifiedCount = allEvidence.filter(
    (e) => e.claim_classification === 'VERIFIED FACT' || e.claim_classification === 'CALCULATED RESULT'
  ).length;
  const unverifiedCount = allEvidence.filter(
    (e) => e.claim_classification === 'ASSUMPTION' || e.claim_classification === 'UNKNOWN'
  ).length;
  const staleEvidence = allEvidence.filter((e) => e.source_status === 'STALE');
  if (staleEvidence.length > 0) {
    staleDetected = true;
    warnings.push(`${staleEvidence.length} evidence record(s) rely on stale telemetry.`);
  }
  checks.push({
    check_name: 'Evidence Grounding Coverage',
    category: 'evidence',
    passed: allEvidence.length > 0 && missingEvidence.length === 0,
    severity: allEvidence.length === 0 ? 'blocking' : missingEvidence.length > 0 ? 'warning' : 'info',
    detail: `${verifiedCount} verified/calculated fact(s), ${unverifiedCount} assumption/unknown claim(s).`,
  });

  // 5. RBAC verification & human approval enforcement
  const rbacOk = runTool('verify_rbac_permissions', () => {
    const allowed = PERMISSIONS['ai:coordinate'] || [];
    return allowed.includes(actor.role);
  });
  checks.push({
    check_name: 'RBAC & Human-Approval Enforcement',
    category: 'rbac',
    passed: rbacOk && plan.requires_human_approval === true,
    severity: rbacOk ? 'info' : 'blocking',
    detail: `Initiator role '${actor.role}' authorized=${rbacOk}; human approval strictly enforced.`,
  });
  if (!rbacOk) {
    blockingIssues.push(`Actor role '${actor.role}' lacks coordination authorization.`);
  }

  let status: SafetyValidationStatus = 'VALID';
  if (blockingIssues.length > 0) {
    status = 'REJECTED';
  } else if (missingEvidence.length > 0 || allEvidence.length === 0) {
    status = 'INCOMPLETE';
  } else if (warnings.length > 0 || staleDetected || plan.unresolved_conflicts.length > 0) {
    status = 'VALID_WITH_WARNINGS';
  }

  const report: AISafetyValidationReport = {
    validation_id: `val-${uuidv4().slice(0, 12)}`,
    session_id: session.session_id,
    plan_id: plan.plan_id,
    status,
    checked_at: new Date().toISOString(),
    checks,
    blocking_issues: blockingIssues,
    warnings,
    missing_evidence: missingEvidence,
    verified_evidence_count: verifiedCount,
    unverified_claim_count: unverifiedCount,
    rbac_verified: rbacOk,
    stale_data_detected: staleDetected,
  };

  if (!task) {
    return { report };
  }

  const verifierEvidence = [
    makeEvidence({
      session,
      task,
      agentId: 'agent-safety-verifier',
      sourceType: 'safety_check',
      sourceId: report.validation_id,
      claim: `Deterministic safety validation result: ${status} (${checks.filter((c) => c.passed).length}/${checks.length} checks passed, ${blockingIssues.length} blocking issue(s), ${warnings.length} warning(s)).`,
      classification: 'CALCULATED RESULT',
      observedAt: report.checked_at,
      sourceStatus: 'LIVE',
    }),
  ];

  const agentResult = AIAgentResultSchema.parse({
    result_id: uuidv4(),
    agent_id: 'agent-safety-verifier',
    agent_version: task.agent_version,
    session_id: session.session_id,
    task_id: task.task_id,
    org_id: session.org_id,
    status: 'COMPLETED',
    summary: `Safety verification completed with status ${status}: ${blockingIssues.length} blocking issue(s), ${warnings.length} warning(s), ${verifiedCount} verified/calculated evidence item(s).`,
    findings: [
      {
        title: `Safety Validation Verdict: ${status}`,
        detail:
          blockingIssues.length > 0
            ? `Blocking issues: ${blockingIssues.join(' | ')}`
            : warnings.length > 0
            ? `Warnings: ${warnings.join(' | ')}`
            : 'All deterministic safety, stock, fleet, RBAC, and evidence checks passed.',
        classification: 'CALCULATED RESULT',
        severity: status === 'REJECTED' ? 'critical' : status === 'VALID_WITH_WARNINGS' || status === 'INCOMPLETE' ? 'high' : 'info',
        evidence_ids: verifierEvidence.map((e) => e.evidence_id),
      },
    ],
    recommendations: [],
    evidence: verifierEvidence,
    missing_information: missingEvidence,
    warnings,
    confidence: status === 'VALID' ? 0.98 : status === 'VALID_WITH_WARNINGS' ? 0.85 : 0.6,
    data_freshness: staleDetected ? 'STALE' : 'FRESH',
    tool_calls_used: task.tool_calls_used,
    tools_invoked: toolsInvoked,
    ai_provider_used: null,
    ai_model_used: null,
    ai_synthesis_status: 'DETERMINISTIC_ONLY',
    tokens_estimated: 0,
    created_at: report.checked_at,
    execution_time_ms: Date.now() - started,
    mode: session.mode,
  }) as AIAgentResult;

  return { report, agentResult };
}

// ============================================================================
// SESSION COORDINATION MEMORY
// ============================================================================

export function addSessionMemoryEntry(params: {
  sessionId: string;
  incidentId: string | null;
  orgId: string;
  memoryType: AISessionMemory['memory_type'];
  title: string;
  content: string;
  structuredData?: Record<string, unknown>;
  sourceRefs?: string[];
  createdBy: string;
  ttlHours?: number;
  mode: DataMode;
}): AISessionMemory {
  // CRITICAL SAFETY RULE: AI conclusions NEVER become VERIFIED FACT merely by being stored in memory
  const classification: ClaimClassification =
    params.memoryType === 'verified_incident_history' || params.memoryType === 'human_decision'
      ? 'VERIFIED FACT'
      : params.memoryType === 'ai_conclusion'
      ? 'AI INTERPRETATION'
      : 'CALCULATED RESULT';

  const sanitizedTitle = sanitizeUntrustedForAgent(params.title, 200).sanitized;
  const sanitizedContent = sanitizeUntrustedForAgent(params.content, 2000).sanitized;

  const existingSameTitle = store.state.aiSessionMemory.filter(
    (m) => m.session_id === params.sessionId && m.title === sanitizedTitle && m.org_id === params.orgId
  );

  const now = new Date().toISOString();
  const entry: AISessionMemory = {
    memory_id: `mem-${uuidv4().slice(0, 12)}`,
    session_id: params.sessionId,
    incident_id: params.incidentId,
    org_id: params.orgId,
    memory_type: params.memoryType,
    classification,
    title: sanitizedTitle,
    content: sanitizedContent,
    structured_data: params.structuredData,
    source_refs: params.sourceRefs || [],
    version: existingSameTitle.length + 1,
    compressed: false,
    expires_at: params.ttlHours ? new Date(Date.now() + params.ttlHours * 3600_000).toISOString() : null,
    created_by: params.createdBy,
    created_at: now,
    updated_at: now,
    mode: params.mode,
  };

  store.state.aiSessionMemory.unshift(entry);
  if (store.state.aiSessionMemory.length > 600) {
    store.state.aiSessionMemory.length = 600;
  }
  store.save();
  return entry;
}

export function getSessionMemoryEntries(sessionId: string, actor: RequestActor): AISessionMemory[] {
  const session = store.state.aiCoordinationSessions.find((s) => s.session_id === sessionId);
  if (session) {
    assertOrgAccess(actor, session.org_id, 'coordination session memory');
  }
  const nowMs = Date.now();
  return store.state.aiSessionMemory.filter(
    (m) =>
      m.session_id === sessionId &&
      canAccessOrg(actor, m.org_id) &&
      (!m.expires_at || new Date(m.expires_at).getTime() > nowMs)
  );
}

// ============================================================================
// CENTRAL AI COORDINATION ORCHESTRATOR
// ============================================================================

function updateAgentRuntimeStats(
  agentId: CoordinationAgentId,
  status: AIAgentDefinition['runtime_status'],
  durationMs?: number,
  failed = false
) {
  const agent = store.state.aiAgents.find((a) => a.agent_id === agentId);
  if (!agent) return;
  const now = new Date().toISOString();
  agent.runtime_status = status;
  agent.updated_at = now;
  if (status !== 'RUNNING') {
    agent.last_run_at = now;
    if (typeof durationMs === 'number') agent.last_duration_ms = durationMs;
    agent.total_runs += 1;
    if (failed) agent.failed_runs += 1;
  }
}

function createTaskRecord(session: AICoordinationSession, agent: AIAgentDefinition, dependsOn: CoordinationAgentId[]): AIAgentTask {
  const task: AIAgentTask = {
    task_id: `task-${uuidv4().slice(0, 10)}`,
    session_id: session.session_id,
    agent_id: agent.agent_id,
    agent_name: agent.name,
    agent_version: agent.version,
    org_id: session.org_id,
    phase: agent.phase,
    depends_on_agents: dependsOn,
    status: 'QUEUED',
    attempt: 0,
    max_attempts: 2,
    tool_calls_used: 0,
    max_tool_calls: agent.max_tool_calls,
    started_at: null,
    completed_at: null,
    execution_time_ms: null,
    result_id: null,
    error_message: null,
    mode: session.mode,
  };
  store.state.aiAgentTasks.unshift(task);
  return task;
}

function persistAgentResult(result: AIAgentResult, session: AICoordinationSession) {
  store.state.aiAgentResults.unshift(result);
  for (const ev of result.evidence) {
    store.state.aiEvidenceRecords.unshift(ev);
  }
  for (const rec of result.recommendations) {
    store.state.aiRecommendations.unshift(rec);
  }
  session.evidence_count += result.evidence.length;
  session.metrics.total_tool_calls += result.tool_calls_used;
  session.metrics.tokens_estimated += result.tokens_estimated;
  if (result.ai_provider_used) {
    session.metrics.provider_used = `${result.ai_provider_used}/${result.ai_model_used}`;
    session.metrics.ai_available = true;
  }
  if (store.state.aiAgentResults.length > 500) store.state.aiAgentResults.length = 500;
  if (store.state.aiEvidenceRecords.length > 2000) store.state.aiEvidenceRecords.length = 2000;
  if (store.state.aiRecommendations.length > 1000) store.state.aiRecommendations.length = 1000;
}

async function executeTaskWithTimeout(
  session: AICoordinationSession,
  task: AIAgentTask,
  timeoutMs: number,
  runner: () => Promise<AIAgentResult> | AIAgentResult
): Promise<AIAgentResult | null> {
  if (session.cancel_requested) {
    task.status = 'CANCELLED';
    task.completed_at = new Date().toISOString();
    updateAgentRuntimeStats(task.agent_id, 'CANCELLED', 0, false);
    return null;
  }

  task.attempt += 1;
  task.status = 'RUNNING';
  task.started_at = new Date().toISOString();
  updateAgentRuntimeStats(task.agent_id, 'RUNNING');

  recordSessionEvent({
    session,
    eventType: 'ai.agent.started',
    agentId: task.agent_id,
    taskId: task.task_id,
    summary: `Started ${task.agent_name} (Phase ${task.phase})`,
  });

  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => runner()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Task timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);

    const dur = Date.now() - t0;
    task.status = 'COMPLETED';
    task.completed_at = new Date().toISOString();
    task.execution_time_ms = dur;
    task.result_id = result.result_id;
    session.metrics.completed_agents += 1;
    updateAgentRuntimeStats(task.agent_id, result.status === 'DEGRADED' ? 'DEGRADED' : 'COMPLETED', dur, false);
    persistAgentResult(result, session);

    recordSessionEvent({
      session,
      eventType: 'ai.agent.completed',
      agentId: task.agent_id,
      taskId: task.task_id,
      summary: `${task.agent_name} completed in ${dur}ms (${result.evidence.length} evidence, ${result.recommendations.length} recommendation(s))`,
      details: { duration_ms: dur, result_id: result.result_id, status: result.status },
    });
    return result;
  } catch (err) {
    const dur = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes('timed out');
    task.status = isTimeout ? 'TIMED_OUT' : 'FAILED';
    task.completed_at = new Date().toISOString();
    task.execution_time_ms = dur;
    task.error_message = msg;
    session.metrics.failed_agents += 1;
    updateAgentRuntimeStats(task.agent_id, isTimeout ? 'TIMED_OUT' : 'FAILED', dur, true);

    recordSessionEvent({
      session,
      eventType: 'ai.agent.failed',
      agentId: task.agent_id,
      taskId: task.task_id,
      summary: `${task.agent_name} ${isTimeout ? 'timed out' : 'failed'}: ${msg}`,
      details: { error: msg, duration_ms: dur },
    });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface StartCoordinationParams {
  incidentId?: string | null;
  objective?: string;
  mode: DataMode;
  actor: RequestActor;
  triggerSource?: AICoordinationSession['trigger_source'];
  waitForCompletion?: boolean;
  skipLiveAI?: boolean;
  timeoutMs?: number;
  simulateAgentFailureId?: CoordinationAgentId;
}

export async function startCoordinationSession(params: StartCoordinationParams): Promise<{
  session: AICoordinationSession;
  plan?: AIResponsePlan | null;
  approval?: AIApprovalRequest | null;
  tasks?: AIAgentTask[];
  results?: AIAgentResult[];
  conflicts?: AIConflictRecord[];
}> {
  const registry = ensureAgentRegistrySeeded();
  const mode = params.mode;
  const actor = params.actor;

  // Validate incident access & org isolation if provided
  let incidentTitle: string | null = null;
  if (params.incidentId) {
    const inc = store.state.incidents.find((i) => i.id === params.incidentId && i.mode === mode);
    if (!inc) {
      const err = new Error(`Incident '${params.incidentId}' not found in mode '${mode}'.`);
      (err as any).statusCode = 404;
      throw err;
    }
    const incOrg = (inc as any).orgId || (inc as any).organizationId;
    if (incOrg && !canAccessOrg(actor, incOrg)) {
      assertOrgAccess(actor, incOrg, `incident ${inc.id}`);
    }
    incidentTitle = sanitizeUntrustedForAgent(inc.title, 140).sanitized;
  }

  const now = new Date().toISOString();
  const session: AICoordinationSession = {
    session_id: `coord-${uuidv4().slice(0, 12)}`,
    org_id: actor.orgId,
    incident_id: params.incidentId || null,
    incident_title: incidentTitle,
    trigger_source: params.triggerSource || 'manual_operator',
    objective:
      sanitizeUntrustedForAgent(
        params.objective?.trim() ||
          (incidentTitle
            ? `Coordinate multi-agent emergency intelligence, supply, logistics, and safety verification for "${incidentTitle}".`
            : 'Coordinate multi-agent operational assessment across active incidents, warehouses, and fleet.')
      ).sanitized,
    status: 'PENDING',
    initiated_by: actor.name,
    initiated_role: actor.role,
    agent_ids: registry.map((a) => a.agent_id),
    plan_id: null,
    approval_id: null,
    safety_status: null,
    conflict_count: 0,
    evidence_count: 0,
    limits: {
      max_agents: 8,
      max_parallel: 4,
      max_tool_calls_per_agent: 12,
      timeout_ms: Math.min(Math.max(params.timeoutMs ?? 12000, 1000), 30000),
      token_budget: 12000,
    },
    metrics: {
      started_at: now,
      completed_at: null,
      total_execution_ms: null,
      completed_agents: 0,
      failed_agents: 0,
      total_tool_calls: 0,
      tokens_estimated: 0,
      provider_used: null,
      ai_available: false,
    },
    cancel_requested: false,
    error_message: null,
    mode,
    created_at: now,
    updated_at: now,
  };

  store.state.aiCoordinationSessions.unshift(session);
  if (store.state.aiCoordinationSessions.length > 200) {
    store.state.aiCoordinationSessions.length = 200;
  }
  store.addAudit({
    actor: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    action: 'ai.coordination.started',
    entityType: 'coordination_session',
    entityId: session.session_id,
    summary: `Initiated multi-agent coordination session ${session.session_id}${incidentTitle ? ` for ${incidentTitle}` : ''}.`,
    mode,
  });

  const runPipeline = async () => {
    const startMs = Date.now();
    session.status = 'RUNNING';
    session.updated_at = new Date().toISOString();
    recordSessionEvent({
      session,
      eventType: 'ai.coordination.started',
      agentId: 'orchestrator',
      summary: `Coordination session ${session.session_id} started (${registry.length} agents registered).`,
      details: { incident_id: session.incident_id, objective: session.objective },
    });

    const getDef = (id: CoordinationAgentId) => registry.find((a) => a.agent_id === id)!;

    // Create task DAG
    const tEmerg = createTaskRecord(session, getDef('agent-emergency-intel'), []);
    const tEnv = createTaskRecord(session, getDef('agent-environmental-intel'), []);
    const tRes = createTaskRecord(session, getDef('agent-resource-intel'), []);
    const tHum = createTaskRecord(session, getDef('agent-human-impact'), []);
    const tLog = createTaskRecord(session, getDef('agent-logistics-intel'), [
      'agent-emergency-intel',
      'agent-resource-intel',
    ]);
    const tPlan = createTaskRecord(session, getDef('agent-response-planner'), [
      'agent-emergency-intel',
      'agent-environmental-intel',
      'agent-resource-intel',
      'agent-human-impact',
      'agent-logistics-intel',
    ]);
    const tMon = createTaskRecord(session, getDef('agent-response-monitor'), []);
    const tSafe = createTaskRecord(session, getDef('agent-safety-verifier'), ['agent-response-planner']);

    const maybeFail = (id: CoordinationAgentId) => {
      if (params.simulateAgentFailureId === id) {
        throw new Error(`Simulated agent failure for fault-tolerance test on ${id}`);
      }
    };

    // PHASE A (PARALLEL): Agents 1, 2, 3, 5
    const phaseAResults = await Promise.all([
      executeTaskWithTimeout(session, tEmerg, session.limits.timeout_ms, () => {
        maybeFail('agent-emergency-intel');
        return runEmergencyIntelligenceAgent(session, tEmerg, actor);
      }),
      executeTaskWithTimeout(session, tEnv, session.limits.timeout_ms, () => {
        maybeFail('agent-environmental-intel');
        return runEnvironmentalWeatherAgent(session, tEnv, actor);
      }),
      executeTaskWithTimeout(session, tRes, session.limits.timeout_ms, () => {
        maybeFail('agent-resource-intel');
        return runResourceIntelligenceAgent(session, tRes, actor);
      }),
      executeTaskWithTimeout(session, tHum, session.limits.timeout_ms, () => {
        maybeFail('agent-human-impact');
        return runHumanImpactAgent(session, tHum, actor);
      }),
    ]);

    // PHASE B (SEQUENTIAL): Agent 4 (Logistics) + Agent 7 (Monitor)
    const [logResult, monResult] = await Promise.all([
      executeTaskWithTimeout(session, tLog, session.limits.timeout_ms, () => {
        maybeFail('agent-logistics-intel');
        return runLogisticsRouteAgent(session, tLog, actor);
      }),
      executeTaskWithTimeout(session, tMon, session.limits.timeout_ms, () => {
        maybeFail('agent-response-monitor');
        return runResponseMonitoringAgent(session, tMon, actor);
      }),
    ]);

    const specialistResults = [...phaseAResults, logResult, monResult].filter(
      (r): r is AIAgentResult => Boolean(r)
    );

    if (session.cancel_requested) {
      session.status = 'CANCELLED';
      session.metrics.completed_at = new Date().toISOString();
      session.metrics.total_execution_ms = Date.now() - startMs;
      session.updated_at = session.metrics.completed_at;
      store.save();
      return { session, plan: null, approval: null, tasks: [], results: specialistResults, conflicts: [] };
    }

    // PHASE C (SYNTHESIS): Agent 6 (Response Planning)
    let plan: AIResponsePlan | null = null;
    let planActions: AIPlanAction[] = [];
    let conflicts: AIConflictRecord[] = [];

    const planResult = await executeTaskWithTimeout(session, tPlan, session.limits.timeout_ms, async () => {
      maybeFail('agent-response-planner');
      const out = await runResponsePlanningAgent({
        session,
        task: tPlan,
        actor,
        specialistResults,
        skipLiveAI: params.skipLiveAI,
      });
      plan = out.plan;
      planActions = out.planActions;
      conflicts = out.conflicts;
      return out.result;
    });

    const allResults = [...specialistResults, ...(planResult ? [planResult] : [])];
    const allEvidence = allResults.flatMap((r) => r.evidence);

    // PHASE E (DETERMINISTIC SAFETY VERIFICATION): Agent 8
    let approval: AIApprovalRequest | null = null;
    if (plan) {
      const targetPlan: AIResponsePlan = plan;
      recordSessionEvent({
        session,
        eventType: 'ai.plan.generated',
        agentId: 'agent-response-planner',
        summary: `Unified response plan ${targetPlan.plan_id} generated with ${planActions.length} proposed action(s).`,
        details: { plan_id: targetPlan.plan_id, action_count: planActions.length },
      });

      const verifierRes = await executeTaskWithTimeout(session, tSafe, session.limits.timeout_ms, () => {
        const { report, agentResult } = runDeterministicSafetyValidation({
          session,
          plan: targetPlan,
          planActions,
          allEvidence,
          actor,
          task: tSafe,
        });
        targetPlan.safety_validation = report;
        session.safety_status = report.status;
        return agentResult!;
      });

      if (verifierRes) {
        allResults.push(verifierRes);
      }

      recordSessionEvent({
        session,
        eventType: 'ai.validation.completed',
        agentId: 'agent-safety-verifier',
        summary: `Safety verification verdict: ${targetPlan.safety_validation.status} (${targetPlan.safety_validation.blocking_issues.length} blocking, ${targetPlan.safety_validation.warnings.length} warnings).`,
        details: {
          plan_id: targetPlan.plan_id,
          safety_status: targetPlan.safety_validation.status,
          blocking_issues: targetPlan.safety_validation.blocking_issues,
        },
      });

      // Persist plan and actions
      store.state.aiResponsePlans.unshift(targetPlan);
      for (const act of planActions) {
        store.state.aiPlanActions.unshift(act);
      }
      if (store.state.aiResponsePlans.length > 250) store.state.aiResponsePlans.length = 250;
      if (store.state.aiPlanActions.length > 1000) store.state.aiPlanActions.length = 1000;

      // Create Approval Request
      const impactLevel: AIApprovalRequest['impact_level'] =
        planActions.some((a) => a.priority === 'critical') || targetPlan.safety_validation.status === 'REJECTED'
          ? 'CRITICAL'
          : planActions.some((a) => a.priority === 'high')
          ? 'HIGH'
          : 'MEDIUM';

      approval = {
        approval_id: `appr-${uuidv4().slice(0, 12)}`,
        plan_id: targetPlan.plan_id,
        session_id: session.session_id,
        incident_id: session.incident_id,
        org_id: session.org_id,
        title: targetPlan.title,
        impact_level: impactLevel,
        requested_by: actor.name,
        status: 'PENDING',
        action_ids: planActions.map((a) => a.action_id),
        safety_status: targetPlan.safety_validation.status,
        expires_at: targetPlan.expires_at,
        decided_by: null,
        decided_at: null,
        decision_note: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        mode,
      };
      store.state.aiApprovalRequests.unshift(approval);
      store.state.aiApprovalEvents.unshift({
        event_id: uuidv4(),
        approval_id: approval.approval_id,
        plan_id: targetPlan.plan_id,
        org_id: session.org_id,
        decision: 'CREATED',
        actor_id: actor.uid,
        actor_name: actor.name,
        actor_role: actor.role,
        note: `Approval request created with safety verdict ${targetPlan.safety_validation.status}.`,
        created_at: new Date().toISOString(),
        mode,
      });

      session.plan_id = targetPlan.plan_id;
      session.approval_id = approval.approval_id;
      session.conflict_count = conflicts.length;

      recordSessionEvent({
        session,
        eventType: 'ai.approval.requested',
        agentId: 'orchestrator',
        summary: `Human commander approval requested for plan ${targetPlan.plan_id} (${impactLevel} impact).`,
        details: { approval_id: approval.approval_id, plan_id: targetPlan.plan_id, impact_level: impactLevel },
      });

      // Record Scoped Session Memory (strictly separating verified facts vs AI conclusion)
      addSessionMemoryEntry({
        sessionId: session.session_id,
        incidentId: session.incident_id,
        orgId: session.org_id,
        memoryType: 'session_context',
        title: `Coordination Session Context (${session.session_id})`,
        content: `Objective: ${session.objective}. Completed ${session.metrics.completed_agents} agent(s), failed ${session.metrics.failed_agents}.`,
        sourceRefs: session.incident_id ? [`incident:${session.incident_id}`] : [],
        createdBy: actor.name,
        ttlHours: 72,
        mode,
      });

      addSessionMemoryEntry({
        sessionId: session.session_id,
        incidentId: session.incident_id,
        orgId: session.org_id,
        memoryType: 'ai_conclusion',
        title: `Plan Synthesis Conclusion (${targetPlan.plan_id})`,
        content: targetPlan.ai_synthesis_note || targetPlan.incident_summary,
        sourceRefs: targetPlan.evidence_ids.slice(0, 10),
        createdBy: 'agent-response-planner',
        ttlHours: 48,
        mode,
      });
    }

    session.status =
      session.metrics.failed_agents > 0 && session.metrics.completed_agents > 0
        ? 'PARTIAL'
        : session.metrics.failed_agents > 0
        ? 'FAILED'
        : 'COMPLETED';
    session.metrics.completed_at = new Date().toISOString();
    session.metrics.total_execution_ms = Date.now() - startMs;
    session.updated_at = session.metrics.completed_at;
    store.save();

    recordSessionEvent({
      session,
      eventType: session.status === 'FAILED' ? 'ai.coordination.failed' : 'ai.coordination.completed',
      agentId: 'orchestrator',
      summary: `Coordination session ${session.session_id} finished with status ${session.status} in ${session.metrics.total_execution_ms}ms.`,
      details: {
        status: session.status,
        plan_id: session.plan_id,
        safety_status: session.safety_status,
        conflict_count: session.conflict_count,
        evidence_count: session.evidence_count,
      },
    });

    return {
      session,
      plan,
      approval,
      tasks: store.state.aiAgentTasks.filter((t) => t.session_id === session.session_id),
      results: allResults,
      conflicts,
    };
  };

  if (params.waitForCompletion !== false) {
    return await runPipeline();
  }

  // Non-blocking background execution mode
  setImmediate(() => {
    runPipeline().catch((err) => {
      session.status = 'FAILED';
      session.error_message = err instanceof Error ? err.message : String(err);
      session.updated_at = new Date().toISOString();
      store.save();
    });
  });

  return { session };
}

export function cancelCoordinationSession(sessionId: string, actor: RequestActor): AICoordinationSession {
  const session = store.state.aiCoordinationSessions.find((s) => s.session_id === sessionId);
  if (!session) {
    const err = new Error(`Coordination session '${sessionId}' not found.`);
    (err as any).statusCode = 404;
    throw err;
  }
  assertOrgAccess(actor, session.org_id, 'coordination session');
  session.cancel_requested = true;
  if (session.status === 'PENDING' || session.status === 'RUNNING') {
    session.status = 'CANCELLED';
    session.metrics.completed_at = new Date().toISOString();
  }
  session.updated_at = new Date().toISOString();
  recordSessionEvent({
    session,
    eventType: 'ai.coordination.cancelled',
    agentId: 'human',
    summary: `Session cancelled by ${actor.name} (${actor.role}).`,
  });
  store.save();
  return session;
}

export async function rerunSingleAgentTask(params: {
  sessionId: string;
  agentId: CoordinationAgentId;
  actor: RequestActor;
}): Promise<{ task: AIAgentTask; result: AIAgentResult | null }> {
  const session = store.state.aiCoordinationSessions.find((s) => s.session_id === params.sessionId);
  if (!session) {
    const err = new Error(`Coordination session '${params.sessionId}' not found.`);
    (err as any).statusCode = 404;
    throw err;
  }
  assertOrgAccess(params.actor, session.org_id, 'coordination session');

  const registry = ensureAgentRegistrySeeded();
  const def = registry.find((a) => a.agent_id === params.agentId);
  if (!def) {
    const err = new Error(`Unknown agent '${params.agentId}'.`);
    (err as any).statusCode = 404;
    throw err;
  }

  const task = createTaskRecord(session, def, []);
  const result = await executeTaskWithTimeout(session, task, session.limits.timeout_ms, async () => {
    switch (params.agentId) {
      case 'agent-emergency-intel':
        return runEmergencyIntelligenceAgent(session, task, params.actor);
      case 'agent-environmental-intel':
        return runEnvironmentalWeatherAgent(session, task, params.actor);
      case 'agent-resource-intel':
        return runResourceIntelligenceAgent(session, task, params.actor);
      case 'agent-human-impact':
        return runHumanImpactAgent(session, task, params.actor);
      case 'agent-logistics-intel':
        return runLogisticsRouteAgent(session, task, params.actor);
      case 'agent-response-monitor':
        return runResponseMonitoringAgent(session, task, params.actor);
      case 'agent-response-planner': {
        const prevResults = store.state.aiAgentResults.filter(
          (r) => r.session_id === session.session_id && r.agent_id !== 'agent-response-planner'
        );
        const out = await runResponsePlanningAgent({
          session,
          task,
          actor: params.actor,
          specialistResults: prevResults,
        });
        store.state.aiResponsePlans.unshift(out.plan);
        out.planActions.forEach((a) => store.state.aiPlanActions.unshift(a));
        session.plan_id = out.plan.plan_id;
        return out.result;
      }
      case 'agent-safety-verifier': {
        const plan = store.state.aiResponsePlans.find((p) => p.plan_id === session.plan_id);
        if (!plan) throw new Error('No response plan exists in this session to verify.');
        const acts = store.state.aiPlanActions.filter((a) => a.plan_id === plan.plan_id);
        const evs = store.state.aiEvidenceRecords.filter((e) => e.session_id === session.session_id);
        const out = runDeterministicSafetyValidation({
          session,
          plan,
          planActions: acts,
          allEvidence: evs,
          actor: params.actor,
          task,
        });
        plan.safety_validation = out.report;
        session.safety_status = out.report.status;
        return out.agentResult!;
      }
    }
  });

  store.save();
  return { task, result };
}

// ============================================================================
// CONFLICT RESOLUTION BY HUMAN
// ============================================================================

export function resolveConflictByHuman(params: {
  conflictId: string;
  resolutionNote: string;
  resolutionStrategy?: string;
  actor: RequestActor;
}): AIConflictRecord {
  const conflict = store.state.aiConflicts.find((c) => c.conflict_id === params.conflictId);
  if (!conflict) {
    const err = new Error(`Conflict '${params.conflictId}' not found.`);
    (err as any).statusCode = 404;
    throw err;
  }
  assertOrgAccess(params.actor, conflict.org_id, 'conflict');

  const now = new Date().toISOString();
  conflict.resolution_status = 'RESOLVED_HUMAN';
  conflict.resolved_by = params.actor.name;
  conflict.resolved_at = now;
  conflict.resolution_note = sanitizeUntrustedForAgent(params.resolutionNote, 800).sanitized;
  if (params.resolutionStrategy) {
    conflict.resolution_strategy = sanitizeUntrustedForAgent(params.resolutionStrategy, 500).sanitized;
  }

  // Update linked plan's unresolved_conflicts list
  if (conflict.plan_id) {
    const plan = store.state.aiResponsePlans.find((p) => p.plan_id === conflict.plan_id);
    if (plan) {
      plan.unresolved_conflicts = store.state.aiConflicts
        .filter(
          (c) =>
            c.plan_id === plan.plan_id &&
            (c.resolution_status === 'OPEN' || c.resolution_status === 'ESCALATED_HUMAN')
        )
        .map((c) => `${c.conflict_type}: ${c.title}`);
      plan.updated_at = now;
    }
  }

  const session = store.state.aiCoordinationSessions.find((s) => s.session_id === conflict.session_id);
  if (session) {
    recordSessionEvent({
      session,
      eventType: 'ai.conflict.resolved',
      agentId: 'human',
      summary: `Conflict ${conflict.conflict_id} resolved by ${params.actor.name}: ${conflict.resolution_note}`,
      details: { conflict_id: conflict.conflict_id },
    });
    addSessionMemoryEntry({
      sessionId: session.session_id,
      incidentId: conflict.incident_id,
      orgId: conflict.org_id,
      memoryType: 'human_decision',
      title: `Conflict Resolution (${conflict.conflict_type})`,
      content: `Resolved by ${params.actor.name} (${params.actor.role}): ${conflict.resolution_note}`,
      sourceRefs: [`conflict:${conflict.conflict_id}`],
      createdBy: params.actor.name,
      mode: conflict.mode,
    });
  }

  store.addAudit({
    actor: params.actor.name,
    role: params.actor.role,
    orgId: conflict.org_id,
    action: 'ai.conflict.resolved',
    entityType: 'ai_conflict',
    entityId: conflict.conflict_id,
    summary: `Resolved AI conflict ${conflict.conflict_id}: ${conflict.resolution_note}`,
    mode: conflict.mode,
  });

  store.save();
  return conflict;
}

// ============================================================================
// HUMAN APPROVAL & CONTROLLED EXECUTION WORKFLOW
// ============================================================================

export function validatePlanNow(planId: string, actor: RequestActor): {
  plan: AIResponsePlan;
  validation: AISafetyValidationReport;
} {
  const plan = store.state.aiResponsePlans.find((p) => p.plan_id === planId);
  if (!plan) {
    const err = new Error(`Response plan '${planId}' not found.`);
    (err as any).statusCode = 404;
    throw err;
  }
  assertOrgAccess(actor, plan.org_id, 'response plan');

  const session = store.state.aiCoordinationSessions.find((s) => s.session_id === plan.session_id);
  if (!session) {
    const err = new Error(`Session '${plan.session_id}' not found.`);
    (err as any).statusCode = 404;
    throw err;
  }

  const acts = store.state.aiPlanActions.filter((a) => a.plan_id === plan.plan_id);
  const evs = store.state.aiEvidenceRecords.filter((e) => e.session_id === session.session_id);
  const { report } = runDeterministicSafetyValidation({
    session,
    plan,
    planActions: acts,
    allEvidence: evs,
    actor,
  });

  plan.safety_validation = report;
  plan.updated_at = new Date().toISOString();
  const appr = store.state.aiApprovalRequests.find((a) => a.plan_id === plan.plan_id);
  if (appr) {
    appr.safety_status = report.status;
    appr.updated_at = plan.updated_at;
  }
  store.save();
  return { plan, validation: report };
}

export function modifyPlanActions(params: {
  planId: string;
  actor: RequestActor;
  modificationNotes: string;
  actionUpdates: {
    action_id: string;
    status?: 'APPROVED' | 'MODIFIED' | 'REJECTED' | 'DEFERRED';
    modified_parameters?: Record<string, unknown>;
  }[];
}): { plan: AIResponsePlan; actions: AIPlanAction[] } {
  const plan = store.state.aiResponsePlans.find((p) => p.plan_id === params.planId);
  if (!plan) {
    const err = new Error(`Response plan '${params.planId}' not found.`);
    (err as any).statusCode = 404;
    throw err;
  }
  assertOrgAccess(params.actor, plan.org_id, 'response plan');

  const now = new Date().toISOString();
  const actions = store.state.aiPlanActions.filter((a) => a.plan_id === plan.plan_id);
  for (const upd of params.actionUpdates) {
    const target = actions.find((a) => a.action_id === upd.action_id);
    if (!target) continue;
    if (upd.modified_parameters) {
      target.modified_parameters = upd.modified_parameters;
      target.status = upd.status || 'MODIFIED';
    } else if (upd.status) {
      target.status = upd.status;
    }
  }

  plan.version += 1;
  plan.status = 'MODIFIED';
  plan.modification_notes = sanitizeUntrustedForAgent(params.modificationNotes, 800).sanitized;
  plan.updated_at = now;

  // Re-run safety validation after modification
  validatePlanNow(plan.plan_id, params.actor);

  const appr = store.state.aiApprovalRequests.find((a) => a.plan_id === plan.plan_id);
  if (appr) {
    appr.status = 'MODIFIED';
    appr.decided_by = params.actor.name;
    appr.decided_at = now;
    appr.decision_note = plan.modification_notes;
    appr.updated_at = now;
    store.state.aiApprovalEvents.unshift({
      event_id: uuidv4(),
      approval_id: appr.approval_id,
      plan_id: plan.plan_id,
      org_id: plan.org_id,
      decision: 'MODIFIED',
      actor_id: params.actor.uid,
      actor_name: params.actor.name,
      actor_role: params.actor.role,
      note: plan.modification_notes || 'Plan parameters modified by operator.',
      created_at: now,
      mode: plan.mode,
    });
  }

  addSessionMemoryEntry({
    sessionId: plan.session_id,
    incidentId: plan.incident_id,
    orgId: plan.org_id,
    memoryType: 'human_decision',
    title: `Plan Modified (${plan.plan_id} v${plan.version})`,
    content: `Modified by ${params.actor.name}: ${plan.modification_notes}`,
    sourceRefs: [`plan:${plan.plan_id}`],
    createdBy: params.actor.name,
    mode: plan.mode,
  });

  store.save();
  return { plan, actions };
}

export function decidePlanApproval(params: {
  planId: string;
  decision: 'APPROVE' | 'REJECT' | 'DEFER';
  note?: string;
  actionIds?: string[];
  actor: RequestActor;
}): { plan: AIResponsePlan; approval: AIApprovalRequest | null; actions: AIPlanAction[] } {
  const plan = store.state.aiResponsePlans.find((p) => p.plan_id === params.planId);
  if (!plan) {
    const err = new Error(`Response plan '${params.planId}' not found.`);
    (err as any).statusCode = 404;
    throw err;
  }
  assertOrgAccess(params.actor, plan.org_id, 'response plan');

  const now = new Date().toISOString();
  if (new Date(plan.expires_at).getTime() < Date.now() && params.decision === 'APPROVE') {
    plan.status = 'EXPIRED';
    store.save();
    const err = new Error('Response plan has expired. Trigger re-analysis before approving.');
    (err as any).statusCode = 409;
    throw err;
  }

  // Revalidate deterministically before approving
  const { validation } = validatePlanNow(plan.plan_id, params.actor);
  if (params.decision === 'APPROVE' && validation.status === 'REJECTED') {
    const err = new Error(
      `Approval blocked by Safety Verification Agent (REJECTED): ${validation.blocking_issues.join('; ')}`
    );
    (err as any).statusCode = 409;
    throw err;
  }

  const actions = store.state.aiPlanActions.filter((a) => a.plan_id === plan.plan_id);
  const note = sanitizeUntrustedForAgent(params.note || '', 600).sanitized;

  if (params.decision === 'APPROVE') {
    const selectedSet = params.actionIds && params.actionIds.length > 0 ? new Set(params.actionIds) : null;
    for (const act of actions) {
      if (!selectedSet || selectedSet.has(act.action_id)) {
        if (act.status !== 'REJECTED') act.status = 'APPROVED';
      }
    }
    plan.status = selectedSet && selectedSet.size < actions.length ? 'PARTIALLY_APPROVED' : 'APPROVED';
    plan.approved_by = params.actor.name;
    plan.approved_at = now;
  } else if (params.decision === 'REJECT') {
    for (const act of actions) act.status = 'REJECTED';
    plan.status = 'REJECTED';
    plan.rejection_reason = note || 'Rejected by commander';
  } else {
    for (const act of actions) {
      if (act.status === 'PROPOSED') act.status = 'DEFERRED';
    }
    plan.status = 'DEFERRED';
  }
  plan.updated_at = now;

  const appr = store.state.aiApprovalRequests.find((a) => a.plan_id === plan.plan_id) || null;
  if (appr) {
    appr.status =
      params.decision === 'APPROVE' ? 'APPROVED' : params.decision === 'REJECT' ? 'REJECTED' : 'DEFERRED';
    appr.decided_by = params.actor.name;
    appr.decided_at = now;
    appr.decision_note = note || appr.status;
    appr.updated_at = now;
    store.state.aiApprovalEvents.unshift({
      event_id: uuidv4(),
      approval_id: appr.approval_id,
      plan_id: plan.plan_id,
      org_id: plan.org_id,
      decision: params.decision === 'APPROVE' ? 'APPROVED' : params.decision === 'REJECT' ? 'REJECTED' : 'DEFERRED',
      actor_id: params.actor.uid,
      actor_name: params.actor.name,
      actor_role: params.actor.role,
      note: note || `Plan ${params.decision.toLowerCase()}d by ${params.actor.name}`,
      revalidation_passed: validation.status !== 'REJECTED',
      created_at: now,
      mode: plan.mode,
    });
  }

  const session = store.state.aiCoordinationSessions.find((s) => s.session_id === plan.session_id);
  if (session) {
    recordSessionEvent({
      session,
      eventType:
        params.decision === 'APPROVE'
          ? 'ai.approval.approved'
          : params.decision === 'REJECT'
          ? 'ai.approval.rejected'
          : 'ai.approval.deferred',
      agentId: 'human',
      summary: `Plan ${plan.plan_id} ${params.decision.toLowerCase()}d by ${params.actor.name} (${params.actor.role}).`,
      details: { plan_id: plan.plan_id, approval_id: appr?.approval_id || null, note },
    });
  }

  addSessionMemoryEntry({
    sessionId: plan.session_id,
    incidentId: plan.incident_id,
    orgId: plan.org_id,
    memoryType: 'human_decision',
    title: `Commander Decision: ${params.decision} (${plan.plan_id})`,
    content: `${params.actor.name} (${params.actor.role}) decided ${params.decision}. ${note}`,
    sourceRefs: [`plan:${plan.plan_id}`],
    createdBy: params.actor.name,
    mode: plan.mode,
  });

  store.addAudit({
    actor: params.actor.name,
    role: params.actor.role,
    orgId: plan.org_id,
    action: `ai.plan.${params.decision.toLowerCase()}`,
    entityType: 'ai_response_plan',
    entityId: plan.plan_id,
    summary: `${params.decision} AI response plan ${plan.plan_id}. ${note}`,
    mode: plan.mode,
  });

  store.save();
  return { plan, approval: appr, actions };
}

export async function executeApprovedPlan(params: {
  planId: string;
  actor: RequestActor;
}): Promise<{
  plan: AIResponsePlan;
  executedActions: AIPlanAction[];
  blockedActions: AIPlanAction[];
  revalidation: AISafetyValidationReport;
}> {
  const plan = store.state.aiResponsePlans.find((p) => p.plan_id === params.planId);
  if (!plan) {
    const err = new Error(`Response plan '${params.planId}' not found.`);
    (err as any).statusCode = 404;
    throw err;
  }
  assertOrgAccess(params.actor, plan.org_id, 'response plan');

  if (plan.status !== 'APPROVED' && plan.status !== 'PARTIALLY_APPROVED') {
    const err = new Error(
      `Execution blocked: Plan '${plan.plan_id}' status is '${plan.status}'. Explicit human commander approval is mandatory before execution.`
    );
    (err as any).statusCode = 409;
    throw err;
  }

  const now = new Date().toISOString();
  if (new Date(plan.expires_at).getTime() < Date.now()) {
    plan.status = 'INVALIDATED';
    plan.updated_at = now;
    store.save();
    const err = new Error('Execution blocked: Approved plan expired prior to execution and has been invalidated.');
    (err as any).statusCode = 409;
    throw err;
  }

  // Deterministic revalidation right before execution
  const { validation } = validatePlanNow(plan.plan_id, params.actor);
  const appr = store.state.aiApprovalRequests.find((a) => a.plan_id === plan.plan_id);
  const session = store.state.aiCoordinationSessions.find((s) => s.session_id === plan.session_id);

  if (validation.status === 'REJECTED') {
    plan.status = 'INVALIDATED';
    plan.updated_at = now;
    if (appr) {
      appr.status = 'INVALIDATED';
      appr.updated_at = now;
      store.state.aiApprovalEvents.unshift({
        event_id: uuidv4(),
        approval_id: appr.approval_id,
        plan_id: plan.plan_id,
        org_id: plan.org_id,
        decision: 'INVALIDATED',
        actor_id: params.actor.uid,
        actor_name: params.actor.name,
        actor_role: params.actor.role,
        note: `Conditions changed prior to execution: ${validation.blocking_issues.join('; ')}`,
        revalidation_passed: false,
        created_at: now,
        mode: plan.mode,
      });
    }
    store.save();
    const err = new Error(
      `Execution invalidated — live operational conditions changed since approval: ${validation.blocking_issues.join('; ')}`
    );
    (err as any).statusCode = 409;
    throw err;
  }

  const actions = store.state.aiPlanActions.filter((a) => a.plan_id === plan.plan_id);
  const approvedActions = actions.filter((a) => a.status === 'APPROVED' || a.status === 'MODIFIED');
  const executedActions: AIPlanAction[] = [];
  const blockedActions: AIPlanAction[] = [];

  for (const act of approvedActions) {
    const p = act.modified_parameters || act.proposed_parameters;
    try {
      let execResult: Record<string, unknown> = { advisoryRecorded: true };

      if (act.action_type === 'CREATE_ALLOCATION' && p.requestId) {
        const alloc = await optimizeMultiWarehouseAllocation({
          requestId: String(p.requestId),
          actor: {
            name: params.actor.name,
            role: params.actor.role,
            orgId: params.actor.orgId,
          },
        });
        execResult = { allocationId: alloc.id, status: alloc.status, fulfillmentPct: alloc.fulfillmentPct };
      } else if (act.action_type === 'CREATE_PENDING_DISPATCH' && p.requestId && p.warehouseId && p.vehicleId) {
        let allocationId = p.allocationId ? String(p.allocationId) : '';
        if (!allocationId) {
          const existing = store.state.allocations.find(
            (a) => a.requestId === String(p.requestId) && a.mode === plan.mode && a.status !== 'rejected'
          );
          if (existing) {
            allocationId = existing.id;
          } else {
            const alloc = await optimizeMultiWarehouseAllocation({
              requestId: String(p.requestId),
              actor: {
                name: params.actor.name,
                role: params.actor.role,
                orgId: params.actor.orgId,
              },
            });
            allocationId = alloc.id;
          }
        }
        const dispatch = await createPendingDispatch({
          allocationId,
          warehouseId: String(p.warehouseId),
          vehicleId: String(p.vehicleId),
          driverId: p.driverId ? String(p.driverId) : undefined,
          actor: {
            name: params.actor.name,
            role: params.actor.role,
            orgId: params.actor.orgId,
          },
        });
        execResult = {
          dispatchId: dispatch.id,
          status: dispatch.status,
          approvalStatus: dispatch.approvalStatus,
          note: 'Created as PENDING_APPROVAL dispatch via Phase 5 backend service.',
        };
      } else if (act.action_type === 'RESERVE_STOCK' && p.stockId && p.quantity && p.requestId) {
        const resvOut = await createStockReservation({
          stockId: String(p.stockId),
          requestedQty: Number(p.quantity),
          requestId: String(p.requestId),
          incidentId: plan.incident_id || undefined,
          actor: {
            name: params.actor.name,
            role: params.actor.role,
            orgId: params.actor.orgId,
            userId: params.actor.uid,
          },
        });
        execResult = {
          reservationId: resvOut.reservation.id,
          status: resvOut.reservation.status,
          reservedQty: resvOut.reservation.reservedQty,
        };
      } else if (act.action_type === 'REASSESS_RISK' && p.incidentId) {
        const inc = store.state.incidents.find((i) => i.id === String(p.incidentId) && i.mode === plan.mode);
        if (inc) {
          const weather =
            store.state.weatherObservations.find((w) => haversineKm(w.lat, w.lng, inc.lat, inc.lng) <= 35) || null;
          const risk = computeDeterministicRisk(inc, weather);
          store.state.riskAssessments.unshift(risk);
          inc.riskScore = risk.overallScore;
          inc.updatedAt = now;
          execResult = { assessmentId: risk.id, overallScore: risk.overallScore, band: risk.band };
        }
      } else {
        // Advisory / Field Verification / Replenishment notification recorded cleanly
        store.addNotification({
          dedupKey: `ai-plan-act:${act.action_id}`,
          userId: 'all',
          orgId: plan.org_id,
          eventType: 'ai.plan.action_dispatched',
          severity: act.priority === 'critical' ? 'critical' : 'high',
          title: `Approved AI Action: ${act.title}`,
          message: act.description,
          entityType: 'ai_plan_action',
          entityId: act.action_id,
          channel: 'in_app',
          mode: plan.mode,
        });
        execResult = { actionLogged: true, actionType: act.action_type };
      }

      act.status = 'EXECUTED';
      act.executed_at = new Date().toISOString();
      act.executed_by = params.actor.name;
      act.execution_result = execResult;
      act.execution_error = null;
      executedActions.push(act);
    } catch (err) {
      act.status = 'EXECUTION_BLOCKED';
      act.execution_error = err instanceof Error ? err.message : String(err);
      blockedActions.push(act);
    }
  }

  plan.status = executedActions.length > 0 ? 'EXECUTED' : 'INVALIDATED';
  plan.updated_at = new Date().toISOString();

  if (appr) {
    appr.status = executedActions.length > 0 ? 'EXECUTED' : 'INVALIDATED';
    appr.updated_at = plan.updated_at;
    store.state.aiApprovalEvents.unshift({
      event_id: uuidv4(),
      approval_id: appr.approval_id,
      plan_id: plan.plan_id,
      org_id: plan.org_id,
      decision: executedActions.length > 0 ? 'EXECUTED' : 'EXECUTION_BLOCKED',
      actor_id: params.actor.uid,
      actor_name: params.actor.name,
      actor_role: params.actor.role,
      note: `Executed ${executedActions.length} action(s), blocked ${blockedActions.length} action(s).`,
      revalidation_passed: true,
      created_at: plan.updated_at,
      mode: plan.mode,
    });
  }

  if (session) {
    recordSessionEvent({
      session,
      eventType: 'ai.plan.executed',
      agentId: 'human',
      summary: `Executed approved plan ${plan.plan_id} (${executedActions.length} succeeded, ${blockedActions.length} blocked).`,
      details: {
        plan_id: plan.plan_id,
        executed_count: executedActions.length,
        blocked_count: blockedActions.length,
      },
    });
  }

  store.addAudit({
    actor: params.actor.name,
    role: params.actor.role,
    orgId: plan.org_id,
    action: 'ai.plan.executed',
    entityType: 'ai_response_plan',
    entityId: plan.plan_id,
    summary: `Controlled execution of approved plan ${plan.plan_id}: ${executedActions.length} action(s) executed via backend services.`,
    mode: plan.mode,
  });

  store.save();
  return { plan, executedActions, blockedActions, revalidation: validation };
}

// ============================================================================
// ISOLATED SCENARIO SIMULATION ENGINE (ZERO LIVE MUTATION)
// ============================================================================

export function createSimulationSession(params: {
  title: string;
  scenarioType: AISimulationType;
  incidentId?: string | null;
  parameters?: Record<string, unknown>;
  mode: DataMode;
  actor: RequestActor;
}): AISimulationSession {
  const now = new Date().toISOString();
  const sim: AISimulationSession = {
    simulation_id: `sim-${uuidv4().slice(0, 12)}`,
    org_id: params.actor.orgId,
    incident_id: params.incidentId || null,
    title: sanitizeUntrustedForAgent(params.title, 180).sanitized,
    scenario_type: params.scenarioType,
    label: 'SIMULATION — NOT A LIVE EMERGENCY',
    parameters: params.parameters || {},
    status: 'CREATED',
    created_by: params.actor.name,
    created_at: now,
    completed_at: null,
    result_id: null,
    mutated_live_data: false,
    mode: params.mode,
  };
  store.state.aiSimulationSessions.unshift(sim);
  if (store.state.aiSimulationSessions.length > 200) {
    store.state.aiSimulationSessions.length = 200;
  }
  store.save();
  return sim;
}

export function runIsolatedSimulation(simulationId: string, actor: RequestActor): {
  simulation: AISimulationSession;
  result: AISimulationResult;
} {
  const sim = store.state.aiSimulationSessions.find((s) => s.simulation_id === simulationId);
  if (!sim) {
    const err = new Error(`Simulation '${simulationId}' not found.`);
    (err as any).statusCode = 404;
    throw err;
  }
  assertOrgAccess(actor, sim.org_id, 'simulation session');

  sim.status = 'RUNNING';

  // Deep-clone read-only snapshot of live operational data — NEVER mutate store.state.*
  const clonedIncidents = structuredClone(store.state.incidents.filter((i) => i.mode === sim.mode));
  const clonedWarehouses = structuredClone(store.state.warehouses.filter((w) => w.mode === sim.mode));
  const clonedInventory = structuredClone(store.state.inventory.filter((i) => i.mode === sim.mode));
  const clonedRequests = structuredClone(
    store.state.reliefRequests.filter((r) => r.mode === sim.mode && r.status !== 'delivered' && r.status !== 'closed')
  );
  const clonedVehicles = structuredClone(store.state.vehicles.filter((v) => v.mode === sim.mode));
  const clonedDispatches = structuredClone(store.state.dispatches.filter((d) => d.mode === sim.mode));

  const focusIncident = sim.incident_id
    ? clonedIncidents.find((i) => i.id === sim.incident_id) || clonedIncidents[0] || null
    : clonedIncidents[0] || null;

  const baseOpWarehouses = clonedWarehouses.filter((w) => isWarehouseOperationalForDispatch(w.status, w.active));
  const baseOpWhIds = new Set(baseOpWarehouses.map((w) => w.id));

  const baseDemand = clonedRequests.reduce(
    (sum, r) => sum + r.items.reduce((s, it) => s + it.quantity, 0),
    0
  );
  const baseAvailable = clonedInventory
    .filter((i) => baseOpWhIds.has(i.warehouseId))
    .reduce((sum, i) => sum + Math.max(0, i.availableQty), 0);
  const baseShortage = Math.max(0, baseDemand - baseAvailable);
  const baseFulfillment =
    baseDemand > 0 ? Number(Math.min(100, (baseAvailable / baseDemand) * 100).toFixed(1)) : 100;
  const baseAvailVehicles = clonedVehicles.filter((v) => v.status === 'available').length;
  const baseEtaVals = clonedDispatches
    .map((d) => d.currentEtaMin ?? d.route?.durationMin ?? null)
    .filter((x): x is number => typeof x === 'number');
  const baseEta =
    baseEtaVals.length > 0 ? Math.round(baseEtaVals.reduce((a, b) => a + b, 0) / baseEtaVals.length) : 45;
  const baseRisk = focusIncident?.riskScore ?? 50;

  // Apply isolated scenario perturbation ONLY on local variables / clones
  let projRisk = baseRisk;
  let projDemand = baseDemand;
  let projAvailable = baseAvailable;
  let projOpWarehouses = baseOpWarehouses.length;
  let projAvailVehicles = baseAvailVehicles;
  let projEta = baseEta;

  const riskNotes: string[] = [];
  const supplyNotes: string[] = [];
  const routeNotes: string[] = [];
  const contingencies: string[] = [];
  const p = sim.parameters || {};

  switch (sim.scenario_type) {
    case 'flood_escalation': {
      const pct = Number(p.escalationPct ?? 35);
      projRisk = Math.min(100, Math.round(baseRisk + pct * 0.6));
      projDemand = Math.round(baseDemand * (1 + pct / 100));
      projEta = Math.round(baseEta * 1.45);
      riskNotes.push(`Simulated flood escalation (+${pct}%) raises incident risk from ${baseRisk} to ${projRisk}/100.`);
      supplyNotes.push(`Projected relief demand expands by ${projDemand - baseDemand} units (food, water, shelter).`);
      routeNotes.push(`Flood inundation adds ~${projEta - baseEta} min average corridor detour time.`);
      contingencies.push('Pre-position high-clearance rescue vehicles and water purification kits at elevated hubs.');
      break;
    }
    case 'rainfall_increase': {
      const extraMm = Number(p.additionalRainfallMm ?? 60);
      projRisk = Math.min(100, Math.round(baseRisk + Math.min(28, extraMm * 0.35)));
      projEta = Math.round(baseEta + Math.min(60, extraMm * 0.5));
      riskNotes.push(`Simulated +${extraMm}mm rainfall intensifies runoff and landslide susceptibility (risk → ${projRisk}/100).`);
      routeNotes.push(`Heavy rain reduces convoy speed; projected ETA increases by +${projEta - baseEta} min.`);
      contingencies.push('Require waterproof cargo tarps and field passability check on low-lying bridges.');
      break;
    }
    case 'warehouse_closure': {
      const targetWhId = String(p.warehouseId || baseOpWarehouses[0]?.id || '');
      const closedWh = baseOpWarehouses.find((w) => w.id === targetWhId) || baseOpWarehouses[0];
      const lostStock = closedWh
        ? clonedInventory
            .filter((i) => i.warehouseId === closedWh.id)
            .reduce((s, i) => s + Math.max(0, i.availableQty), 0)
        : 0;
      projOpWarehouses = Math.max(0, baseOpWarehouses.length - (closedWh ? 1 : 0));
      projAvailable = Math.max(0, baseAvailable - lostStock);
      projEta = Math.round(baseEta + 28);
      supplyNotes.push(
        closedWh
          ? `Simulated closure of ${closedWh.name} removes ${lostStock} available units from dispatch eligibility.`
          : 'No operational warehouse available to simulate closure.'
      );
      routeNotes.push('Longer secondary hub corridors increase average transit duration by ~28 min.');
      contingencies.push('Trigger split-allocation across remaining operational depots and initiate replenishment.');
      break;
    }
    case 'resource_shortage': {
      const dropPct = Number(p.stockReductionPct ?? 40);
      const lost = Math.round((baseAvailable * dropPct) / 100);
      projAvailable = Math.max(0, baseAvailable - lost);
      supplyNotes.push(`Simulated ${dropPct}% stock depletion reduces available supply by ${lost} units.`);
      contingencies.push('Activate emergency rationing prioritizing vulnerable households and request regional stock transfer.');
      break;
    }
    case 'vehicle_breakdown': {
      const lostVehicles = Math.min(baseAvailVehicles, Math.max(1, Number(p.vehiclesLost ?? 1)));
      projAvailVehicles = Math.max(0, baseAvailVehicles - lostVehicles);
      projEta = Math.round(baseEta + lostVehicles * 22);
      routeNotes.push(`Simulated breakdown removes ${lostVehicles} vehicle(s), leaving ${projAvailVehicles} idle.`);
      contingencies.push('Reassign backup driver/vehicle or consolidate multi-stop manifest on remaining heavy truck.');
      break;
    }
    case 'route_disruption': {
      const delayMin = Number(p.detourMinutes ?? 45);
      projEta = baseEta + delayMin;
      projRisk = Math.min(100, baseRisk + 10);
      routeNotes.push(`Primary route disruption forces alternate corridor (+${delayMin} min estimated delay).`);
      contingencies.push('Select lowest-risk alternate corridor and confirm clearance with field responders.');
      break;
    }
    case 'new_emergency_request': {
      const addUnits = Number(p.additionalUnits ?? 500);
      projDemand = baseDemand + addUnits;
      supplyNotes.push(`Incoming simulated emergency request adds ${addUnits} relief units to total demand.`);
      contingencies.push('Re-evaluate fairness allocation across competing incidents before approving new dispatches.');
      break;
    }
    case 'population_increase': {
      const addPeople = Number(p.additionalPeople ?? 400);
      const addUnits = Math.round(addPeople * 1.5);
      projDemand = baseDemand + addUnits;
      projRisk = Math.min(100, baseRisk + 14);
      riskNotes.push(`Simulated displacement surge (+${addPeople} affected persons) elevates human impact risk to ${projRisk}/100.`);
      supplyNotes.push(`Estimated additional relief demand: +${addUnits} units.`);
      contingencies.push('Expand shelter capacity and reserve medical/hydration kits.');
      break;
    }
    case 'delivery_delay': {
      const delayMin = Number(p.delayMinutes ?? 60);
      projEta = baseEta + delayMin;
      projRisk = Math.min(100, baseRisk + 8);
      routeNotes.push(`Simulated +${delayMin} min convoy delay breaches urgency buffers at destination.`);
      contingencies.push('Notify shelter coordinator and stage secondary fast-response light vehicle.');
      break;
    }
    case 'power_outage': {
      projRisk = Math.min(100, baseRisk + 16);
      projDemand = baseDemand + 120;
      riskNotes.push('Simulated regional power outage affects cold-chain medical storage and communications.');
      supplyNotes.push('Adds immediate demand for generators, batteries, fuel, and portable lighting.');
      contingencies.push('Prioritize generator/fuel dispatch to medical shelters and verify cold-chain integrity.');
      break;
    }
    case 'multi_incident': {
      const concurrentCount = Number(p.concurrentIncidents ?? 2);
      projRisk = Math.min(100, baseRisk + concurrentCount * 10);
      projDemand = Math.round(baseDemand * (1 + concurrentCount * 0.45));
      projAvailVehicles = Math.max(0, baseAvailVehicles - concurrentCount);
      projEta = baseEta + concurrentCount * 20;
      riskNotes.push(`Simulated ${concurrentCount} concurrent emergency incident(s) strain command bandwidth and fleet.`);
      supplyNotes.push(`Multi-incident demand surges to ${projDemand} units.`);
      routeNotes.push(`Fleet pool shrinks to ${projAvailVehicles} idle vehicle(s).`);
      contingencies.push('Enforce fairness-weighted allocation caps and request mutual-aid fleet support.');
      break;
    }
  }

  const projShortage = Math.max(0, projDemand - projAvailable);
  const projFulfillment =
    projDemand > 0 ? Number(Math.min(100, (projAvailable / projDemand) * 100).toFixed(1)) : 100;

  const now = new Date().toISOString();
  const result: AISimulationResult = {
    result_id: `simres-${uuidv4().slice(0, 12)}`,
    simulation_id: sim.simulation_id,
    org_id: sim.org_id,
    label: 'SIMULATION — NOT A LIVE EMERGENCY',
    scenario_type: sim.scenario_type,
    baseline_metrics: {
      incident_risk_score: baseRisk,
      total_demand_units: baseDemand,
      total_available_stock: baseAvailable,
      shortage_units: baseShortage,
      fulfillment_pct: baseFulfillment,
      operational_warehouses: baseOpWarehouses.length,
      available_vehicles: baseAvailVehicles,
      estimated_delivery_min: baseEta,
    },
    projected_metrics: {
      incident_risk_score: projRisk,
      total_demand_units: projDemand,
      total_available_stock: projAvailable,
      shortage_units: projShortage,
      fulfillment_pct: projFulfillment,
      operational_warehouses: projOpWarehouses,
      available_vehicles: projAvailVehicles,
      estimated_delivery_min: projEta,
    },
    deltas: {
      risk_score_delta: projRisk - baseRisk,
      shortage_delta: projShortage - baseShortage,
      fulfillment_pct_delta: Number((projFulfillment - baseFulfillment).toFixed(1)),
      delivery_delay_min_delta: projEta - baseEta,
    },
    risk_escalation_notes: riskNotes,
    supply_impact_notes: supplyNotes,
    route_and_fleet_notes: routeNotes,
    recommended_contingencies: contingencies,
    evidence_basis: [
      `Cloned read-only snapshot from mode='${sim.mode}' (${clonedIncidents.length} incidents, ${clonedWarehouses.length} warehouses, ${clonedInventory.length} inventory SKUs, ${clonedVehicles.length} vehicles).`,
      'Zero live operational records were modified during simulation.',
    ],
    mutated_live_data: false,
    created_at: now,
    mode: sim.mode,
  };

  sim.status = 'COMPLETED';
  sim.completed_at = now;
  sim.result_id = result.result_id;
  store.state.aiSimulationResults.unshift(result);
  if (store.state.aiSimulationResults.length > 200) store.state.aiSimulationResults.length = 200;
  store.save();

  eventBus.publish({
    event_type: 'ai.simulation.completed',
    organization_id: sim.org_id,
    entity_id: sim.simulation_id,
    source: 'ai-simulation-engine',
    mode: sim.mode,
    payload: {
      simulation_id: sim.simulation_id,
      label: 'SIMULATION — NOT A LIVE EMERGENCY',
      scenario_type: sim.scenario_type,
      deltas: result.deltas,
      mutated_live_data: false,
    },
  });

  return { simulation: sim, result };
}

export function compareSimulations(simulationIds: string[], actor: RequestActor) {
  const sims = simulationIds
    .map((id) => store.state.aiSimulationSessions.find((s) => s.simulation_id === id))
    .filter((s): s is AISimulationSession => Boolean(s));

  for (const s of sims) {
    assertOrgAccess(actor, s.org_id, `simulation ${s.simulation_id}`);
  }

  const comparisons = sims.map((s) => {
    const res = store.state.aiSimulationResults.find((r) => r.simulation_id === s.simulation_id) || null;
    return {
      simulation_id: s.simulation_id,
      title: s.title,
      scenario_type: s.scenario_type,
      label: s.label,
      status: s.status,
      baseline: res?.baseline_metrics || null,
      projected: res?.projected_metrics || null,
      deltas: res?.deltas || null,
      recommended_contingencies: res?.recommended_contingencies || [],
    };
  });

  const highestRiskImpact = [...comparisons]
    .filter((c) => c.deltas)
    .sort((a, b) => (b.deltas!.risk_score_delta || 0) - (a.deltas!.risk_score_delta || 0))[0] || null;
  const highestShortageImpact = [...comparisons]
    .filter((c) => c.deltas)
    .sort((a, b) => (b.deltas!.shortage_delta || 0) - (a.deltas!.shortage_delta || 0))[0] || null;

  return {
    label: 'SIMULATION — NOT A LIVE EMERGENCY',
    compared_count: comparisons.length,
    comparisons,
    highest_risk_impact: highestRiskImpact?.simulation_id || null,
    highest_shortage_impact: highestShortageImpact?.simulation_id || null,
  };
}

// ============================================================================
// PROACTIVE INTELLIGENCE & MONITORING TRIGGER ENGINE
// ============================================================================

let triggerSubscriptionInitialized = false;

function recordTriggerWithCooldown(params: {
  triggerType: AITriggerEvent['trigger_type'];
  dedupKey: string;
  orgId: string;
  entityType: string;
  entityId: string;
  incidentId?: string | null;
  severity: AITriggerEvent['severity'];
  title: string;
  reason: string;
  recommendedAction: string;
  cooldownMinutes?: number;
  mode: DataMode;
}): AITriggerEvent | null {
  const cooldownMin = params.cooldownMinutes ?? 10;
  const cutoff = Date.now() - cooldownMin * 60_000;
  const dup = store.state.aiTriggerEvents.find(
    (t) =>
      t.dedup_key === params.dedupKey &&
      t.mode === params.mode &&
      t.status !== 'DISMISSED' &&
      new Date(t.created_at).getTime() > cutoff
  );
  if (dup) return null;

  const trigger: AITriggerEvent = {
    trigger_id: `trig-${uuidv4().slice(0, 12)}`,
    org_id: params.orgId,
    trigger_type: params.triggerType,
    dedup_key: params.dedupKey,
    entity_type: params.entityType,
    entity_id: params.entityId,
    incident_id: params.incidentId || null,
    severity: params.severity,
    title: params.title,
    reason: params.reason,
    recommended_action: params.recommendedAction,
    status: 'ACTIVE',
    linked_session_id: null,
    acknowledged_by: null,
    acknowledged_at: null,
    cooldown_minutes: cooldownMin,
    created_at: new Date().toISOString(),
    mode: params.mode,
  };

  store.state.aiTriggerEvents.unshift(trigger);
  if (store.state.aiTriggerEvents.length > 300) {
    store.state.aiTriggerEvents.length = 300;
  }
  store.save();

  // Publish without recursively triggering itself
  eventBus.publish({
    event_type: 'ai.trigger.detected',
    organization_id: trigger.org_id,
    entity_id: trigger.trigger_id,
    source: 'ai-proactive-monitor',
    mode: trigger.mode,
    payload: {
      trigger_id: trigger.trigger_id,
      trigger_type: trigger.trigger_type,
      severity: trigger.severity,
      title: trigger.title,
      incident_id: trigger.incident_id,
    },
  });

  return trigger;
}

export function initProactiveTriggerEngine() {
  if (triggerSubscriptionInitialized) return;
  triggerSubscriptionInitialized = true;

  eventBus.subscribe((ev: SystemEvent) => {
    // Never recursively trigger on AI events
    if (ev.event_type.startsWith('ai.')) return;

    const p: Record<string, any> = ev.payload || {};
    const orgId = ev.organization_id || 'org-central-cmd';

    const incSeverity = p.severity || p.incident?.severity;
    if (ev.event_type === 'incident.verified' && (incSeverity === 'critical' || incSeverity === 'high')) {
      recordTriggerWithCooldown({
        triggerType: 'CRITICAL_INCIDENT_VERIFIED',
        dedupKey: `inc-verified:${ev.entity_id}`,
        orgId,
        entityType: 'incident',
        entityId: ev.entity_id,
        incidentId: ev.entity_id,
        severity: incSeverity === 'critical' ? 'critical' : 'high',
        title: `Critical/High incident verified (${p.incident?.title || ev.entity_id})`,
        reason: 'Commander verified a high-severity incident requiring coordinated multi-agent response planning.',
        recommendedAction: 'Start AI Coordination Session for incident.',
        mode: ev.mode,
      });
    } else if (
      (ev.event_type === 'risk.assessment_updated' || ev.event_type === 'incident.severity_changed') &&
      Number(p.overallScore || p.assessment?.overallScore || p.incident?.severityLevel * 20 || 0) >= 70
    ) {
      const score = Number(p.overallScore || p.assessment?.overallScore || p.incident?.severityLevel * 20 || 80);
      recordTriggerWithCooldown({
        triggerType: 'INCIDENT_RISK_THRESHOLD_CROSSED',
        dedupKey: `risk-threshold:${ev.entity_id}`,
        orgId,
        entityType: 'incident',
        entityId: ev.entity_id,
        incidentId: ev.entity_id,
        severity: score >= 80 ? 'critical' : 'high',
        title: `Incident risk crossed threshold (${score}/100)`,
        reason: `Deterministic risk score reached ${score}/100 (${p.band || p.assessment?.band || 'high'}).`,
        recommendedAction: 'Reassess response plan and verify reserve inventory.',
        mode: ev.mode,
      });
    } else if (ev.event_type === 'warehouse.status_changed') {
      const whStatus = p.status || p.warehouse?.status;
      if (whStatus && whStatus !== 'operational' && whStatus !== 'limited_operations') {
        recordTriggerWithCooldown({
          triggerType: 'WAREHOUSE_UNAVAILABLE',
          dedupKey: `wh-unavail:${ev.entity_id}:${whStatus}`,
          orgId,
          entityType: 'warehouse',
          entityId: ev.entity_id,
          severity: 'critical',
          title: `Warehouse became unavailable (${whStatus})`,
          reason: `Warehouse ${p.name || p.warehouse?.name || ev.entity_id} transitioned to '${whStatus}'.`,
          recommendedAction: 'Rebalance active allocations to alternate operational warehouses.',
          mode: ev.mode,
        });
      }
    } else if (ev.event_type === 'inventory.critical_stock_alert') {
      recordTriggerWithCooldown({
        triggerType: 'CRITICAL_STOCK_SHORTAGE',
        dedupKey: `crit-stock:${ev.entity_id}`,
        orgId,
        entityType: 'inventory',
        entityId: ev.entity_id,
        severity: 'critical',
        title: `Critical stock shortage detected (${p.itemName || p.stock?.itemName || ev.entity_id})`,
        reason: `Available quantity fell to ${p.availableQty ?? p.stock?.availableQty ?? 'critical'} below threshold.`,
        recommendedAction: 'Run Resource Intelligence coordination for emergency replenishment.',
        mode: ev.mode,
      });
    } else if (ev.event_type === 'route.hazard_reported') {
      const hzSeverity = p.severity || p.hazard?.severity;
      const hzType = p.type || p.hazard?.type || 'corridor obstruction';
      recordTriggerWithCooldown({
        triggerType: 'ROUTE_HAZARD_VERIFIED',
        dedupKey: `hazard:${ev.entity_id}`,
        orgId,
        entityType: 'route_hazard',
        entityId: ev.entity_id,
        severity: hzSeverity === 'critical' ? 'critical' : 'high',
        title: `Route hazard reported (${hzType})`,
        reason: `Active road hazard reported near logistics corridor.`,
        recommendedAction: 'Review active dispatches for safe rerouting.',
        mode: ev.mode,
      });
    } else if (
      ev.event_type === 'dispatch.delayed' ||
      ((ev.event_type === 'dispatch.status_updated' || ev.event_type === 'dispatch.status_changed') &&
        String(p.status || p.dispatch?.status || '').toLowerCase() === 'delayed')
    ) {
      recordTriggerWithCooldown({
        triggerType: 'DISPATCH_DELAYED',
        dedupKey: `dispatch-delay:${ev.entity_id}`,
        orgId,
        entityType: 'dispatch',
        entityId: ev.entity_id,
        severity: 'high',
        title: `Active dispatch delayed (${ev.entity_id})`,
        reason: 'Dispatch reported delay; destination ETA impacted.',
        recommendedAction: 'Assess contingency staging or backup vehicle.',
        mode: ev.mode,
      });
    } else if (
      (ev.event_type === 'delivery.confirmed' || ev.event_type === 'delivery.completed') &&
      (p.deliveryStatus === 'PARTIALLY_DELIVERED' ||
        p.status === 'PARTIALLY_DELIVERED' ||
        p.delivery?.status === 'PARTIALLY_DELIVERED')
    ) {
      recordTriggerWithCooldown({
        triggerType: 'PARTIAL_DELIVERY_UNMET_NEED',
        dedupKey: `partial-del:${ev.entity_id}`,
        orgId,
        entityType: 'delivery',
        entityId: ev.entity_id,
        severity: 'high',
        title: `Partial delivery left unmet humanitarian demand`,
        reason: 'Confirmed delivery was partial; remaining items still required at site.',
        recommendedAction: 'Plan follow-up replenishment dispatch.',
        mode: ev.mode,
      });
    } else if (
      (ev.event_type === 'relief_request.created' || ev.event_type === 'request.created') &&
      (p.urgency === 'critical' || p.request?.urgency === 'critical' || p.request?.priorityCategory === 'CRITICAL')
    ) {
      const reqIncId = p.incidentId || p.request?.incidentId;
      recordTriggerWithCooldown({
        triggerType: 'HIGH_PRIORITY_REQUEST_CREATED',
        dedupKey: `crit-req:${ev.entity_id}`,
        orgId,
        entityType: 'relief_request',
        entityId: ev.entity_id,
        incidentId: typeof reqIncId === 'string' ? reqIncId : null,
        severity: 'critical',
        title: `Critical relief request created (${p.request?.locationName || ev.entity_id})`,
        reason: 'New critical-urgency humanitarian relief request requires immediate warehouse matching.',
        recommendedAction: 'Initiate AI Coordination Session to generate allocation & dispatch plan.',
        mode: ev.mode,
      });
    } else if (
      ev.event_type === 'fleet.vehicle_status_changed' ||
      ev.event_type === 'fleet.vehicle_updated'
    ) {
      const vehStatus = p.status || p.vehicle?.status;
      if (vehStatus === 'maintenance' || vehStatus === 'out_of_service') {
        recordTriggerWithCooldown({
          triggerType: 'VEHICLE_UNAVAILABLE',
          dedupKey: `veh-unavail:${ev.entity_id}:${vehStatus}`,
          orgId,
          entityType: 'vehicle',
          entityId: ev.entity_id,
          severity: 'medium',
          title: `Fleet vehicle unavailable (${vehStatus})`,
          reason: `Vehicle ${p.callsign || p.vehicle?.callsign || ev.entity_id} changed to '${vehStatus}'.`,
          recommendedAction: 'Check pending dispatches for vehicle reassignment.',
          mode: ev.mode,
        });
      }
    }
  });
}

export function acknowledgeTriggerEvent(triggerId: string, actor: RequestActor): AITriggerEvent {
  const trigger = store.state.aiTriggerEvents.find((t) => t.trigger_id === triggerId);
  if (!trigger) {
    const err = new Error(`Trigger '${triggerId}' not found.`);
    (err as any).statusCode = 404;
    throw err;
  }
  assertOrgAccess(actor, trigger.org_id, 'monitoring trigger');
  trigger.status = 'ACKNOWLEDGED';
  trigger.acknowledged_by = actor.name;
  trigger.acknowledged_at = new Date().toISOString();
  store.save();
  return trigger;
}

// ============================================================================
// REAL AI COORDINATION ANALYTICS (ZERO FABRICATED NUMBERS)
// ============================================================================

export function computeAICoordinationAnalytics(mode: DataMode, actor: RequestActor): AICoordinationAnalytics {
  const agents = ensureAgentRegistrySeeded();
  const sessions = store.state.aiCoordinationSessions.filter(
    (s) => s.mode === mode && canAccessOrg(actor, s.org_id)
  );
  const tasks = store.state.aiAgentTasks.filter((t) => t.mode === mode && canAccessOrg(actor, t.org_id));
  const plans = store.state.aiResponsePlans.filter((p) => p.mode === mode && canAccessOrg(actor, p.org_id));
  const conflicts = store.state.aiConflicts.filter((c) => c.mode === mode && canAccessOrg(actor, c.org_id));
  const evidence = store.state.aiEvidenceRecords.filter((e) => e.mode === mode && canAccessOrg(actor, e.org_id));
  const triggers = store.state.aiTriggerEvents.filter((t) => t.mode === mode && canAccessOrg(actor, t.org_id));
  const sims = store.state.aiSimulationSessions.filter((s) => s.mode === mode && canAccessOrg(actor, s.org_id));

  const durations = sessions
    .map((s) => s.metrics.total_execution_ms)
    .filter((d): d is number => typeof d === 'number');

  const decidedPlans = plans.filter((p) =>
    ['APPROVED', 'PARTIALLY_APPROVED', 'MODIFIED', 'REJECTED', 'EXECUTED'].includes(p.status)
  );
  const approvedPlans = plans.filter((p) => ['APPROVED', 'PARTIALLY_APPROVED', 'EXECUTED'].includes(p.status));
  const modifiedPlans = plans.filter((p) => p.status === 'MODIFIED' || Boolean(p.modification_notes));
  const rejectedPlans = plans.filter((p) => p.status === 'REJECTED');
  const executedPlans = plans.filter((p) => p.status === 'EXECUTED');

  const byClass: Record<ClaimClassification, number> = {
    'VERIFIED FACT': 0,
    'CALCULATED RESULT': 0,
    'AI INTERPRETATION': 0,
    ASSUMPTION: 0,
    UNKNOWN: 0,
  };
  for (const e of evidence) {
    byClass[e.claim_classification] = (byClass[e.claim_classification] || 0) + 1;
  }

  return {
    mode,
    total_sessions: sessions.length,
    completed_sessions: sessions.filter((s) => s.status === 'COMPLETED').length,
    partial_sessions: sessions.filter((s) => s.status === 'PARTIAL').length,
    failed_sessions: sessions.filter((s) => s.status === 'FAILED').length,
    cancelled_sessions: sessions.filter((s) => s.status === 'CANCELLED').length,
    avg_session_duration_ms:
      durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    agent_metrics: agents.map((a) => {
      const aTasks = tasks.filter((t) => t.agent_id === a.agent_id);
      const comp = aTasks.filter((t) => t.status === 'COMPLETED').length;
      const fail = aTasks.filter((t) => t.status === 'FAILED' || t.status === 'TIMED_OUT').length;
      const tDur = aTasks.map((t) => t.execution_time_ms).filter((x): x is number => typeof x === 'number');
      return {
        agent_id: a.agent_id,
        name: a.name,
        total_tasks: aTasks.length,
        completed_tasks: comp,
        failed_tasks: fail,
        success_rate_pct: aTasks.length > 0 ? Number(((comp / aTasks.length) * 100).toFixed(1)) : null,
        avg_execution_ms: tDur.length > 0 ? Math.round(tDur.reduce((x, y) => x + y, 0) / tDur.length) : null,
      };
    }),
    plans_total: plans.length,
    plans_approved: approvedPlans.length,
    plans_modified: modifiedPlans.length,
    plans_rejected: rejectedPlans.length,
    plans_executed: executedPlans.length,
    approval_rate_pct:
      decidedPlans.length > 0 ? Number(((approvedPlans.length / decidedPlans.length) * 100).toFixed(1)) : null,
    modification_rate_pct:
      decidedPlans.length > 0 ? Number(((modifiedPlans.length / decidedPlans.length) * 100).toFixed(1)) : null,
    rejection_rate_pct:
      decidedPlans.length > 0 ? Number(((rejectedPlans.length / decidedPlans.length) * 100).toFixed(1)) : null,
    conflicts_total: conflicts.length,
    conflicts_resolved: conflicts.filter(
      (c) => c.resolution_status === 'RESOLVED_HUMAN' || c.resolution_status === 'RESOLVED_DETERMINISTIC'
    ).length,
    conflicts_open: conflicts.filter(
      (c) => c.resolution_status === 'OPEN' || c.resolution_status === 'ESCALATED_HUMAN'
    ).length,
    evidence_total: evidence.length,
    evidence_by_classification: byClass,
    safety_rejections: plans.filter((p) => p.safety_validation.status === 'REJECTED').length,
    safety_warnings: plans.filter((p) => p.safety_validation.status === 'VALID_WITH_WARNINGS').length,
    triggers_total: triggers.length,
    triggers_active: triggers.filter((t) => t.status === 'ACTIVE').length,
    simulations_total: sims.length,
    tokens_estimated_total: sessions.reduce((s, x) => s + x.metrics.tokens_estimated, 0),
    provider_health: getAIProviderHealth(),
  };
}
