import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  CheckCircle2,
  Clock,
  Cpu,
  Database,
  FileCheck2,
  FlaskConical,
  GitBranch,
  Play,
  RefreshCw,
  Scale,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  XCircle,
} from 'lucide-react';
import { apiRequest } from '../../lib/api';
import type {
  AIAgentDefinition,
  AIAgentResult,
  AIAgentTask,
  AIApprovalEvent,
  AIApprovalRequest,
  AIConflictRecord,
  AICoordinationAnalytics,
  AICoordinationEvent,
  AICoordinationSession,
  AIEvidenceRecord,
  AIPlanAction,
  AIResponsePlan,
  AISessionMemory,
  AISimulationResult,
  AISimulationSession,
  AISimulationType,
  AITriggerEvent,
  ClaimClassification,
  CoordinationAgentId,
  DataMode,
  Incident,
} from '../../shared/types';

interface AICommandCenterViewProps {
  mode: DataMode;
  incidents: Incident[];
  initialSessionId?: string | null;
  onRefresh: () => void;
}

interface SessionDetailBundle {
  session: AICoordinationSession;
  tasks: AIAgentTask[];
  results: AIAgentResult[];
  plan: AIResponsePlan | null;
  actions: AIPlanAction[];
  approval: AIApprovalRequest | null;
  conflicts: AIConflictRecord[];
  evidence: AIEvidenceRecord[];
  memory: AISessionMemory[];
  events: AICoordinationEvent[];
}

const SIMULATION_OPTIONS: { value: AISimulationType; label: string }[] = [
  { value: 'flood_escalation', label: 'Flood Escalation (+%)' },
  { value: 'rainfall_increase', label: 'Rainfall Increase (+mm)' },
  { value: 'warehouse_closure', label: 'Warehouse Closure' },
  { value: 'resource_shortage', label: 'Resource Shortage (-% stock)' },
  { value: 'vehicle_breakdown', label: 'Vehicle Breakdown' },
  { value: 'route_disruption', label: 'Route Disruption (Detour)' },
  { value: 'new_emergency_request', label: 'New Emergency Request Surge' },
  { value: 'population_increase', label: 'Affected Population Increase' },
  { value: 'delivery_delay', label: 'Delivery Delay (+min)' },
  { value: 'power_outage', label: 'Regional Power Outage' },
  { value: 'multi_incident', label: 'Multi-Incident Concurrency' },
];

const CLAIM_CLASSIFICATIONS: ClaimClassification[] = [
  'VERIFIED FACT',
  'CALCULATED RESULT',
  'AI INTERPRETATION',
  'ASSUMPTION',
  'UNKNOWN',
];

function statusTone(status: string): string {
  const s = status.toUpperCase();
  if (s === 'VALID' || s === 'COMPLETED' || s === 'APPROVED' || s === 'EXECUTED' || s === 'RESOLVED_HUMAN' || s === 'RESOLVED_DETERMINISTIC') {
    return 'text-emerald-600 dark:text-emerald-400';
  }
  if (s === 'REJECTED' || s === 'FAILED' || s === 'TIMED_OUT' || s === 'INVALIDATED' || s === 'EXECUTION_BLOCKED' || s === 'CRITICAL') {
    return 'text-red-600 dark:text-red-400';
  }
  if (s === 'VALID_WITH_WARNINGS' || s === 'PARTIAL' || s === 'DEGRADED' || s === 'ESCALATED_HUMAN' || s === 'PENDING' || s === 'PENDING_APPROVAL' || s === 'OPEN') {
    return 'text-amber-600 dark:text-amber-400';
  }
  return 'text-slate-600 dark:text-slate-400';
}

export const AICommandCenterView: React.FC<AICommandCenterViewProps> = ({
  mode,
  incidents,
  initialSessionId,
  onRefresh,
}) => {
  const [tab, setTab] = useState<'command' | 'plan' | 'approvals' | 'evidence' | 'simulations' | 'monitoring'>('command');
  const [agents, setAgents] = useState<AIAgentDefinition[]>([]);
  const [sessions, setSessions] = useState<AICoordinationSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(initialSessionId || null);
  const [bundle, setBundle] = useState<SessionDetailBundle | null>(null);
  const [approvals, setApprovals] = useState<AIApprovalRequest[]>([]);
  const [approvalEvents, setApprovalEvents] = useState<AIApprovalEvent[]>([]);
  const [evidenceList, setEvidenceList] = useState<AIEvidenceRecord[]>([]);
  const [conflictsList, setConflictsList] = useState<AIConflictRecord[]>([]);
  const [simulations, setSimulations] = useState<AISimulationSession[]>([]);
  const [simResults, setSimResults] = useState<AISimulationResult[]>([]);
  const [triggers, setTriggers] = useState<AITriggerEvent[]>([]);
  const [analytics, setAnalytics] = useState<AICoordinationAnalytics | null>(null);

  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Start Coordination Form
  const [launchIncidentId, setLaunchIncidentId] = useState<string>(incidents[0]?.id || '');
  const [launchObjective, setLaunchObjective] = useState('');

  // Conflict Resolution inline inputs
  const [conflictNotes, setConflictNotes] = useState<Record<string, string>>({});

  // Approval notes / modification
  const [decisionNote, setDecisionNote] = useState('');
  const [modNotes, setModNotes] = useState('');

  // Evidence filters
  const [evSearch, setEvSearch] = useState('');
  const [evClassFilter, setEvClassFilter] = useState<string>('all');

  // Simulation Creator
  const [simTitle, setSimTitle] = useState('');
  const [simType, setSimType] = useState<AISimulationType>('flood_escalation');
  const [simIncidentId, setSimIncidentId] = useState<string>(incidents[0]?.id || '');
  const [simParamValue, setSimParamValue] = useState<number>(40);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareReport, setCompareReport] = useState<any | null>(null);

  // Memory Creator
  const [memType, setMemType] = useState<AISessionMemory['memory_type']>('human_decision');
  const [memTitle, setMemTitle] = useState('');
  const [memContent, setMemContent] = useState('');

  const loadOverview = useCallback(async () => {
    try {
      const [agRes, sesRes, apprRes, evRes, confRes, simRes, trigRes, anaRes] = await Promise.all([
        apiRequest<{ agents: AIAgentDefinition[] }>('/ai/agents'),
        apiRequest<{ sessions: AICoordinationSession[] }>(`/ai/coordination/sessions?mode=${mode}`),
        apiRequest<{ approvals: AIApprovalRequest[]; events: AIApprovalEvent[] }>(`/ai/approvals?mode=${mode}`),
        apiRequest<{ evidence: AIEvidenceRecord[] }>(`/ai/evidence?mode=${mode}`),
        apiRequest<{ conflicts: AIConflictRecord[] }>(`/ai/conflicts?mode=${mode}`),
        apiRequest<{ simulations: AISimulationSession[]; results: AISimulationResult[] }>(`/ai/simulations?mode=${mode}`),
        apiRequest<{ triggers: AITriggerEvent[] }>(`/ai/monitoring/triggers?mode=${mode}`),
        apiRequest<AICoordinationAnalytics>(`/ai/analytics?mode=${mode}`),
      ]);
      setAgents(agRes.agents || []);
      setSessions(sesRes.sessions || []);
      setApprovals(apprRes.approvals || []);
      setApprovalEvents(apprRes.events || []);
      setEvidenceList(evRes.evidence || []);
      setConflictsList(confRes.conflicts || []);
      setSimulations(simRes.simulations || []);
      setSimResults(simRes.results || []);
      setTriggers(trigRes.triggers || []);
      setAnalytics(anaRes);

      if (!selectedSessionId && sesRes.sessions?.length > 0) {
        setSelectedSessionId(sesRes.sessions[0].session_id);
      }
    } catch (err) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : 'Failed to load AI coordination state' });
    }
  }, [mode, selectedSessionId]);

  const loadSessionDetail = useCallback(async (sessionId: string) => {
    try {
      const detail = await apiRequest<SessionDetailBundle>(`/ai/coordination/sessions/${sessionId}`);
      setBundle(detail);
    } catch {
      setBundle(null);
    }
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (initialSessionId) {
      setSelectedSessionId(initialSessionId);
    }
  }, [initialSessionId]);

  useEffect(() => {
    if (selectedSessionId) {
      loadSessionDetail(selectedSessionId);
    } else {
      setBundle(null);
    }
  }, [selectedSessionId, loadSessionDetail]);

  useEffect(() => {
    if (!launchIncidentId && incidents.length > 0) {
      setLaunchIncidentId(incidents[0].id);
      setSimIncidentId(incidents[0].id);
    }
  }, [incidents, launchIncidentId]);

  const handleStartCoordination = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const out = await apiRequest<{ session: AICoordinationSession }>('/ai/coordination/start', {
        method: 'POST',
        body: {
          incidentId: launchIncidentId || null,
          objective: launchObjective.trim() || undefined,
          mode,
          triggerSource: 'manual_operator',
          waitForCompletion: true,
        },
      });
      setLaunchObjective('');
      setSelectedSessionId(out.session.session_id);
      setFeedback({
        kind: 'ok',
        text: `Coordination session ${out.session.session_id} completed (${out.session.status}, safety: ${out.session.safety_status || 'PENDING'}).`,
      });
      await loadOverview();
      await loadSessionDetail(out.session.session_id);
      onRefresh();
    } catch (err) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : 'Coordination launch failed' });
    } finally {
      setBusy(false);
    }
  };

  const handleReanalyze = async (sessionId: string) => {
    setBusy(true);
    setFeedback(null);
    try {
      const out = await apiRequest<{ session: AICoordinationSession }>(`/ai/coordination/sessions/${sessionId}/reanalyze`, {
        method: 'POST',
        body: { waitForCompletion: true },
      });
      setSelectedSessionId(out.session.session_id);
      setFeedback({ kind: 'ok', text: `Re-analysis completed in session ${out.session.session_id}.` });
      await loadOverview();
      await loadSessionDetail(out.session.session_id);
    } catch (err) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : 'Re-analysis failed' });
    } finally {
      setBusy(false);
    }
  };

  const handleRerunAgent = async (agentId: CoordinationAgentId) => {
    if (!selectedSessionId) return;
    setBusy(true);
    setFeedback(null);
    try {
      await apiRequest(`/ai/agents/${agentId}/rerun`, {
        method: 'POST',
        body: { sessionId: selectedSessionId },
      });
      setFeedback({ kind: 'ok', text: `Reran ${agentId} on session ${selectedSessionId}.` });
      await loadOverview();
      await loadSessionDetail(selectedSessionId);
    } catch (err) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : 'Agent rerun failed' });
    } finally {
      setBusy(false);
    }
  };

  const handleResolveConflict = async (conflictId: string) => {
    const note = (conflictNotes[conflictId] || '').trim();
    if (note.length < 3) {
      setFeedback({ kind: 'err', text: 'Enter a resolution note (at least 3 characters) before resolving.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      await apiRequest(`/ai/conflicts/${conflictId}/resolve`, {
        method: 'POST',
        body: { resolutionNote: note },
      });
      setConflictNotes((prev) => ({ ...prev, [conflictId]: '' }));
      setFeedback({ kind: 'ok', text: `Conflict ${conflictId} marked resolved by human commander.` });
      await loadOverview();
      if (selectedSessionId) await loadSessionDetail(selectedSessionId);
    } catch (err) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : 'Conflict resolution failed' });
    } finally {
      setBusy(false);
    }
  };

  const handlePlanDecision = async (planId: string, action: 'validate' | 'approve' | 'reject' | 'defer' | 'execute') => {
    setBusy(true);
    setFeedback(null);
    try {
      const body =
        action === 'reject'
          ? { reason: decisionNote.trim() || 'Rejected after commander review' }
          : action === 'approve' || action === 'defer'
          ? { note: decisionNote.trim() || undefined }
          : {};
      await apiRequest(`/ai/plans/${planId}/${action}`, { method: 'POST', body });
      setDecisionNote('');
      setFeedback({ kind: 'ok', text: `Plan ${planId}: ${action.toUpperCase()} completed.` });
      await loadOverview();
      if (selectedSessionId) await loadSessionDetail(selectedSessionId);
      onRefresh();
    } catch (err) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : `Plan ${action} failed` });
    } finally {
      setBusy(false);
    }
  };

  const handleModifyPlan = async (planId: string) => {
    if (modNotes.trim().length < 2) {
      setFeedback({ kind: 'err', text: 'Enter modification notes to record plan adjustment.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      await apiRequest(`/ai/plans/${planId}/modify`, {
        method: 'POST',
        body: { modificationNotes: modNotes.trim(), actionUpdates: [] },
      });
      setModNotes('');
      setFeedback({ kind: 'ok', text: `Plan ${planId} updated and re-validated.` });
      await loadOverview();
      if (selectedSessionId) await loadSessionDetail(selectedSessionId);
    } catch (err) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : 'Plan modification failed' });
    } finally {
      setBusy(false);
    }
  };

  const handleCreateAndRunSimulation = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const paramKey =
        simType === 'flood_escalation'
          ? 'escalationPct'
          : simType === 'rainfall_increase'
          ? 'additionalRainfallMm'
          : simType === 'resource_shortage'
          ? 'stockReductionPct'
          : simType === 'vehicle_breakdown'
          ? 'vehiclesLost'
          : simType === 'route_disruption'
          ? 'detourMinutes'
          : simType === 'new_emergency_request'
          ? 'additionalUnits'
          : simType === 'population_increase'
          ? 'additionalPeople'
          : simType === 'delivery_delay'
          ? 'delayMinutes'
          : simType === 'multi_incident'
          ? 'concurrentIncidents'
          : 'intensity';

      const created = await apiRequest<{ simulation: AISimulationSession }>('/ai/simulations', {
        method: 'POST',
        body: {
          title: simTitle.trim() || `${simType.replace(/_/g, ' ')} stress test`,
          scenarioType: simType,
          incidentId: simIncidentId || null,
          parameters: { [paramKey]: simParamValue },
          mode,
        },
      });
      await apiRequest(`/ai/simulations/${created.simulation.simulation_id}/run`, { method: 'POST' });
      setSimTitle('');
      setFeedback({
        kind: 'ok',
        text: `Isolated simulation ${created.simulation.simulation_id} completed with zero live data mutation.`,
      });
      await loadOverview();
    } catch (err) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : 'Simulation failed' });
    } finally {
      setBusy(false);
    }
  };

  const handleCompareSimulations = async () => {
    if (compareIds.length < 2) {
      setFeedback({ kind: 'err', text: 'Select at least 2 completed simulations to compare.' });
      return;
    }
    setBusy(true);
    try {
      const res = await apiRequest('/ai/simulations/compare', {
        method: 'POST',
        body: { simulationIds: compareIds },
      });
      setCompareReport(res);
    } catch (err) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : 'Comparison failed' });
    } finally {
      setBusy(false);
    }
  };

  const handleAckTrigger = async (triggerId: string) => {
    setBusy(true);
    try {
      await apiRequest(`/ai/monitoring/triggers/${triggerId}/acknowledge`, { method: 'POST' });
      setFeedback({ kind: 'ok', text: `Trigger ${triggerId} acknowledged.` });
      await loadOverview();
    } catch (err) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : 'Acknowledge failed' });
    } finally {
      setBusy(false);
    }
  };

  const handleAddMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSessionId) return;
    setBusy(true);
    try {
      await apiRequest(`/ai/sessions/${selectedSessionId}/memory`, {
        method: 'POST',
        body: { memoryType: memType, title: memTitle.trim(), content: memContent.trim() },
      });
      setMemTitle('');
      setMemContent('');
      setFeedback({ kind: 'ok', text: 'Coordination memory entry recorded.' });
      await loadSessionDetail(selectedSessionId);
    } catch (err) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : 'Failed to store memory' });
    } finally {
      setBusy(false);
    }
  };

  const filteredEvidence = evidenceList.filter((ev) => {
    if (evClassFilter !== 'all' && ev.claim_classification !== evClassFilter) return false;
    if (evSearch.trim()) {
      const q = evSearch.toLowerCase();
      return (
        ev.claim.toLowerCase().includes(q) ||
        ev.source_type.toLowerCase().includes(q) ||
        ev.source_id.toLowerCase().includes(q) ||
        ev.agent_id.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const pendingApprovalsCount = approvals.filter((a) => a.status === 'PENDING' || a.status === 'MODIFIED').length;
  const openConflictsCount = conflictsList.filter(
    (c) => c.resolution_status === 'OPEN' || c.resolution_status === 'ESCALATED_HUMAN'
  ).length;
  const activeTriggersCount = triggers.filter((t) => t.status === 'ACTIVE').length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4 pb-4 border-b border-[var(--rf-border-default)]">
        <div className="space-y-1">
          <div className="text-xs font-medium text-[#5869E8] dark:text-[#35C8F5]">
            Multi-Agent Orchestration · {mode === 'demo' ? 'Sandbox Demo' : 'Operational Mode'}
          </div>
          <h1 className="text-2xl sm:text-[28px] font-bold text-[var(--rf-text-primary)] tracking-tight">
            AI Coordination Command Center
          </h1>
          <p className="text-sm text-[var(--rf-text-muted)] max-w-2xl">
            Evidence-grounded 8-agent orchestration, deterministic safety validation, commander approval gate, and isolated scenario simulation.
          </p>
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={loadOverview}
            disabled={busy}
            className="rf-btn-secondary min-h-[38px] text-xs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Feedback Banner */}
      {feedback && (
        <div
          className={`flex items-center justify-between px-4 py-3 rounded-xl border text-xs ${
            feedback.kind === 'ok'
              ? 'border-[#15966C]/35 dark:border-[#35D6A0]/35 bg-[#15966C]/10 dark:bg-[#35D6A0]/10 text-[#117A57] dark:text-[#35D6A0]'
              : 'border-[#E5465D]/40 dark:border-[#FF5C70]/40 bg-[#E5465D]/10 dark:bg-[#FF5C70]/10 text-[#C42B42] dark:text-[#FF8A98]'
          }`}
        >
          <span>{feedback.text}</span>
          <button type="button" onClick={() => setFeedback(null)} className="ml-3 underline text-[11px]">
            Dismiss
          </button>
        </div>
      )}

      {/* KPI Strip — Unified Midnight Command Metric Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5">
        {[
          { label: 'Registered Agents', value: String(agents.length), sub: 'Read-only allowlists' },
          { label: 'Sessions', value: String(sessions.length), sub: `${analytics?.completed_sessions ?? 0} completed` },
          { label: 'Pending Approvals', value: String(pendingApprovalsCount), sub: 'Human sign-off required' },
          { label: 'Open Conflicts', value: String(openConflictsCount), sub: `${conflictsList.length} total detected` },
          { label: 'Grounded Evidence', value: String(evidenceList.length), sub: 'Classified claims' },
          { label: 'Active Triggers', value: String(activeTriggersCount), sub: `${simulations.length} simulation(s)` },
        ].map((kpi) => (
          <div key={kpi.label} className="rf-card px-4 py-3.5">
            <div className="text-[11.5px] font-medium text-[var(--rf-text-muted)] truncate">{kpi.label}</div>
            <div className="text-2xl font-bold tabular-nums text-[var(--rf-text-primary)] mt-1.5 leading-none">
              {kpi.value}
            </div>
            <div className="text-[11px] text-[var(--rf-text-muted)] mt-1.5 truncate">{kpi.sub}</div>
          </div>
        ))}
      </div>

      {/* Section Tabs */}
      <div className="flex flex-wrap gap-1.5 border-b border-[var(--rf-border-default)] pb-2.5 text-xs">
        {(
          [
            ['command', 'Command & Agents', Cpu],
            ['plan', 'Response Plan & Conflicts', GitBranch],
            ['approvals', `Approval Center (${pendingApprovalsCount})`, ShieldCheck],
            ['evidence', `Evidence Explorer (${evidenceList.length})`, Database],
            ['simulations', `Simulation Studio (${simulations.length})`, FlaskConical],
            ['monitoring', `Triggers, Memory & Analytics`, BarChart3],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[10px] border font-medium whitespace-nowrap transition-colors ${
              tab === id
                ? 'border-[#5869E8]/50 dark:border-[#6D7CFF]/55 bg-[#5869E8]/10 dark:bg-[#6D7CFF]/16 text-[#5869E8] dark:text-white'
                : 'border-transparent text-[var(--rf-text-muted)] hover:bg-[var(--rf-surface-hover)] hover:text-[var(--rf-text-primary)]'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* =================================================================== */}
      {/* TAB 1: COMMAND CENTER, 8 AGENTS & TIMELINE                          */}
      {/* =================================================================== */}
      {tab === 'command' && (
        <div className="space-y-5">
          {/* Start Coordination Bar */}
          <form
            onSubmit={handleStartCoordination}
            className="rf-card p-5 grid md:grid-cols-12 gap-3.5 items-end"
          >
            <div className="md:col-span-4">
              <label className="block text-xs font-medium text-[var(--rf-text-secondary)] mb-1.5">
                Target Incident
              </label>
              <select
                value={launchIncidentId}
                onChange={(e) => setLaunchIncidentId(e.target.value)}
                className="rf-input w-full text-xs"
              >
                <option value="">System-Wide Active Picture</option>
                {incidents.map((inc) => (
                  <option key={inc.id} value={inc.id}>
                    [{inc.severity.toUpperCase()}] {inc.title} ({inc.status})
                  </option>
                ))}
              </select>
            </div>
            <div className="md:col-span-6">
              <label className="block text-xs font-medium text-[var(--rf-text-secondary)] mb-1.5">
                Coordination Objective (Optional)
              </label>
              <input
                type="text"
                value={launchObjective}
                onChange={(e) => setLaunchObjective(e.target.value)}
                placeholder="e.g., Coordinate relief allocation, route risk audit, and priority staging for coastal flood"
                className="rf-input w-full text-xs"
              />
            </div>
            <div className="md:col-span-2">
              <button
                type="submit"
                disabled={busy}
                className="rf-btn-primary w-full min-h-[42px] text-xs"
              >
                <Play className="w-3.5 h-3.5" />
                <span>{busy ? 'Running...' : 'Start Session'}</span>
              </button>
            </div>
          </form>

          {/* 8 Specialist Agents Status Grid */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                Registered Specialist Agents (Strict Read-Only Tool Allowlists)
              </div>
              <div className="text-[11px] font-mono text-slate-500">
                Provider: {analytics?.provider_health.primary_provider.toUpperCase() || 'NONE'} / Fallback:{' '}
                {analytics?.provider_health.fallback_provider.toUpperCase() || 'DETERMINISTIC'}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 dark:bg-slate-950/60 text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="px-4 py-2.5">Agent</th>
                    <th className="px-3 py-2.5">Phase</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5">Allowed Tools</th>
                    <th className="px-3 py-2.5 text-right">Runs / Failed</th>
                    <th className="px-3 py-2.5 text-right">Last Latency</th>
                    <th className="px-4 py-2.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {agents.map((ag) => (
                    <tr key={ag.agent_id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30">
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-slate-900 dark:text-white">{ag.name}</div>
                        <div className="text-[11px] text-slate-500">
                          {ag.agent_id} · v{ag.version}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                        {ag.phase}
                      </td>
                      <td className={`px-3 py-2.5 font-mono font-semibold text-[11px] ${statusTone(ag.runtime_status)}`}>
                        {ag.runtime_status}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[11px] text-slate-600 dark:text-slate-400 tabular-nums">
                        {ag.allowed_tools.length} read-only (max {ag.max_tool_calls} calls)
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                        {ag.total_runs} / {ag.failed_runs}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-600 dark:text-slate-400">
                        {ag.last_duration_ms != null ? `${ag.last_duration_ms}ms` : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          type="button"
                          disabled={!selectedSessionId || busy}
                          onClick={() => handleRerunAgent(ag.agent_id)}
                          className="text-[11px] font-medium text-cyan-600 dark:text-cyan-400 hover:underline disabled:opacity-40"
                        >
                          Rerun
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Sessions + Coordination Timeline */}
          <div className="grid lg:grid-cols-12 gap-5">
            <div className="lg:col-span-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                Coordination Sessions ({sessions.length})
              </div>
              {sessions.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500">
                  No coordination sessions recorded in {mode.toUpperCase()} mode yet. Start a session above to orchestrate all 8 agents.
                </div>
              ) : (
                <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-96 overflow-y-auto">
                  {sessions.map((s) => (
                    <button
                      key={s.session_id}
                      type="button"
                      onClick={() => setSelectedSessionId(s.session_id)}
                      className={`w-full text-left px-4 py-3 transition-colors ${
                        selectedSessionId === s.session_id
                          ? 'bg-cyan-50/70 dark:bg-cyan-950/30'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-mono font-semibold text-slate-900 dark:text-white">{s.session_id}</span>
                        <span className={`font-mono text-[11px] font-semibold ${statusTone(s.status)}`}>
                          {s.status} · {s.safety_status || 'UNVERIFIED'}
                        </span>
                      </div>
                      <div className="text-xs text-slate-700 dark:text-slate-300 mt-1 line-clamp-1">
                        {s.incident_title || s.objective}
                      </div>
                      <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 mt-1 tabular-nums">
                        <span>
                          {s.metrics.completed_agents} ok · {s.conflict_count} conflict(s) · {s.evidence_count} evidence
                        </span>
                        <span>{new Date(s.created_at).toLocaleTimeString()}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="lg:col-span-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                  Persisted Coordination Timeline
                </span>
                {bundle && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleReanalyze(bundle.session.session_id)}
                    className="text-[11px] font-medium text-cyan-600 dark:text-cyan-400 hover:underline"
                  >
                    Re-analyze Session
                  </button>
                )}
              </div>
              {!bundle || bundle.events.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500">
                  Select a coordination session to inspect real persisted orchestration events.
                </div>
              ) : (
                <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-96 overflow-y-auto">
                  {bundle.events.map((ev) => (
                    <div key={ev.event_id} className="px-4 py-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px] font-semibold text-cyan-700 dark:text-cyan-400">
                          {ev.event_type}
                        </span>
                        <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                          {new Date(ev.created_at).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="text-slate-700 dark:text-slate-300 mt-0.5">{ev.summary}</div>
                      <div className="text-[11px] text-slate-500 mt-0.5 font-mono">source: {ev.agent_id || 'orchestrator'}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* TAB 2: UNIFIED RESPONSE PLAN, AGENT COLLABORATION & CONFLICTS       */}
      {/* =================================================================== */}
      {tab === 'plan' && (
        <div className="space-y-5">
          {!bundle || !bundle.plan ? (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-10 text-center text-xs text-slate-500">
              No response plan selected. Start or select a coordination session from the Command tab to inspect the synthesized plan, safety verification, and agent collaboration breakdown.
            </div>
          ) : (
            <>
              {/* Plan Header + Safety Verdict */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-5 space-y-4">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 pb-3 border-b border-slate-200 dark:border-slate-800">
                  <div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-white">
                      {bundle.plan.title} (v{bundle.plan.version})
                    </div>
                    <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                      Plan ID: {bundle.plan.plan_id} · Status: {bundle.plan.status} · Expires:{' '}
                      {new Date(bundle.plan.expires_at).toLocaleString()} · HUMAN APPROVAL REQUIRED
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-xs font-semibold ${statusTone(bundle.plan.safety_validation.status)}`}>
                      SAFETY: {bundle.plan.safety_validation.status}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handlePlanDecision(bundle.plan!.plan_id, 'validate')}
                      className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      Revalidate
                    </button>
                  </div>
                </div>

                {bundle.plan.ai_synthesis_note && (
                  <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 text-xs text-slate-700 dark:text-slate-300">
                    {bundle.plan.ai_synthesis_note}
                  </div>
                )}

                <div className="grid md:grid-cols-2 gap-4 text-xs">
                  <div className="space-y-2">
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-white">Incident Summary</div>
                      <p className="text-slate-600 dark:text-slate-400 mt-0.5">{bundle.plan.incident_summary}</p>
                    </div>
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-white">Risk &amp; Environmental Posture</div>
                      <p className="text-slate-600 dark:text-slate-400 mt-0.5">{bundle.plan.risk_summary}</p>
                    </div>
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-white">Human Impact &amp; Priority</div>
                      <p className="text-slate-600 dark:text-slate-400 mt-0.5">{bundle.plan.human_impact_summary}</p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-white">Resource Strategy</div>
                      <p className="text-slate-600 dark:text-slate-400 mt-0.5">{bundle.plan.resource_strategy}</p>
                    </div>
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-white">Logistics &amp; Route Plan</div>
                      <p className="text-slate-600 dark:text-slate-400 mt-0.5">{bundle.plan.logistics_and_route_plan}</p>
                    </div>
                    {bundle.plan.missing_information.length > 0 && (
                      <div>
                        <div className="font-semibold text-amber-600 dark:text-amber-400">Missing Information</div>
                        <ul className="list-disc list-inside text-slate-600 dark:text-slate-400 mt-0.5">
                          {bundle.plan.missing_information.map((m, idx) => (
                            <li key={idx}>{m}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>

                {/* Deterministic Safety Checks Table */}
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
                    Deterministic Safety &amp; Evidence Verification Checks ({bundle.plan.safety_validation.checks.length})
                  </div>
                  <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg">
                    {bundle.plan.safety_validation.checks.map((chk, idx) => (
                      <div key={idx} className="px-3 py-2 flex items-center justify-between gap-3 text-xs">
                        <div className="flex items-center gap-2 min-w-0">
                          {chk.passed ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                          ) : (
                            <AlertTriangle className="w-3.5 h-3.5 text-red-500 shrink-0" />
                          )}
                          <span className="font-medium text-slate-900 dark:text-white">{chk.check_name}</span>
                          <span className="text-slate-500 truncate">— {chk.detail}</span>
                        </div>
                        <span className="font-mono text-[11px] uppercase text-slate-500 shrink-0">{chk.category}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Conflict Resolution Panel */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
                    <Scale className="w-4 h-4 text-amber-500" />
                    Cross-Agent Conflicts ({bundle.conflicts.length})
                  </div>
                </div>
                {bundle.conflicts.length === 0 ? (
                  <div className="text-xs text-slate-500">No cross-agent contradictions detected in this session.</div>
                ) : (
                  <div className="space-y-3">
                    {bundle.conflicts.map((c) => (
                      <div
                        key={c.conflict_id}
                        className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 space-y-2 text-xs"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold text-slate-900 dark:text-white">
                            {c.conflict_type} — {c.title}
                          </span>
                          <span className={`font-mono text-[11px] font-semibold ${statusTone(c.resolution_status)}`}>
                            {c.resolution_status}
                          </span>
                        </div>
                        <p className="text-slate-600 dark:text-slate-400">{c.description}</p>
                        <div className="text-[11px] text-slate-700 dark:text-slate-300">
                          <strong>Revalidated DB Fact:</strong> {c.revalidated_fact}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          <strong>Strategy:</strong> {c.resolution_strategy}
                        </div>
                        {(c.resolution_status === 'OPEN' || c.resolution_status === 'ESCALATED_HUMAN') ? (
                          <div className="flex gap-2 pt-1">
                            <input
                              type="text"
                              value={conflictNotes[c.conflict_id] || ''}
                              onChange={(e) =>
                                setConflictNotes((prev) => ({ ...prev, [c.conflict_id]: e.target.value }))
                              }
                              placeholder="Enter commander resolution decision..."
                              className="flex-1 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-900 dark:text-white"
                            />
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleResolveConflict(c.conflict_id)}
                              className="px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-cyan-600 text-white text-xs font-medium whitespace-nowrap"
                            >
                              Resolve Conflict
                            </button>
                          </div>
                        ) : (
                          <div className="text-[11px] text-emerald-600 dark:text-emerald-400 font-mono">
                            Resolved by {c.resolved_by}: {c.resolution_note}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Agent Collaboration Breakdown */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-5 space-y-3">
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                  Agent Collaboration Outputs ({bundle.results.length} Specialist Reports)
                </div>
                <div className="grid md:grid-cols-2 gap-3">
                  {bundle.results.map((r) => (
                    <div
                      key={r.result_id}
                      className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 space-y-2 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-semibold text-slate-900 dark:text-white">{r.agent_id}</span>
                        <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                          {r.execution_time_ms}ms · {r.data_freshness} · {r.tool_calls_used} tools
                        </span>
                      </div>
                      <p className="text-slate-700 dark:text-slate-300">{r.summary}</p>
                      {r.warnings.length > 0 && (
                        <div className="text-[11px] text-amber-600 dark:text-amber-400">
                          Warnings: {r.warnings.join(' | ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* =================================================================== */}
      {/* TAB 3: HUMAN APPROVAL & CONTROLLED EXECUTION CENTER                 */}
      {/* =================================================================== */}
      {tab === 'approvals' && (
        <div className="space-y-5">
          {approvals.length === 0 ? (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-10 text-center text-xs text-slate-500">
              No approval requests pending or archived in {mode.toUpperCase()} mode.
            </div>
          ) : (
            <div className="space-y-4">
              {approvals.map((appr) => {
                const isSelected = bundle?.plan?.plan_id === appr.plan_id;
                const actions = isSelected ? bundle.actions : [];
                return (
                  <div
                    key={appr.approval_id}
                    className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-5 space-y-3"
                  >
                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 pb-3 border-b border-slate-200 dark:border-slate-800">
                      <div>
                        <div className="text-sm font-semibold text-slate-900 dark:text-white">{appr.title}</div>
                        <div className="text-[11px] font-mono text-slate-500 mt-0.5 tabular-nums">
                          Approval {appr.approval_id} · Plan {appr.plan_id} · Impact: {appr.impact_level} · Safety:{' '}
                          <span className={statusTone(appr.safety_status)}>{appr.safety_status}</span>
                        </div>
                      </div>
                      <div className={`font-mono text-xs font-semibold ${statusTone(appr.status)}`}>{appr.status}</div>
                    </div>

                    {!isSelected ? (
                      <button
                        type="button"
                        onClick={() => setSelectedSessionId(appr.session_id)}
                        className="text-xs font-medium text-cyan-600 dark:text-cyan-400 hover:underline"
                      >
                        Load {appr.action_ids.length} proposed action(s) for commander review
                      </button>
                    ) : (
                      <div className="space-y-2">
                        {actions.map((act) => (
                          <div
                            key={act.action_id}
                            className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 text-xs"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-slate-900 dark:text-white">
                                [{act.priority.toUpperCase()}] {act.title}
                              </span>
                              <span className={`font-mono text-[11px] ${statusTone(act.status)}`}>
                                {act.action_type} · {act.status}
                              </span>
                            </div>
                            <p className="text-slate-600 dark:text-slate-400 mt-1">{act.description}</p>
                            <div className="text-[11px] text-slate-500 mt-1">Risk: {act.risk}</div>
                            {act.execution_result && (
                              <div className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400 mt-1">
                                Executed: {JSON.stringify(act.execution_result)}
                              </div>
                            )}
                            {act.execution_error && (
                              <div className="text-[11px] font-mono text-red-600 dark:text-red-400 mt-1">
                                Blocked: {act.execution_error}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="grid md:grid-cols-2 gap-3 pt-2">
                      <input
                        type="text"
                        value={decisionNote}
                        onChange={(e) => setDecisionNote(e.target.value)}
                        placeholder="Commander approval/rejection/deferral note..."
                        className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-900 dark:text-white"
                      />
                      <div className="flex flex-wrap gap-2 justify-end text-xs">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handlePlanDecision(appr.plan_id, 'validate')}
                          className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 font-medium"
                        >
                          Validate
                        </button>
                        {(appr.status === 'PENDING' || appr.status === 'MODIFIED' || appr.status === 'DEFERRED') && (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handlePlanDecision(appr.plan_id, 'approve')}
                              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
                            >
                              Approve Plan
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handlePlanDecision(appr.plan_id, 'defer')}
                              className="px-3 py-1.5 rounded-lg border border-amber-400 text-amber-700 dark:text-amber-300 font-medium"
                            >
                              Defer
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handlePlanDecision(appr.plan_id, 'reject')}
                              className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white font-medium"
                            >
                              Reject
                            </button>
                          </>
                        )}
                        {appr.status === 'APPROVED' && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handlePlanDecision(appr.plan_id, 'execute')}
                            className="px-3.5 py-1.5 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-semibold"
                          >
                            Revalidate &amp; Execute Approved Actions
                          </button>
                        )}
                      </div>
                    </div>

                    {(appr.status === 'PENDING' || appr.status === 'MODIFIED') && (
                      <div className="flex gap-2 pt-1">
                        <input
                          type="text"
                          value={modNotes}
                          onChange={(e) => setModNotes(e.target.value)}
                          placeholder="Modify plan parameters / commander guidance notes..."
                          className="flex-1 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-900 dark:text-white"
                        />
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleModifyPlan(appr.plan_id)}
                          className="px-3 py-1.5 rounded-lg border border-cyan-500 text-cyan-700 dark:text-cyan-300 text-xs font-medium whitespace-nowrap"
                        >
                          Record Modification
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Approval Audit History */}
          {approvalEvents.length > 0 && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-4 space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Approval Audit Trail ({approvalEvents.length})
              </div>
              <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-56 overflow-y-auto text-xs">
                {approvalEvents.map((ae) => (
                  <div key={ae.event_id} className="py-2 flex items-center justify-between gap-2">
                    <div>
                      <span className={`font-mono font-semibold ${statusTone(ae.decision)}`}>{ae.decision}</span> ·{' '}
                      <span className="text-slate-800 dark:text-slate-200">{ae.actor_name}</span> ({ae.actor_role}) —{' '}
                      <span className="text-slate-500">{ae.note}</span>
                    </div>
                    <span className="font-mono text-[11px] text-slate-500 tabular-nums shrink-0">
                      {new Date(ae.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* =================================================================== */}
      {/* TAB 4: EVIDENCE EXPLORER                                            */}
      {/* =================================================================== */}
      {tab === 'evidence' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                value={evSearch}
                onChange={(e) => setEvSearch(e.target.value)}
                placeholder="Search claims, source IDs, agents..."
                className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-900 dark:text-white"
              />
            </div>
            <select
              value={evClassFilter}
              onChange={(e) => setEvClassFilter(e.target.value)}
              className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-900 dark:text-white"
            >
              <option value="all">All Classifications</option>
              {CLAIM_CLASSIFICATIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 overflow-hidden">
            {filteredEvidence.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                No evidence records match the current filter. Run a coordination session to capture grounded evidence.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-50 dark:bg-slate-950/60 text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th className="px-4 py-2.5">Classification</th>
                      <th className="px-3 py-2.5">Source</th>
                      <th className="px-3 py-2.5">Claim</th>
                      <th className="px-3 py-2.5">Freshness</th>
                      <th className="px-4 py-2.5 text-right">Observed</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {filteredEvidence.slice(0, 80).map((ev) => (
                      <tr key={ev.evidence_id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30">
                        <td className="px-4 py-2.5 font-mono text-[11px] font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">
                          {ev.claim_classification}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                          <div>{ev.source_type}</div>
                          <div className="text-[10px] text-slate-500">{ev.source_id.slice(0, 20)}</div>
                        </td>
                        <td className="px-3 py-2.5 text-slate-700 dark:text-slate-300 max-w-md">{ev.claim}</td>
                        <td className="px-3 py-2.5 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                          {ev.source_status}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-[11px] text-slate-500 tabular-nums whitespace-nowrap">
                          {ev.observed_at ? new Date(ev.observed_at).toLocaleTimeString() : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* TAB 5: ISOLATED SCENARIO SIMULATION STUDIO                          */}
      {/* =================================================================== */}
      {tab === 'simulations' && (
        <div className="space-y-5">
          <div className="px-4 py-2.5 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-xs font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-2">
            <FlaskConical className="w-4 h-4 shrink-0" />
            SIMULATION — NOT A LIVE EMERGENCY. All scenarios run on deep-cloned isolated snapshots with guaranteed zero mutation of live incidents, inventory, or dispatches.
          </div>

          <form
            onSubmit={handleCreateAndRunSimulation}
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-4 grid md:grid-cols-12 gap-3 items-end text-xs"
          >
            <div className="md:col-span-3">
              <label className="block text-[11px] uppercase text-slate-500 mb-1">Scenario Type (11 Supported)</label>
              <select
                value={simType}
                onChange={(e) => setSimType(e.target.value as AISimulationType)}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
              >
                {SIMULATION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="md:col-span-3">
              <label className="block text-[11px] uppercase text-slate-500 mb-1">Scenario Title</label>
              <input
                type="text"
                value={simTitle}
                onChange={(e) => setSimTitle(e.target.value)}
                placeholder="e.g., Coastal depot closure stress test"
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-[11px] uppercase text-slate-500 mb-1">Magnitude / Value</label>
              <input
                type="number"
                min={1}
                max={5000}
                value={simParamValue}
                onChange={(e) => setSimParamValue(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono text-slate-900 dark:text-white"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-[11px] uppercase text-slate-500 mb-1">Focus Incident</label>
              <select
                value={simIncidentId}
                onChange={(e) => setSimIncidentId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
              >
                <option value="">Default Active</option>
                {incidents.map((inc) => (
                  <option key={inc.id} value={inc.id}>
                    {inc.title.slice(0, 32)}
                  </option>
                ))}
              </select>
            </div>
            <div className="md:col-span-2">
              <button
                type="submit"
                disabled={busy}
                className="w-full px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-medium whitespace-nowrap"
              >
                Run Simulation
              </button>
            </div>
          </form>

          {simulations.length >= 2 && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500">
                Check 2+ simulations below to run side-by-side impact comparison ({compareIds.length} selected).
              </span>
              <button
                type="button"
                disabled={compareIds.length < 2 || busy}
                onClick={handleCompareSimulations}
                className="px-3 py-1.5 rounded-lg border border-cyan-500 text-cyan-700 dark:text-cyan-300 font-medium disabled:opacity-40"
              >
                Compare Selected ({compareIds.length})
              </button>
            </div>
          )}

          {compareReport && (
            <div className="rounded-xl border border-cyan-500/40 bg-white dark:bg-slate-900/80 p-4 space-y-2 text-xs">
              <div className="font-semibold text-cyan-700 dark:text-cyan-300">
                {compareReport.label} — Comparison ({compareReport.compared_count} Scenarios)
              </div>
              <div className="font-mono text-[11px] text-slate-600 dark:text-slate-400">
                Highest Risk Impact: {compareReport.highest_risk_impact || 'N/A'} · Highest Shortage Impact:{' '}
                {compareReport.highest_shortage_impact || 'N/A'}
              </div>
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-4">
            {simulations.length === 0 ? (
              <div className="md:col-span-2 rounded-xl border border-slate-200 dark:border-slate-800 p-8 text-center text-xs text-slate-500">
                No simulations run yet. Select a disruption scenario above to evaluate projected risk, shortages, and ETA deltas without modifying live data.
              </div>
            ) : (
              simulations.map((s) => {
                const res = simResults.find((r) => r.simulation_id === s.simulation_id);
                const checked = compareIds.includes(s.simulation_id);
                return (
                  <div
                    key={s.simulation_id}
                    className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-4 space-y-3 text-xs"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setCompareIds((prev) =>
                              checked ? prev.filter((id) => id !== s.simulation_id) : [...prev, s.simulation_id]
                            )
                          }
                        />
                        <div>
                          <div className="font-semibold text-slate-900 dark:text-white">{s.title}</div>
                          <div className="text-[11px] font-mono text-amber-600 dark:text-amber-400">{s.label}</div>
                        </div>
                      </label>
                      <span className="font-mono text-[11px] text-slate-500">{s.scenario_type}</span>
                    </div>

                    {res && (
                      <>
                        <div className="grid grid-cols-4 gap-2 text-center font-mono tabular-nums bg-slate-50 dark:bg-slate-950/60 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800">
                          <div>
                            <div className="text-[10px] text-slate-500">RISK Δ</div>
                            <div className="font-semibold text-slate-900 dark:text-white">
                              {res.deltas.risk_score_delta >= 0 ? '+' : ''}
                              {res.deltas.risk_score_delta}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-slate-500">SHORTAGE Δ</div>
                            <div className="font-semibold text-slate-900 dark:text-white">
                              {res.deltas.shortage_delta >= 0 ? '+' : ''}
                              {res.deltas.shortage_delta}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-slate-500">FULFILL Δ</div>
                            <div className="font-semibold text-slate-900 dark:text-white">
                              {res.deltas.fulfillment_pct_delta}%
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-slate-500">ETA Δ</div>
                            <div className="font-semibold text-slate-900 dark:text-white">
                              +{res.deltas.delivery_delay_min_delta}m
                            </div>
                          </div>
                        </div>
                        <div className="space-y-1 text-slate-600 dark:text-slate-400">
                          {[...res.risk_escalation_notes, ...res.supply_impact_notes, ...res.route_and_fleet_notes].map(
                            (n, i) => (
                              <div key={i}>• {n}</div>
                            )
                          )}
                        </div>
                        {res.recommended_contingencies.length > 0 && (
                          <div className="text-[11px] text-cyan-700 dark:text-cyan-400">
                            <strong>Contingency:</strong> {res.recommended_contingencies.join(' ')}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* TAB 6: PROACTIVE TRIGGERS, SESSION MEMORY & REAL AI ANALYTICS       */}
      {/* =================================================================== */}
      {tab === 'monitoring' && (
        <div className="space-y-5">
          {/* Proactive Triggers */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-4 space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
              Proactive Monitoring Triggers ({triggers.length})
            </div>
            {triggers.length === 0 ? (
              <div className="text-xs text-slate-500">
                No proactive triggers fired in {mode.toUpperCase()} mode. Triggers fire deterministically on high-risk crossings, critical shortages, warehouse closures, or route hazards with cooldown deduplication.
              </div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-800">
                {triggers.map((t) => (
                  <div key={t.trigger_id} className="py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-white">
                        [{t.severity.toUpperCase()}] {t.title}
                      </div>
                      <div className="text-slate-500">
                        {t.reason} · Suggested: {t.recommended_action}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`font-mono text-[11px] ${statusTone(t.status)}`}>{t.status}</span>
                      {t.status === 'ACTIVE' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleAckTrigger(t.trigger_id)}
                          className="px-2.5 py-1 rounded-lg border border-slate-300 dark:border-slate-700 text-[11px] font-medium"
                        >
                          Acknowledge
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Scoped Session Coordination Memory */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-4 space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
              Scoped Coordination Memory ({bundle?.memory.length || 0} entries for selected session)
            </div>
            {selectedSessionId && (
              <form onSubmit={handleAddMemory} className="grid md:grid-cols-12 gap-2 text-xs">
                <select
                  value={memType}
                  onChange={(e) => setMemType(e.target.value as AISessionMemory['memory_type'])}
                  className="md:col-span-3 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                >
                  <option value="human_decision">Human Decision (VERIFIED FACT)</option>
                  <option value="verified_incident_history">Verified Incident History</option>
                  <option value="session_context">Session Context</option>
                  <option value="ai_conclusion">AI Conclusion (AI INTERPRETATION)</option>
                </select>
                <input
                  required
                  value={memTitle}
                  onChange={(e) => setMemTitle(e.target.value)}
                  placeholder="Memory title..."
                  className="md:col-span-3 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                />
                <input
                  required
                  value={memContent}
                  onChange={(e) => setMemContent(e.target.value)}
                  placeholder="Verified fact or commander decision note..."
                  className="md:col-span-4 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="md:col-span-2 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-cyan-600 text-white font-medium"
                >
                  Store Memory
                </button>
              </form>
            )}
            {!bundle || bundle.memory.length === 0 ? (
              <div className="text-xs text-slate-500">Select a coordination session to inspect or append scoped memory.</div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {bundle.memory.map((m) => (
                  <div key={m.memory_id} className="py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900 dark:text-white">{m.title}</span>
                      <span className="font-mono text-[11px] text-slate-500">
                        {m.memory_type} · {m.classification} · v{m.version}
                      </span>
                    </div>
                    <p className="text-slate-600 dark:text-slate-400 mt-0.5">{m.content}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Real AI Analytics */}
          {analytics && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-4 space-y-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                Real Coordination Analytics (Computed from Persisted Sessions)
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono tabular-nums">
                <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800">
                  <div className="text-[10px] text-slate-500">AVG SESSION DURATION</div>
                  <div className="text-base font-semibold text-slate-900 dark:text-white mt-0.5">
                    {analytics.avg_session_duration_ms != null ? `${analytics.avg_session_duration_ms}ms` : '—'}
                  </div>
                </div>
                <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800">
                  <div className="text-[10px] text-slate-500">PLAN APPROVAL RATE</div>
                  <div className="text-base font-semibold text-slate-900 dark:text-white mt-0.5">
                    {analytics.approval_rate_pct != null ? `${analytics.approval_rate_pct}%` : '—'}
                  </div>
                </div>
                <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800">
                  <div className="text-[10px] text-slate-500">SAFETY REJECTIONS / WARNINGS</div>
                  <div className="text-base font-semibold text-slate-900 dark:text-white mt-0.5">
                    {analytics.safety_rejections} / {analytics.safety_warnings}
                  </div>
                </div>
                <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800">
                  <div className="text-[10px] text-slate-500">ESTIMATED AI TOKENS</div>
                  <div className="text-base font-semibold text-slate-900 dark:text-white mt-0.5">
                    {analytics.tokens_estimated_total}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
