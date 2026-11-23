import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bot,
  CloudRain,
  Gauge,
  RefreshCw,
  TrendingUp,
} from 'lucide-react';
import { apiRequest } from '../../lib/api';
import type {
  AIRiskBriefing,
  DataMode,
  Incident,
  PredictionRecord,
  RiskAssessment,
  WeatherObservation,
  WeatherRiskResult,
} from '../../shared/types';

interface RiskIntelligenceViewProps {
  mode: DataMode;
  incidents: Incident[];
  onRefresh: () => void;
}

interface RiskOverviewData {
  mode: DataMode;
  totalActiveIncidents: number;
  assessedIncidents: number;
  averageRiskScore: number | null;
  bandCounts: Record<string, number>;
  incompleteAssessments: number;
  insufficientDataCount: number;
  activeAlertsCount: number;
  recentChanges: {
    assessmentId: string;
    incidentId: string;
    incidentTitle: string;
    createdAt: string;
    previousScore: number | null;
    currentScore: number | null;
    scoreDelta: number | null;
    previousBand: string | null;
    currentBand: string | null;
    bandChanged: boolean;
    changeDrivers: string[];
  }[];
  reassessmentStats: {
    activeLocks: number;
    pendingDebounced: number;
    totalCompleted: number;
    totalSuperseded: number;
    totalFailed: number;
  };
}

interface WeatherProviderStatus {
  provider: string;
  status: string;
  cacheEntries: number;
  inFlightRequests: number;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastLatencyMs: number | null;
}

export const RiskIntelligenceView: React.FC<RiskIntelligenceViewProps> = ({
  mode,
  incidents,
  onRefresh,
}) => {
  const [assessments, setAssessments] = useState<RiskAssessment[]>([]);
  const [predictions, setPredictions] = useState<PredictionRecord[]>([]);
  const [briefings, setBriefings] = useState<AIRiskBriefing[]>([]);
  const [overview, setOverview] = useState<RiskOverviewData | null>(null);
  const [providerStatus, setProviderStatus] = useState<WeatherProviderStatus | null>(null);
  const [weather, setWeather] = useState<WeatherObservation | null>(null);
  const [incidentWeatherRisk, setIncidentWeatherRisk] = useState<WeatherRiskResult | null>(null);

  const [selectedIncidentId, setSelectedIncidentId] = useState<string>(incidents[0]?.id || '');
  const [loading, setLoading] = useState(false);
  const [weatherBusy, setWeatherBusy] = useState(false);
  const [aiBusyId, setAiBusyId] = useState<string | null>(null);
  const [activeBriefing, setActiveBriefing] = useState<AIRiskBriefing | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadRisks = useCallback(async () => {
    try {
      const [riskRes, overviewRes, provRes] = await Promise.all([
        apiRequest<{ assessments: RiskAssessment[]; predictions: PredictionRecord[]; aiBriefings?: AIRiskBriefing[] }>(
          `/risks?mode=${mode}`
        ),
        apiRequest<RiskOverviewData>(`/risks/overview?mode=${mode}`),
        apiRequest<{ providers: WeatherProviderStatus[] }>('/weather/providers/status'),
      ]);
      setAssessments(riskRes.assessments);
      setPredictions(riskRes.predictions);
      if (riskRes.aiBriefings) setBriefings(riskRes.aiBriefings);
      setOverview(overviewRes);
      setProviderStatus(provRes.providers[0] || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load risk data');
    }
  }, [mode]);

  const loadIncidentWeather = useCallback(async (incId: string) => {
    if (!incId) return;
    try {
      const res = await apiRequest<{
        observation: WeatherObservation;
        incidentWeatherRisk: WeatherRiskResult;
      }>(`/incidents/${incId}/weather`);
      setWeather(res.observation);
      setIncidentWeatherRisk(res.incidentWeatherRisk);
    } catch {
      // handled gracefully
    }
  }, []);

  useEffect(() => {
    loadRisks();
    const targetId =
      incidents.find((i) => i.id === selectedIncidentId)?.id || incidents[0]?.id || '';
    setSelectedIncidentId(targetId);
    if (targetId) {
      loadIncidentWeather(targetId);
    }
  }, [mode, incidents.length, loadRisks, loadIncidentWeather]);

  const handleSelectIncident = (id: string) => {
    setSelectedIncidentId(id);
    if (id) {
      loadIncidentWeather(id);
    }
  };

  const runAssessment = async () => {
    if (!selectedIncidentId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<{ assessment: RiskAssessment; weather: WeatherObservation }>('/risks/assess', {
        method: 'POST',
        body: { incidentId: selectedIncidentId },
      });
      setWeather(res.weather);
      await loadIncidentWeather(selectedIncidentId);
      await loadRisks();
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Risk assessment failed');
    } finally {
      setLoading(false);
    }
  };

  const forceRefreshWeather = async () => {
    if (!selectedIncidentId) return;
    setWeatherBusy(true);
    setError(null);
    try {
      const res = await apiRequest<{
        observation: WeatherObservation;
        incidentWeatherRisk: WeatherRiskResult;
      }>(`/weather/refresh/${selectedIncidentId}`, { method: 'POST', body: {} });
      setWeather(res.observation);
      setIncidentWeatherRisk(res.incidentWeatherRisk);
      await loadRisks();
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Weather force refresh failed');
    } finally {
      setWeatherBusy(false);
    }
  };

  const runAiBriefing = async (incidentId: string) => {
    setAiBusyId(incidentId);
    setError(null);
    try {
      const res = await apiRequest<{ briefing: AIRiskBriefing }>(`/incidents/${incidentId}/risk-explanation`, {
        method: 'POST',
        body: {},
      });
      setActiveBriefing(res.briefing);
      await loadRisks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI Risk Briefing generation failed');
    } finally {
      setAiBusyId(null);
    }
  };

  const displayedBriefing = activeBriefing || briefings[0] || null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">
            Emergency Risk Intelligence, Live Weather &amp; Escalation Watch
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Deterministic Risk Engine v2.0 (0–100), Open-Meteo hourly/daily forecasts, risk change delta tracking &amp; grounded AI interpretation
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedIncidentId}
            onChange={(e) => handleSelectIncident(e.target.value)}
            className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs text-slate-900 dark:text-slate-100 max-w-xs"
          >
            {incidents.map((inc) => (
              <option key={inc.id} value={inc.id}>
                {inc.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={weatherBusy || !selectedIncidentId}
            onClick={forceRefreshWeather}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-cyan-500/50 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/10 text-xs font-medium disabled:opacity-60"
          >
            <CloudRain className={`w-3.5 h-3.5 ${weatherBusy ? 'animate-spin' : ''}`} />
            Force Weather Refresh
          </button>
          <button
            type="button"
            disabled={loading || !selectedIncidentId}
            onClick={runAssessment}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium disabled:opacity-60"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Run Live Risk Score
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-red-500/40 bg-red-500/10 text-xs text-red-600 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Phase 3 Risk Overview KPI Strip */}
      {overview && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs tabular-nums">
          <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80">
            <div className="text-slate-500">Active Incidents</div>
            <div className="text-lg font-bold text-slate-900 dark:text-white mt-0.5">{overview.totalActiveIncidents}</div>
          </div>
          <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80">
            <div className="text-slate-500">Avg Risk Score</div>
            <div className="text-lg font-bold text-cyan-600 dark:text-cyan-400 mt-0.5">
              {overview.averageRiskScore !== null ? `${overview.averageRiskScore}/100` : 'N/A'}
            </div>
          </div>
          <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80">
            <div className="text-slate-500">Critical / High</div>
            <div className="text-lg font-bold text-red-500 mt-0.5">
              {(overview.bandCounts.Critical ?? 0)} / {(overview.bandCounts.High ?? 0)}
            </div>
          </div>
          <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80">
            <div className="text-slate-500">Incomplete Data</div>
            <div className="text-lg font-bold text-amber-500 mt-0.5">{overview.incompleteAssessments}</div>
          </div>
          <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80">
            <div className="text-slate-500">Active Alerts</div>
            <div className="text-lg font-bold text-orange-500 mt-0.5">{overview.activeAlertsCount}</div>
          </div>
          <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80">
            <div className="text-slate-500">Auto-Reassessed</div>
            <div className="text-lg font-bold text-emerald-500 mt-0.5">
              {overview.reassessmentStats.totalCompleted}
            </div>
          </div>
        </div>
      )}

      {/* Live Weather Intelligence Card */}
      {weather && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
              <CloudRain className="w-4 h-4 text-cyan-500" />
              Live Meteorological Telemetry: {weather.locationName}
            </div>
            <div className="text-xs font-mono text-slate-500 tabular-nums">
              {weather.provider} · {weather.sourceType} · Freshness:{' '}
              <strong
                className={
                  (weather.freshnessCode || 'FRESH') === 'FRESH'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-amber-600 dark:text-amber-400'
                }
              >
                {weather.freshnessCode || weather.freshnessStatus.toUpperCase()}
              </strong>
              {typeof weather.cacheAgeSeconds === 'number' ? ` (${weather.cacheAgeSeconds}s old)` : ''} · Fetched{' '}
              {new Date(weather.fetchTimestamp).toLocaleTimeString()}
            </div>
          </div>

          {weather.unavailableNotice && (
            <div className="p-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-xs text-amber-700 dark:text-amber-300 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {weather.unavailableNotice}
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 text-xs tabular-nums">
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
              <div className="text-slate-500">Condition</div>
              <div className="text-sm font-semibold text-slate-900 dark:text-white mt-0.5">{weather.condition}</div>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
              <div className="text-slate-500">Temperature</div>
              <div className="text-sm font-semibold text-slate-900 dark:text-white mt-0.5">
                {weather.temperatureC !== null ? `${weather.temperatureC}°C` : 'UNAVAILABLE'}
              </div>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
              <div className="text-slate-500">Rainfall / Precip</div>
              <div className="text-sm font-semibold text-slate-900 dark:text-white mt-0.5">
                {weather.rainfallMm !== null ? `${weather.rainfallMm} mm/hr` : 'N/A'}
              </div>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
              <div className="text-slate-500">Wind / Gusts</div>
              <div className="text-sm font-semibold text-slate-900 dark:text-white mt-0.5">
                {weather.windSpeedKmh !== null ? `${weather.windSpeedKmh} km/h` : 'N/A'}
                {weather.windGustKmh ? ` (${weather.windGustKmh})` : ''}
              </div>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
              <div className="text-slate-500">Hazard Weather Risk</div>
              <div className="text-sm font-semibold text-cyan-600 dark:text-cyan-400 mt-0.5">
                {incidentWeatherRisk
                  ? incidentWeatherRisk.score !== null
                    ? `${incidentWeatherRisk.score}/100 (${incidentWeatherRisk.level})`
                    : 'INSUFFICIENT'
                  : weather.riskClassification}
              </div>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
              <div className="text-slate-500">Provider Health</div>
              <div className="text-sm font-semibold uppercase text-emerald-600 dark:text-emerald-400 mt-0.5">
                {providerStatus ? `${providerStatus.status}` : 'OK'}
                {providerStatus?.lastLatencyMs ? ` (${providerStatus.lastLatencyMs}ms)` : ''}
              </div>
            </div>
          </div>

          {incidentWeatherRisk && incidentWeatherRisk.triggeredRules.length > 0 && (
            <div className="text-xs text-amber-700 dark:text-amber-300">
              <strong>Triggered Weather Rules ({incidentWeatherRisk.hazardType}):</strong>{' '}
              {incidentWeatherRisk.triggeredRules.join(' · ')}
            </div>
          )}

          {/* Hourly & Daily Forecasts */}
          {(weather.forecastSummary.length > 0 || (weather.dailyForecast && weather.dailyForecast.length > 0)) && (
            <div className="grid lg:grid-cols-2 gap-4 pt-2 border-t border-slate-100 dark:border-slate-800">
              {weather.forecastSummary.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-mono uppercase text-slate-500">Next Hourly Forecast</div>
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 text-[11px] font-mono tabular-nums">
                    {weather.forecastSummary.slice(0, 6).map((h, idx) => (
                      <div
                        key={idx}
                        className="p-2 rounded bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 text-center"
                      >
                        <div className="text-slate-500">{h.time.slice(11, 16) || h.time}</div>
                        <div className="font-semibold text-slate-900 dark:text-white">
                          {h.tempC !== null ? `${h.tempC}°C` : '—'}
                        </div>
                        <div className="text-cyan-600 dark:text-cyan-400">
                          {h.precipMm !== null ? `${h.precipMm}mm` : '—'}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {weather.dailyForecast && weather.dailyForecast.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-mono uppercase text-slate-500">3-Day Daily Outlook</div>
                  <div className="grid grid-cols-3 gap-2 text-[11px] font-mono tabular-nums">
                    {weather.dailyForecast.slice(0, 3).map((d) => (
                      <div
                        key={d.date}
                        className="p-2 rounded bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800"
                      >
                        <div className="text-slate-500">{d.date}</div>
                        <div className="font-semibold text-slate-900 dark:text-white">
                          {d.tempMinC ?? '—'}° / {d.tempMaxC ?? '—'}°C
                        </div>
                        <div className="text-cyan-600 dark:text-cyan-400">
                          Rain {d.precipSumMm ?? 0}mm · Wind {d.windMaxKmh ?? '—'}km/h
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="text-xs text-slate-600 dark:text-slate-300">{weather.explanation}</div>
        </div>
      )}

      {/* Grounded AI Risk Interpretation Panel */}
      {displayedBriefing && (
        <div className="rounded-xl border border-violet-500/40 bg-violet-500/5 dark:bg-violet-950/20 p-5 space-y-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-violet-900 dark:text-violet-200 flex items-center gap-2">
              <Bot className="w-4 h-4 text-violet-500" />
              Latest AI Risk Interpretation Briefing ({displayedBriefing.model})
            </div>
            <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-800 dark:text-amber-300 uppercase">
              Decision-Support Only · Requires Human Review
            </span>
          </div>
          <p className="text-slate-800 dark:text-slate-200 leading-relaxed">{displayedBriefing.summary}</p>
          <div className="grid md:grid-cols-3 gap-3">
            <div>
              <div className="font-semibold text-slate-700 dark:text-slate-300 mb-1">Risk Drivers</div>
              <ul className="list-disc pl-4 space-y-0.5 text-slate-600 dark:text-slate-300">
                {displayedBriefing.risk_drivers.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="font-semibold text-slate-700 dark:text-slate-300 mb-1">Recommended Actions</div>
              <ul className="list-disc pl-4 space-y-0.5 text-slate-600 dark:text-slate-300">
                {displayedBriefing.recommended_actions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="font-semibold text-slate-700 dark:text-slate-300 mb-1">Verification &amp; Gaps</div>
              <ul className="list-disc pl-4 space-y-0.5 text-slate-600 dark:text-slate-300">
                {displayedBriefing.verification_required.map((v, i) => (
                  <li key={`v-${i}`}>{v}</li>
                ))}
                {displayedBriefing.missing_information.map((m, i) => (
                  <li key={`m-${i}`} className="text-amber-700 dark:text-amber-300">
                    Missing: {m}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="text-[11px] text-slate-500">
            Uncertainty: {displayedBriefing.uncertainty} · Generated {new Date(displayedBriefing.generated_at).toLocaleString()}
          </div>
        </div>
      )}

      {/* Deterministic Risk Assessments + Change Detection & Predictions */}
      <div className="grid lg:grid-cols-2 gap-5">
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <Gauge className="w-4 h-4 text-cyan-500" />
            Deterministic Multi-Factor Risk Assessments ({assessments.length})
          </h2>
          {assessments.map((a) => (
            <div
              key={a.id}
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-slate-900 dark:text-white">{a.incidentTitle}</div>
                  <div className="text-[11px] font-mono text-slate-500">
                    {a.calculationVersion} · {a.assessmentStatus || 'COMPLETE'} · Completeness {a.dataCompletenessPct ?? 100}% ·
                    Confidence {Math.round(a.confidenceScore * 100)}%
                  </div>
                </div>
                <div className="text-right tabular-nums shrink-0">
                  <div className="text-lg font-bold text-slate-900 dark:text-white">
                    {a.overallScore !== null ? `${a.overallScore}/100` : 'INSUFFICIENT DATA'}
                  </div>
                  <div
                    className={`text-xs font-mono uppercase ${
                      a.band === 'Critical'
                        ? 'text-red-500'
                        : a.band === 'High'
                        ? 'text-orange-500'
                        : a.band === 'Insufficient Data'
                        ? 'text-slate-400'
                        : 'text-amber-500'
                    }`}
                  >
                    {a.band}
                  </div>
                </div>
              </div>

              {a.riskChange && a.riskChange.previousAssessmentId && (
                <div className="px-2.5 py-1.5 rounded-lg border border-cyan-500/30 bg-cyan-500/10 text-[11px] text-cyan-800 dark:text-cyan-200 font-mono">
                  Delta: {a.riskChange.previousScore ?? 'N/A'} → {a.riskChange.currentScore ?? 'N/A'} (
                  {a.riskChange.scoreDelta !== null
                    ? `${a.riskChange.scoreDelta >= 0 ? '+' : ''}${a.riskChange.scoreDelta}`
                    : 'N/A'}
                  ) {a.riskChange.bandChanged ? `· Band ${a.riskChange.previousBand} → ${a.riskChange.currentBand}` : ''}
                </div>
              )}

              {a.incompleteDataWarning && (
                <div className="p-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-xs text-amber-700 dark:text-amber-300 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  INCOMPLETE DATA WARNING: Missing {a.missingFactors.join(', ')}. Weights normalized across present inputs only.
                </div>
              )}

              <div className="space-y-1.5 text-xs">
                {a.factors.map((f) => (
                  <div key={f.key} className="flex items-center justify-between gap-2 tabular-nums">
                    <span className="text-slate-600 dark:text-slate-300">
                      {f.label} <span className="text-slate-400">({Math.round(f.weight * 100)}%)</span>
                    </span>
                    <span className="font-mono text-slate-800 dark:text-slate-200">
                      {f.missing ? 'MISSING' : `${f.normalizedScore}/100 · ${f.rawValue}`}
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 dark:border-slate-800 pt-2">
                <p className="text-xs text-slate-500 dark:text-slate-400 flex-1">{a.explanation}</p>
                <button
                  type="button"
                  disabled={aiBusyId === a.incidentId}
                  onClick={() => runAiBriefing(a.incidentId)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-violet-500/50 text-violet-700 dark:text-violet-300 hover:bg-violet-500/10 text-[11px] font-medium shrink-0"
                >
                  <Bot className="w-3.5 h-3.5" />
                  {aiBusyId === a.incidentId ? 'Generating...' : 'Generate AI Briefing'}
                </button>
              </div>
            </div>
          ))}
          {assessments.length === 0 && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-8 text-center text-xs text-slate-500">
              No risk assessments recorded yet. Select an incident above to run live deterministic scoring.
            </div>
          )}
        </div>

        {/* Right Column: Risk Change Detection Feed + Predictive Watch */}
        <div className="space-y-5">
          {overview && overview.recentChanges.length > 0 && (
            <div className="space-y-2.5">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                <Activity className="w-4 h-4 text-cyan-500" />
                Risk Change Detection Feed
              </h2>
              {overview.recentChanges.map((c) => (
                <div
                  key={c.assessmentId}
                  className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-3.5 space-y-1 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-900 dark:text-white">{c.incidentTitle}</span>
                    <span
                      className={`font-mono font-semibold tabular-nums ${
                        (c.scoreDelta ?? 0) > 0
                          ? 'text-red-500'
                          : (c.scoreDelta ?? 0) < 0
                          ? 'text-emerald-500'
                          : 'text-slate-400'
                      }`}
                    >
                      {c.previousScore ?? 'N/A'} → {c.currentScore ?? 'N/A'} (
                      {c.scoreDelta !== null ? `${c.scoreDelta >= 0 ? '+' : ''}${c.scoreDelta}` : 'N/A'})
                    </span>
                  </div>
                  <div className="text-slate-600 dark:text-slate-400">
                    {c.changeDrivers.length > 0 ? c.changeDrivers.join(' · ') : 'Score verified with updated telemetry.'}
                  </div>
                  <div className="text-[11px] font-mono text-slate-500">
                    {new Date(c.createdAt).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-amber-500" />
              Predictive Burn-Rate &amp; Escalation Watch (12h–24h)
            </h2>
            {predictions.map((p) => (
              <div
                key={p.id}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-[11px] font-mono uppercase text-amber-600 dark:text-amber-400">
                      {p.predictionType.replace(/_/g, ' ')} · {p.forecastHorizonHours}h horizon
                    </div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-white">{p.targetName}</div>
                  </div>
                  <div className="text-right font-mono text-sm font-semibold text-slate-900 dark:text-white tabular-nums shrink-0">
                    {p.projectedValue} {p.unit}
                  </div>
                </div>
                <p className="text-xs text-slate-700 dark:text-slate-300">{p.predictionSummary}</p>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  <strong>Methodology ({p.modelVersion}):</strong> {p.methodology}
                </div>
                <div className="text-[11px] text-amber-700 dark:text-amber-400/90 italic">
                  Uncertainty: {p.uncertaintyNote}
                </div>
              </div>
            ))}
            {predictions.length === 0 && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-8 text-center text-xs text-slate-500">
                No active depletion or escalation watches triggered in {mode.toUpperCase()} mode.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
