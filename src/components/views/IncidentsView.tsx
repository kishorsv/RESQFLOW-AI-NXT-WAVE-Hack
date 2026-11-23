import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Bot,
  CheckCircle2,
  CloudRain,
  Copy,
  Edit3,
  FilePlus2,
  Flame,
  Gauge,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  ShieldX,
  TrendingUp,
  X,
} from 'lucide-react';
import { apiRequest } from '../../lib/api';
import type {
  AICoordinationSession,
  AIRiskBriefing,
  AlertRecord,
  DataMode,
  DuplicateMatch,
  Incident,
  IncidentReportRecord,
  IncidentStatus,
  IncidentType,
  RiskAssessment,
  Severity,
  WeatherObservation,
} from '../../shared/types';

interface IncidentsViewProps {
  mode: DataMode;
  incidents: Incident[];
  onRefresh: () => void;
  onOpenAICommand?: (sessionId?: string) => void;
}

interface IncidentDetailBundle {
  incident: Incident;
  latestRisk: RiskAssessment | null;
  riskHistory: RiskAssessment[];
  latestWeather: WeatherObservation | null;
  reports: IncidentReportRecord[];
  alerts: AlertRecord[];
  aiBriefings: AIRiskBriefing[];
  duplicateMatches: DuplicateMatch[];
}

const INCIDENT_TYPES: IncidentType[] = [
  'flash_flood',
  'flood',
  'landslide',
  'cyclone',
  'severe_storm',
  'heatwave',
  'wildfire',
  'earthquake',
  'infrastructure_failure',
  'water_shortage',
  'power_failure',
  'chemical_incident',
  'other',
];

export const IncidentsView: React.FC<IncidentsViewProps> = ({ mode, incidents, onRefresh, onOpenAICommand }) => {
  const [search, setSearch] = useState('');
  const [sevFilter, setSevFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [verificationFilter, setVerificationFilter] = useState<string>('all');
  const [selectedId, setSelectedId] = useState<string | null>(incidents[0]?.id || null);
  const [detail, setDetail] = useState<IncidentDetailBundle | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showRejectBox, setShowRejectBox] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const [busyId, setBusyId] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [coordBusy, setCoordBusy] = useState(false);
  const [coordSessions, setCoordSessions] = useState<AICoordinationSession[]>([]);
  const [weatherBusy, setWeatherBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [noteText, setNoteText] = useState('');
  const [reportForm, setReportForm] = useState({
    sourceType: 'field_responder' as IncidentReportRecord['sourceType'],
    summary: '',
    peopleAffectedUpdate: '',
    vulnerablePopulationUpdate: '',
  });

  const [form, setForm] = useState({
    title: '',
    description: '',
    type: 'flash_flood' as IncidentType,
    severity: 'high' as Severity,
    severityLevel: 4 as 1 | 2 | 3 | 4 | 5,
    sourceType: 'command_desk' as IncidentReportRecord['sourceType'],
    lat: 12.9716,
    lng: 80.2206,
    address: '',
    region: 'Tamil Nadu Coastal',
    peopleAffected: 350,
    familiesAffected: 90,
    vulnerablePopulation: 80,
    estimatedImpactAreaKm2: 4.5,
    infrastructureText: 'Power Substation, Coastal Road',
    assignedTeam: 'Rapid Assessment Unit 1',
  });

  const [editForm, setEditForm] = useState({
    title: '',
    severity: 'medium' as Severity,
    address: '',
    region: '',
    peopleAffected: 0,
    vulnerablePopulation: 0,
    estimatedImpactAreaKm2: 1,
    note: '',
  });

  const filtered = incidents.filter((inc) => {
    if (sevFilter !== 'all' && inc.severity !== sevFilter) return false;
    if (typeFilter !== 'all' && inc.type !== typeFilter) return false;
    if (statusFilter !== 'all' && inc.status !== statusFilter) return false;
    if (verificationFilter !== 'all' && inc.verificationStatus !== verificationFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        inc.title.toLowerCase().includes(q) ||
        inc.region.toLowerCase().includes(q) ||
        inc.address.toLowerCase().includes(q) ||
        inc.type.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const selected = incidents.find((i) => i.id === selectedId) || filtered[0] || null;

  const fetchDetail = useCallback(async (id: string) => {
    setLoadingDetail(true);
    try {
      const [bundle, sesRes] = await Promise.all([
        apiRequest<IncidentDetailBundle>(`/incidents/${id}`),
        apiRequest<{ sessions: AICoordinationSession[] }>(`/ai/coordination/sessions?mode=${mode}&incidentId=${id}`),
      ]);
      setDetail(bundle);
      setCoordSessions(sesRes.sessions || []);
    } catch {
      setDetail(null);
      setCoordSessions([]);
    } finally {
      setLoadingDetail(false);
    }
  }, [mode]);

  const startIncidentCoordination = async () => {
    if (!selected) return;
    setCoordBusy(true);
    setFeedback(null);
    try {
      const out = await apiRequest<{ session: AICoordinationSession }>('/ai/coordination/start', {
        method: 'POST',
        body: {
          incidentId: selected.id,
          mode,
          triggerSource: 'incident_panel',
          waitForCompletion: true,
        },
      });
      setFeedback({
        type: 'ok',
        text: `Multi-agent coordination session ${out.session.session_id} completed (${out.session.safety_status || out.session.status}).`,
      });
      await fetchDetail(selected.id);
      onRefresh();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Failed to start AI coordination',
      });
    } finally {
      setCoordBusy(false);
    }
  };

  useEffect(() => {
    if (selected?.id) {
      fetchDetail(selected.id);
    } else {
      setDetail(null);
      setCoordSessions([]);
    }
  }, [selected?.id, selected?.updatedAt, fetchDetail]);

  const openEditModal = () => {
    if (!selected) return;
    setEditForm({
      title: selected.title,
      severity: selected.severity,
      address: selected.address,
      region: selected.region,
      peopleAffected: selected.peopleAffected,
      vulnerablePopulation: selected.vulnerablePopulation,
      estimatedImpactAreaKm2: selected.estimatedImpactAreaKm2,
      note: '',
    });
    setShowEdit(true);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyId('create');
    setFeedback(null);
    try {
      const infrastructureAffected = form.infrastructureText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await apiRequest<{
        incident: Incident;
        possibleDuplicates: string[];
        duplicateMatches?: DuplicateMatch[];
        coordinateWarnings?: string[];
      }>('/incidents', {
        method: 'POST',
        body: {
          title: form.title,
          description: form.description,
          type: form.type,
          severity: form.severity,
          severityLevel: form.severityLevel,
          sourceType: form.sourceType,
          lat: form.lat,
          lng: form.lng,
          address: form.address,
          region: form.region,
          peopleAffected: form.peopleAffected,
          familiesAffected: form.familiesAffected,
          vulnerablePopulation: form.vulnerablePopulation,
          estimatedImpactAreaKm2: form.estimatedImpactAreaKm2,
          infrastructureAffected,
          assignedTeam: form.assignedTeam,
          mode,
        },
      });
      setShowCreate(false);
      setSelectedId(res.incident.id);
      const dupCount = res.duplicateMatches?.length ?? res.possibleDuplicates.length;
      const warnSuffix =
        res.coordinateWarnings && res.coordinateWarnings.length > 0
          ? ` Coordinate warning: ${res.coordinateWarnings[0]}`
          : '';
      setFeedback({
        type: 'ok',
        text:
          dupCount > 0
            ? `Incident created & queued for automatic risk reassessment. Flagged ${dupCount} possible duplicate(s).${warnSuffix}`
            : `Incident created, broadcast to live stream, and scheduled for automatic risk reassessment.${warnSuffix}`,
      });
      setForm({
        title: '',
        description: '',
        type: 'flash_flood',
        severity: 'high',
        severityLevel: 4,
        sourceType: 'command_desk',
        lat: 12.9716,
        lng: 80.2206,
        address: '',
        region: 'Tamil Nadu Coastal',
        peopleAffected: 350,
        familiesAffected: 90,
        vulnerablePopulation: 80,
        estimatedImpactAreaKm2: 4.5,
        infrastructureText: 'Power Substation, Coastal Road',
        assignedTeam: 'Rapid Assessment Unit 1',
      });
      onRefresh();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Failed to create incident' });
    } finally {
      setBusyId(null);
    }
  };

  const handlePatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setBusyId(selected.id);
    setFeedback(null);
    try {
      await apiRequest(`/incidents/${selected.id}`, {
        method: 'PATCH',
        body: {
          title: editForm.title,
          severity: editForm.severity,
          address: editForm.address,
          region: editForm.region,
          peopleAffected: editForm.peopleAffected,
          vulnerablePopulation: editForm.vulnerablePopulation,
          estimatedImpactAreaKm2: editForm.estimatedImpactAreaKm2,
          note: editForm.note || undefined,
        },
      });
      setShowEdit(false);
      setFeedback({
        type: 'ok',
        text: 'Incident updated and automatic risk reassessment triggered.',
      });
      onRefresh();
      await fetchDetail(selected.id);
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Update failed' });
    } finally {
      setBusyId(null);
    }
  };

  const runAction = async (incId: string, path: string, body: Record<string, unknown>, okText: string) => {
    setBusyId(incId);
    setFeedback(null);
    try {
      await apiRequest(path, { method: 'POST', body });
      setFeedback({ type: 'ok', text: okText });
      onRefresh();
      await fetchDetail(incId);
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Action failed' });
    } finally {
      setBusyId(null);
    }
  };

  const handleForceWeatherRefresh = async () => {
    if (!selected) return;
    setWeatherBusy(true);
    setFeedback(null);
    try {
      await apiRequest(`/weather/refresh/${selected.id}`, { method: 'POST', body: {} });
      setFeedback({ type: 'ok', text: 'Live Open-Meteo telemetry refreshed and incident risk reassessed.' });
      onRefresh();
      await fetchDetail(selected.id);
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Weather refresh failed' });
    } finally {
      setWeatherBusy(false);
    }
  };

  const handleGenerateBriefing = async () => {
    if (!selected) return;
    setAiBusy(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ briefing: AIRiskBriefing }>(`/incidents/${selected.id}/risk-explanation`, {
        method: 'POST',
        body: {},
      });
      setFeedback({
        type: 'ok',
        text: `Grounded AI Risk Briefing generated (${res.briefing.model}). Human review required before acting.`,
      });
      await fetchDetail(selected.id);
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'AI Risk Briefing unavailable',
      });
    } finally {
      setAiBusy(false);
    }
  };

  const addNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !noteText.trim()) return;
    await runAction(selected.id, `/incidents/${selected.id}/notes`, { text: noteText }, 'Field note appended.');
    setNoteText('');
  };

  const attachReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !reportForm.summary.trim()) return;
    const payload: Record<string, unknown> = {
      sourceType: reportForm.sourceType,
      summary: reportForm.summary.trim(),
    };
    if (reportForm.peopleAffectedUpdate.trim() !== '') {
      payload.peopleAffectedUpdate = Number(reportForm.peopleAffectedUpdate);
    }
    if (reportForm.vulnerablePopulationUpdate.trim() !== '') {
      payload.vulnerablePopulationUpdate = Number(reportForm.vulnerablePopulationUpdate);
    }
    await runAction(
      selected.id,
      `/incidents/${selected.id}/reports`,
      payload,
      'Field report attached and automatic risk reassessment triggered.'
    );
    setReportForm({
      sourceType: 'field_responder',
      summary: '',
      peopleAffectedUpdate: '',
      vulnerablePopulationUpdate: '',
    });
  };

  const latestRisk = detail?.latestRisk || null;
  const latestBriefing = detail?.aiBriefings?.[0] || null;
  const latestWeather = detail?.latestWeather || null;
  const duplicateMatches = detail?.duplicateMatches || selected?.duplicateMatches || [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">
            Incident Intake, Lifecycle &amp; Intelligence Workspace
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Transition-guarded workflows, structured duplicate matching, deterministic risk v2.0, field reports &amp; grounded AI risk briefings
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-sm font-medium"
        >
          <Plus className="w-4 h-4" />
          Report New Incident
        </button>
      </div>

      {feedback && (
        <div
          className={`px-4 py-2.5 rounded-lg border text-xs flex items-center justify-between ${
            feedback.type === 'ok'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300'
          }`}
        >
          <span>{feedback.text}</span>
          <button type="button" onClick={() => setFeedback(null)}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Multi-Facet Filter Bar */}
      <div className="flex flex-wrap items-center gap-2.5 text-xs">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by title, region, address, or hazard..."
            className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200"
        >
          <option value="all">All Types</option>
          {INCIDENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200"
        >
          <option value="all">All Statuses</option>
          {['reported', 'under_review', 'verified', 'active', 'escalated', 'contained', 'resolved', 'archived'].map((st) => (
            <option key={st} value={st}>
              {st.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        <select
          value={verificationFilter}
          onChange={(e) => setVerificationFilter(e.target.value)}
          className="px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200"
        >
          <option value="all">All Verification</option>
          {['verified', 'unverified', 'pending', 'rejected'].map((v) => (
            <option key={v} value={v}>
              {v.toUpperCase()}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          {['all', 'critical', 'high', 'medium', 'low'].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSevFilter(s)}
              className={`px-2.5 py-1.5 rounded-lg border capitalize font-medium ${
                sevFilter === s
                  ? 'border-[#5869E8]/50 dark:border-[#6D7CFF]/55 bg-[#5869E8]/10 dark:bg-[#6D7CFF]/16 text-[#5869E8] dark:text-[#A5B0FF]'
                  : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="grid lg:grid-cols-5 gap-5">
        {/* Incident List */}
        <div className="lg:col-span-2 space-y-2.5 max-h-[760px] overflow-y-auto pr-1">
          {filtered.map((inc) => (
            <button
              key={inc.id}
              type="button"
              onClick={() => {
                setSelectedId(inc.id);
                setShowRejectBox(false);
              }}
              className={`w-full text-left rounded-xl border p-4 transition-colors space-y-1.5 ${
                selected?.id === inc.id
                  ? 'border-cyan-500 bg-cyan-500/5 dark:bg-cyan-950/20'
                  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 hover:border-slate-400 dark:hover:border-slate-700'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="text-sm font-semibold text-slate-900 dark:text-white leading-snug">
                  {inc.title}
                </div>
                <span
                  className={`text-[11px] font-mono uppercase shrink-0 ${
                    inc.severity === 'critical'
                      ? 'text-red-500'
                      : inc.severity === 'high'
                      ? 'text-orange-500'
                      : 'text-amber-500'
                  }`}
                >
                  {inc.severity} (L{inc.severityLevel ?? 3})
                </span>
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {inc.type.replace(/_/g, ' ')} · {inc.status.replace(/_/g, ' ')} · {inc.verificationStatus.toUpperCase()}
              </div>
              <div className="flex items-center justify-between text-xs font-mono text-slate-500 tabular-nums">
                <span>{inc.peopleAffected.toLocaleString()} affected</span>
                <span>
                  Risk {inc.riskScore !== null ? `${inc.riskScore}/100` : 'Unscored'}
                  {inc.riskBand ? ` (${inc.riskBand})` : ''}
                </span>
              </div>
              {inc.possibleDuplicateOf && inc.possibleDuplicateOf.length > 0 && (
                <div className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1 pt-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {inc.possibleDuplicateOf.length} possible duplicate match(es)
                </div>
              )}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-8 text-center text-sm text-slate-500">
              No incidents match current filters in {mode.toUpperCase()} mode.
            </div>
          )}
        </div>

        {/* Incident Detail Workspace */}
        <div className="lg:col-span-3">
          {selected ? (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5 space-y-5">
              {/* Header & Lifecycle Actions */}
              <div className="space-y-3 border-b border-slate-200 dark:border-slate-800 pb-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1">
                    <div className="text-xs font-mono text-slate-500">
                      ID {selected.id.slice(0, 12)} · {selected.verificationStatus.toUpperCase()} ·{' '}
                      {selected.status.toUpperCase()} · L{selected.severityLevel ?? 3}
                    </div>
                    <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{selected.title}</h2>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {selected.address}, {selected.region} ({selected.lat.toFixed(4)}, {selected.lng.toFixed(4)}) · Reported by{' '}
                      {selected.reporter}
                    </div>
                  </div>
                  {loadingDetail && <RefreshCw className="w-4 h-4 text-cyan-500 animate-spin shrink-0" />}
                </div>

                {selected.coordinateWarnings && selected.coordinateWarnings.length > 0 && (
                  <div className="p-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-xs text-amber-700 dark:text-amber-300 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    {selected.coordinateWarnings.join(' ')}
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  {selected.verificationStatus !== 'verified' && (
                    <button
                      type="button"
                      disabled={busyId === selected.id}
                      onClick={() =>
                        runAction(selected.id, `/incidents/${selected.id}/verify`, {}, 'Incident verified by commander.')
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      Verify
                    </button>
                  )}
                  {selected.verificationStatus !== 'rejected' && selected.status !== 'archived' && (
                    <button
                      type="button"
                      disabled={busyId === selected.id}
                      onClick={() => setShowRejectBox((v) => !v)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/40 text-red-600 dark:text-red-400 hover:bg-red-500/10 text-xs font-medium"
                    >
                      <ShieldX className="w-3.5 h-3.5" />
                      Reject
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busyId === selected.id}
                    onClick={openEditModal}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-cyan-500 text-xs font-medium"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busyId === selected.id}
                    onClick={() =>
                      runAction(
                        selected.id,
                        `/incidents/${selected.id}/assess`,
                        { forceWeatherRefresh: false },
                        'Deterministic Risk v2.0 & live weather assessment completed.'
                      )
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium"
                  >
                    <Gauge className="w-3.5 h-3.5" />
                    Assess Risk
                  </button>
                  <button
                    type="button"
                    disabled={aiBusy}
                    onClick={handleGenerateBriefing}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium disabled:opacity-60"
                  >
                    <Bot className="w-3.5 h-3.5" />
                    {aiBusy ? 'Generating Briefing...' : 'AI Risk Briefing'}
                  </button>
                  {selected.status !== 'escalated' && selected.status !== 'resolved' && selected.status !== 'archived' && (
                    <button
                      type="button"
                      disabled={busyId === selected.id}
                      onClick={() =>
                        runAction(
                          selected.id,
                          `/incidents/${selected.id}/escalate`,
                          { reason: 'Escalated from Incident Command Console' },
                          'Incident escalated to CRITICAL and reassessed.'
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-medium"
                    >
                      <Flame className="w-3.5 h-3.5" />
                      Escalate
                    </button>
                  )}
                  {selected.status !== 'resolved' && selected.status !== 'archived' && (
                    <button
                      type="button"
                      disabled={busyId === selected.id}
                      onClick={() =>
                        runAction(
                          selected.id,
                          `/incidents/${selected.id}/resolve`,
                          { note: 'Resolved via Incident Console' },
                          'Incident marked RESOLVED.'
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-500/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 text-xs font-medium"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Resolve
                    </button>
                  )}
                  {(selected.status === 'resolved' || selected.status === 'contained') && (
                    <button
                      type="button"
                      disabled={busyId === selected.id}
                      onClick={() =>
                        runAction(
                          selected.id,
                          `/incidents/${selected.id}/reopen`,
                          { reason: 'Reopened for ongoing field monitoring' },
                          'Incident reopened to ACTIVE.'
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-500/40 text-amber-700 dark:text-amber-300 hover:bg-amber-500/10 text-xs font-medium"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Reopen
                    </button>
                  )}
                  {selected.status !== 'archived' && (
                    <button
                      type="button"
                      disabled={busyId === selected.id}
                      onClick={() =>
                        runAction(
                          selected.id,
                          `/incidents/${selected.id}/archive`,
                          { note: 'Archived via Incident Console' },
                          'Incident archived.'
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-500 text-xs font-medium"
                    >
                      <Archive className="w-3.5 h-3.5" />
                      Archive
                    </button>
                  )}
                  <select
                    value={selected.status}
                    onChange={(e) =>
                      runAction(
                        selected.id,
                        `/incidents/${selected.id}/status`,
                        { status: e.target.value as IncidentStatus },
                        `Incident status updated to ${e.target.value}.`
                      )
                    }
                    className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-800 dark:text-slate-200"
                  >
                    {['reported', 'under_review', 'verified', 'active', 'escalated', 'contained', 'resolved', 'archived'].map(
                      (st) => (
                        <option key={st} value={st}>
                          Status: {st}
                        </option>
                      )
                    )}
                  </select>
                </div>

                {showRejectBox && (
                  <div className="flex gap-2 pt-1">
                    <input
                      type="text"
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="Enter mandatory rejection rationale (e.g., duplicate report / false alarm)..."
                      className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-red-400/50 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                    />
                    <button
                      type="button"
                      disabled={!rejectReason.trim() || busyId === selected.id}
                      onClick={async () => {
                        await runAction(
                          selected.id,
                          `/incidents/${selected.id}/reject`,
                          { reason: rejectReason.trim() },
                          'Incident rejected with recorded rationale.'
                        );
                        setRejectReason('');
                        setShowRejectBox(false);
                      }}
                      className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-medium disabled:opacity-50"
                    >
                      Confirm Reject
                    </button>
                  </div>
                )}
              </div>

              <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">{selected.description}</p>

              {/* Metrics Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs tabular-nums">
                <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                  <div className="text-slate-500">People Affected</div>
                  <div className="text-base font-semibold text-slate-900 dark:text-white mt-0.5">
                    {selected.peopleAffected.toLocaleString()}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                  <div className="text-slate-500">Vulnerable Pop.</div>
                  <div className="text-base font-semibold text-slate-900 dark:text-white mt-0.5">
                    {selected.vulnerablePopulation.toLocaleString()}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                  <div className="text-slate-500">Risk Score</div>
                  <div className="text-base font-semibold text-cyan-600 dark:text-cyan-400 mt-0.5">
                    {latestRisk
                      ? latestRisk.overallScore !== null
                        ? `${latestRisk.overallScore}/100`
                        : 'INSUFFICIENT DATA'
                      : selected.riskScore !== null
                      ? `${selected.riskScore}/100`
                      : 'Not Scored'}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                  <div className="text-slate-500">Impact Area</div>
                  <div className="text-base font-semibold text-slate-900 dark:text-white mt-0.5">
                    {selected.estimatedImpactAreaKm2} km²
                  </div>
                </div>
              </div>

              {/* Weather Context Strip */}
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-3.5 space-y-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                    <CloudRain className="w-4 h-4 text-cyan-500" />
                    Incident Weather Telemetry
                  </div>
                  <button
                    type="button"
                    disabled={weatherBusy}
                    onClick={handleForceWeatherRefresh}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-cyan-500/50 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/10 text-[11px] font-medium"
                  >
                    <RefreshCw className={`w-3 h-3 ${weatherBusy ? 'animate-spin' : ''}`} />
                    Force Refresh Weather
                  </button>
                </div>
                {latestWeather ? (
                  <div className="space-y-1.5">
                    {latestWeather.unavailableNotice && (
                      <div className="text-amber-700 dark:text-amber-300 text-[11px]">
                        {latestWeather.unavailableNotice}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-4 font-mono text-[11px] text-slate-700 dark:text-slate-300 tabular-nums">
                      <span>Temp: {latestWeather.temperatureC !== null ? `${latestWeather.temperatureC}°C` : 'N/A'}</span>
                      <span>Rain: {latestWeather.rainfallMm !== null ? `${latestWeather.rainfallMm} mm` : 'N/A'}</span>
                      <span>Wind: {latestWeather.windSpeedKmh !== null ? `${latestWeather.windSpeedKmh} km/h` : 'N/A'}</span>
                      <span>Freshness: {latestWeather.freshnessCode || latestWeather.freshnessStatus.toUpperCase()}</span>
                      <span>Condition: {latestWeather.condition}</span>
                    </div>
                  </div>
                ) : (
                  <div className="text-slate-500 text-[11px]">
                    No weather snapshot linked yet. Click &ldquo;Force Refresh Weather&rdquo; or &ldquo;Assess Risk&rdquo; to fetch live Open-Meteo telemetry.
                  </div>
                )}
              </div>

              {/* Risk Intelligence & Immutable History Panel */}
              {latestRisk && (
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-4 space-y-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                      <Gauge className="w-4 h-4 text-cyan-500" />
                      Deterministic Risk Intelligence ({latestRisk.calculationVersion})
                    </div>
                    <div className="font-mono text-[11px] text-slate-500 tabular-nums">
                      {latestRisk.assessmentStatus || 'COMPLETE'} · Completeness {latestRisk.dataCompletenessPct ?? 100}% · Confidence{' '}
                      {Math.round(latestRisk.confidenceScore * 100)}%
                    </div>
                  </div>

                  {latestRisk.riskChange && latestRisk.riskChange.previousAssessmentId && (
                    <div className="p-2.5 rounded-lg border border-cyan-500/30 bg-cyan-500/10 text-cyan-800 dark:text-cyan-200 flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 font-medium">
                        <TrendingUp className="w-3.5 h-3.5" />
                        Risk Change Delta: {latestRisk.riskChange.previousScore ?? 'N/A'} →{' '}
                        {latestRisk.riskChange.currentScore ?? 'N/A'} (
                        {latestRisk.riskChange.scoreDelta !== null
                          ? `${latestRisk.riskChange.scoreDelta >= 0 ? '+' : ''}${latestRisk.riskChange.scoreDelta}`
                          : 'N/A'}
                        )
                      </span>
                      <span className="font-mono text-[11px]">
                        {latestRisk.riskChange.changeDrivers.slice(0, 2).join(' · ') || 'No material driver shift'}
                      </span>
                    </div>
                  )}

                  {latestRisk.incompleteDataWarning && (
                    <div className="p-2 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 text-[11px]">
                      Missing inputs: {latestRisk.missingFactors.join(', ')}. Missing data is never zero-filled.
                    </div>
                  )}

                  <div className="grid sm:grid-cols-2 gap-1.5 tabular-nums">
                    {latestRisk.factors.map((f) => (
                      <div
                        key={f.key}
                        className="flex items-center justify-between px-2.5 py-1.5 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800"
                      >
                        <span className="text-slate-600 dark:text-slate-300">
                          {f.label} ({Math.round(f.weight * 100)}%)
                        </span>
                        <span className="font-mono text-slate-900 dark:text-slate-100">
                          {f.missing ? 'MISSING' : `${f.normalizedScore}/100`}
                        </span>
                      </div>
                    ))}
                  </div>

                  {detail && detail.riskHistory.length > 1 && (
                    <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-1">
                      <div className="text-[11px] font-semibold text-slate-500 uppercase">
                        Immutable Assessment History ({detail.riskHistory.length})
                      </div>
                      <div className="space-y-1 max-h-24 overflow-y-auto font-mono text-[11px] tabular-nums">
                        {detail.riskHistory.slice(0, 6).map((h) => (
                          <div key={h.id} className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                            <span>
                              {h.overallScore !== null ? `${h.overallScore}/100` : 'INSUFFICIENT'} ({h.band}) ·{' '}
                              {h.assessmentSource || 'manual'}
                            </span>
                            <span>{new Date(h.createdAt).toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Grounded AI Risk Interpretation Briefing Card */}
              {latestBriefing && (
                <div className="rounded-lg border border-violet-500/40 bg-violet-500/5 dark:bg-violet-950/20 p-4 space-y-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold text-violet-900 dark:text-violet-200 flex items-center gap-1.5">
                      <Bot className="w-4 h-4 text-violet-500" />
                      AI Risk Interpretation Briefing ({latestBriefing.model})
                    </div>
                    <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-800 dark:text-amber-300 uppercase">
                      Requires Human Review
                    </span>
                  </div>
                  <p className="text-slate-800 dark:text-slate-200 leading-relaxed">{latestBriefing.summary}</p>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <div>
                      <div className="font-semibold text-slate-700 dark:text-slate-300 mb-1">Key Risk Drivers</div>
                      <ul className="list-disc pl-4 space-y-0.5 text-slate-600 dark:text-slate-300">
                        {latestBriefing.risk_drivers.map((d, i) => (
                          <li key={i}>{d}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <div className="font-semibold text-slate-700 dark:text-slate-300 mb-1">Recommended Actions</div>
                      <ul className="list-disc pl-4 space-y-0.5 text-slate-600 dark:text-slate-300">
                        {latestBriefing.recommended_actions.map((a, i) => (
                          <li key={i}>{a}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <div className="font-semibold text-slate-700 dark:text-slate-300 mb-1">Potential Escalation</div>
                      <ul className="list-disc pl-4 space-y-0.5 text-slate-600 dark:text-slate-300">
                        {latestBriefing.potential_escalation.map((e, i) => (
                          <li key={i}>{e}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <div className="font-semibold text-slate-700 dark:text-slate-300 mb-1">Verification &amp; Missing Info</div>
                      <ul className="list-disc pl-4 space-y-0.5 text-slate-600 dark:text-slate-300">
                        {latestBriefing.verification_required.map((v, i) => (
                          <li key={`v-${i}`}>Verify: {v}</li>
                        ))}
                        {latestBriefing.missing_information.map((m, i) => (
                          <li key={`m-${i}`} className="text-amber-700 dark:text-amber-300">
                            Missing: {m}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  <div className="text-[11px] text-slate-500 border-t border-violet-500/20 pt-2">
                    <strong>Uncertainty:</strong> {latestBriefing.uncertainty} · <strong>Evidence:</strong>{' '}
                    {latestBriefing.evidence_references.join(', ')}
                  </div>
                </div>
              )}

              {/* Structured Duplicate Matches */}
              {duplicateMatches.length > 0 && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3.5 space-y-2 text-xs">
                  <div className="font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                    <Copy className="w-3.5 h-3.5" />
                    Possible Geospatial / Temporal Duplicates ({duplicateMatches.length})
                  </div>
                  <div className="space-y-2">
                    {duplicateMatches.map((m) => (
                      <div
                        key={m.duplicateIncidentId}
                        className="p-2.5 rounded bg-white dark:bg-slate-900 border border-amber-500/30 space-y-1"
                      >
                        <div className="flex items-center justify-between font-medium text-slate-900 dark:text-white">
                          <span>{m.title}</span>
                          <span className="font-mono uppercase text-[10px] text-amber-600 dark:text-amber-400">
                            {m.likelihood} likelihood · {m.distanceKm.toFixed(2)} km · {m.timeDiffMinutes}m apart
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-600 dark:text-slate-400">
                          Factors: {m.similarityFactors.join(', ')} — {m.recommendation}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Field Reports Section */}
              <div className="space-y-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                  <FilePlus2 className="w-3.5 h-3.5 text-cyan-500" />
                  Field Reports ({detail?.reports.length ?? 0})
                </h3>
                <form onSubmit={attachReport} className="grid sm:grid-cols-6 gap-2 text-xs">
                  <select
                    value={reportForm.sourceType}
                    onChange={(e) =>
                      setReportForm({
                        ...reportForm,
                        sourceType: e.target.value as IncidentReportRecord['sourceType'],
                      })
                    }
                    className="sm:col-span-2 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  >
                    <option value="field_responder">Field Responder</option>
                    <option value="agency">Agency Update</option>
                    <option value="citizen">Citizen Report</option>
                    <option value="sensor">Telemetry Sensor</option>
                    <option value="command_desk">Command Desk</option>
                  </select>
                  <input
                    type="number"
                    min={0}
                    value={reportForm.peopleAffectedUpdate}
                    onChange={(e) => setReportForm({ ...reportForm, peopleAffectedUpdate: e.target.value })}
                    placeholder="Affected count (opt)"
                    className="sm:col-span-2 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 tabular-nums"
                  />
                  <input
                    type="number"
                    min={0}
                    value={reportForm.vulnerablePopulationUpdate}
                    onChange={(e) => setReportForm({ ...reportForm, vulnerablePopulationUpdate: e.target.value })}
                    placeholder="Vulnerable (opt)"
                    className="sm:col-span-2 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 tabular-nums"
                  />
                  <input
                    type="text"
                    value={reportForm.summary}
                    onChange={(e) => setReportForm({ ...reportForm, summary: e.target.value })}
                    placeholder="Attach verified field report (auto-triggers risk reassessment)..."
                    className="sm:col-span-4 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                  <button
                    type="submit"
                    disabled={!reportForm.summary.trim() || busyId === selected.id}
                    className="sm:col-span-2 px-3 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-medium disabled:opacity-50"
                  >
                    Attach Field Report
                  </button>
                </form>
                {detail && detail.reports.length > 0 && (
                  <div className="space-y-1.5 max-h-36 overflow-y-auto">
                    {detail.reports.map((r) => (
                      <div
                        key={r.id}
                        className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 text-xs"
                      >
                        <div className="text-slate-800 dark:text-slate-200">{r.summary}</div>
                        <div className="text-[11px] font-mono text-slate-500 mt-1">
                          {r.sourceType.toUpperCase()} · {r.reporterName} ({r.reporterRole}) ·{' '}
                          {new Date(r.createdAt).toLocaleString()}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Field Notes */}
              <div className="space-y-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Field Operational Notes</h3>
                <form onSubmit={addNote} className="flex gap-2">
                  <input
                    type="text"
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    placeholder="Append responder note..."
                    className="flex-1 px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                  <button
                    type="submit"
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900 dark:bg-slate-800 hover:bg-slate-700 text-white text-xs font-medium"
                  >
                    <MessageSquarePlus className="w-3.5 h-3.5" />
                    Add Note
                  </button>
                </form>
                <div className="space-y-2">
                  {selected.notes.map((n) => (
                    <div
                      key={n.id}
                      className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 text-xs"
                    >
                      <div className="text-slate-800 dark:text-slate-200">{n.text}</div>
                      <div className="text-[11px] text-slate-500 mt-1">
                        {n.author} · {new Date(n.createdAt).toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Phase 6: Incident AI Multi-Agent Coordination Panel */}
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-3.5 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-200">
                    <Bot className="w-3.5 h-3.5 text-cyan-500" />
                    Multi-Agent AI Coordination ({coordSessions.length} Session{coordSessions.length === 1 ? '' : 's'})
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={coordBusy}
                      onClick={startIncidentCoordination}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium disabled:opacity-60 whitespace-nowrap"
                    >
                      <RefreshCw className={`w-3 h-3 ${coordBusy ? 'animate-spin' : ''}`} />
                      {coordBusy ? 'Coordinating 8 Agents...' : coordSessions.length > 0 ? 'Reassess Incident' : 'Start AI Coordination'}
                    </button>
                    {onOpenAICommand && (
                      <button
                        type="button"
                        onClick={() => onOpenAICommand(coordSessions[0]?.session_id)}
                        className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-900 whitespace-nowrap"
                      >
                        Open Command Center
                      </button>
                    )}
                  </div>
                </div>
                {coordSessions.length === 0 ? (
                  <div className="text-xs text-slate-500">
                    No multi-agent coordination session run for this incident yet. Launch coordination to synthesize risk, weather, warehouse stock, routes, human impact, and deterministic safety verification.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {coordSessions.slice(0, 3).map((s) => (
                      <div
                        key={s.session_id}
                        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs"
                      >
                        <div>
                          <span className="font-mono font-semibold text-slate-900 dark:text-white">{s.session_id}</span>
                          <span className="text-slate-500 ml-2 font-mono text-[11px]">
                            {s.status} · Safety: {s.safety_status || 'PENDING'} · {s.evidence_count} evidence · {s.conflict_count} conflict(s)
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                            {new Date(s.created_at).toLocaleTimeString()}
                          </span>
                          {onOpenAICommand && (
                            <button
                              type="button"
                              onClick={() => onOpenAICommand(s.session_id)}
                              className="text-[11px] font-medium text-cyan-600 dark:text-cyan-400 hover:underline"
                            >
                              Inspect Plan
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Immutable History Timeline */}
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Audit Timeline</h3>
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {selected.history.map((h) => (
                    <div
                      key={h.id}
                      className="flex items-center justify-between text-xs py-1 border-b border-slate-100 dark:border-slate-800/60"
                    >
                      <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                        <CheckCircle2 className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
                        <span>
                          <strong>{h.action}</strong> by {h.actor} ({h.role})
                          {h.note ? ` — ${h.note}` : ''}
                        </span>
                      </div>
                      <span className="font-mono text-[11px] text-slate-500 tabular-nums shrink-0 ml-2">
                        {new Date(h.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-10 text-center text-sm text-slate-500">
              Select an incident to inspect details or report a new incident.
            </div>
          )}
        </div>
      </div>

      {/* Create Incident Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-xs p-4">
          <form
            onSubmit={handleCreate}
            className="w-full max-w-xl rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
              <h3 className="text-base font-semibold text-slate-900 dark:text-white">
                Report New Emergency Incident ({mode.toUpperCase()})
              </h3>
              <button type="button" onClick={() => setShowCreate(false)}>
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>
            <div className="p-5 grid sm:grid-cols-2 gap-3.5 max-h-[75vh] overflow-y-auto text-xs">
              <div className="sm:col-span-2">
                <label className="block text-slate-500 mb-1">Incident Title</label>
                <input
                  required
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="e.g., Northern Bridge Levee Breach & Residential Flooding"
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Incident Type</label>
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value as IncidentType })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                >
                  {INCIDENT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Severity Level (1–5)</label>
                <select
                  value={form.severityLevel}
                  onChange={(e) => {
                    const lvl = Number(e.target.value) as 1 | 2 | 3 | 4 | 5;
                    const sev: Severity = lvl >= 5 ? 'critical' : lvl === 4 ? 'high' : lvl === 3 ? 'medium' : 'low';
                    setForm({ ...form, severityLevel: lvl, severity: sev });
                  }}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                >
                  <option value={1}>Level 1 — Low (Routine)</option>
                  <option value={2}>Level 2 — Low / Guarded</option>
                  <option value={3}>Level 3 — Medium / Elevated</option>
                  <option value={4}>Level 4 — High</option>
                  <option value={5}>Level 5 — Critical</option>
                </select>
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Source Type</label>
                <select
                  value={form.sourceType}
                  onChange={(e) =>
                    setForm({ ...form, sourceType: e.target.value as IncidentReportRecord['sourceType'] })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                >
                  <option value="command_desk">Command Desk</option>
                  <option value="field_responder">Field Responder</option>
                  <option value="agency">Emergency Agency</option>
                  <option value="sensor">Sensor / Telemetry</option>
                  <option value="citizen">Citizen Report</option>
                </select>
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Region / District</label>
                <input
                  required
                  value={form.region}
                  onChange={(e) => setForm({ ...form, region: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-slate-500 mb-1">Address / Landmark</label>
                <input
                  required
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  placeholder="Sector 9 River Embankment"
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Latitude</label>
                <input
                  type="number"
                  step="0.0001"
                  required
                  value={form.lat}
                  onChange={(e) => setForm({ ...form, lat: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white tabular-nums"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Longitude</label>
                <input
                  type="number"
                  step="0.0001"
                  required
                  value={form.lng}
                  onChange={(e) => setForm({ ...form, lng: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white tabular-nums"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">People Affected</label>
                <input
                  type="number"
                  min={0}
                  required
                  value={form.peopleAffected}
                  onChange={(e) => setForm({ ...form, peopleAffected: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white tabular-nums"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Vulnerable Population</label>
                <input
                  type="number"
                  min={0}
                  required
                  value={form.vulnerablePopulation}
                  onChange={(e) => setForm({ ...form, vulnerablePopulation: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white tabular-nums"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-slate-500 mb-1">Infrastructure Affected (comma-separated)</label>
                <input
                  value={form.infrastructureText}
                  onChange={(e) => setForm({ ...form, infrastructureText: e.target.value })}
                  placeholder="Hospital, Bridge, Power Substation"
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-slate-500 mb-1">Situation Description</label>
                <textarea
                  required
                  rows={3}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Describe verified field conditions, access issues, and immediate life-safety threats..."
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-3.5 bg-slate-50 dark:bg-slate-950/60 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="px-3.5 py-2 rounded-lg text-xs font-medium border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busyId === 'create'}
                className="px-4 py-2 rounded-lg text-xs font-medium bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white"
              >
                {busyId === 'create' ? 'Submitting...' : 'Submit Incident'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Edit Incident PATCH Modal */}
      {showEdit && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-xs p-4">
          <form
            onSubmit={handlePatch}
            className="w-full max-w-lg rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
              <h3 className="text-base font-semibold text-slate-900 dark:text-white">Edit Incident Parameters</h3>
              <button type="button" onClick={() => setShowEdit(false)}>
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>
            <div className="p-5 grid sm:grid-cols-2 gap-3.5 text-xs">
              <div className="sm:col-span-2">
                <label className="block text-slate-500 mb-1">Title</label>
                <input
                  required
                  value={editForm.title}
                  onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Severity</label>
                <select
                  value={editForm.severity}
                  onChange={(e) => setEditForm({ ...editForm, severity: e.target.value as Severity })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                >
                  {(['low', 'medium', 'high', 'critical'] as Severity[]).map((s) => (
                    <option key={s} value={s}>
                      {s.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Impact Area (km²)</label>
                <input
                  type="number"
                  step="0.1"
                  min={0}
                  value={editForm.estimatedImpactAreaKm2}
                  onChange={(e) => setEditForm({ ...editForm, estimatedImpactAreaKm2: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white tabular-nums"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">People Affected</label>
                <input
                  type="number"
                  min={0}
                  value={editForm.peopleAffected}
                  onChange={(e) => setEditForm({ ...editForm, peopleAffected: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white tabular-nums"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Vulnerable Population</label>
                <input
                  type="number"
                  min={0}
                  value={editForm.vulnerablePopulation}
                  onChange={(e) => setEditForm({ ...editForm, vulnerablePopulation: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white tabular-nums"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-slate-500 mb-1">Address</label>
                <input
                  required
                  value={editForm.address}
                  onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-slate-500 mb-1">Audit Note (optional)</label>
                <input
                  value={editForm.note}
                  onChange={(e) => setEditForm({ ...editForm, note: e.target.value })}
                  placeholder="Reason for parameter update..."
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-3.5 bg-slate-50 dark:bg-slate-950/60 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setShowEdit(false)}
                className="px-3.5 py-2 rounded-lg text-xs font-medium border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busyId === selected.id}
                className="px-4 py-2 rounded-lg text-xs font-medium bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white"
              >
                Save &amp; Reassess
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
