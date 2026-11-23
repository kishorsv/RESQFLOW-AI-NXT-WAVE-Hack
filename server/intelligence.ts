import { v4 as uuidv4 } from 'uuid';
import type {
  AlertRecord,
  Incident,
  ReassessmentJobRecord,
  RiskAssessment,
  UserRole,
  WeatherObservation,
} from '../src/shared/types.ts';
import {
  calculateIncidentWeatherRisk,
  computeDeterministicRisk,
  fetchLiveWeather,
  RISK_ENGINE_VERSION,
} from './engines.ts';
import { eventBus } from './events.ts';
import { store } from './store.ts';

// ============================================================================
// 1. AUTOMATED ALERT EVALUATION ENGINE (Cooldown + Deduplication + Lifecycle)
// ============================================================================

export function evaluateAlertsForAssessment(params: {
  incident: Incident;
  assessment: RiskAssessment;
  weather: WeatherObservation | null;
  orgId?: string;
}): AlertRecord[] {
  const { incident, assessment, weather } = params;
  const orgId = params.orgId || incident.assignedOrgId || 'org-central-cmd';
  const triggered: AlertRecord[] = [];

  const emit = (alert: AlertRecord | null) => {
    if (!alert) return;
    triggered.push(alert);
    eventBus.publish({
      event_type: 'alert.triggered',
      organization_id: orgId,
      entity_id: alert.id,
      source: 'alert-engine',
      mode: incident.mode,
      payload: { alert, incidentId: incident.id },
    });
  };

  // Rule 1: Critical risk band crossed (>= 80)
  if (assessment.band === 'Critical' && assessment.overallScore !== null) {
    const res = store.triggerAlert({
      dedupKey: `${incident.mode}:risk_critical:${incident.id}`,
      incidentId: incident.id,
      incidentTitle: incident.title,
      alertType: 'risk_critical_threshold',
      severity: 'critical',
      title: `CRITICAL Risk Threshold Crossed (${assessment.overallScore}/100): ${incident.title}`,
      message: `${assessment.explanation}`,
      triggerFactor: 'overall_risk_score >= 80',
      previousValue: assessment.riskChange?.previousScore ?? null,
      currentValue: assessment.overallScore,
      source: RISK_ENGINE_VERSION,
      mode: incident.mode,
    });
    emit(res.alert);
  } else if (assessment.band === 'High' && assessment.overallScore !== null) {
    // Rule 2: High risk band crossed (60–79)
    const res = store.triggerAlert({
      dedupKey: `${incident.mode}:risk_high:${incident.id}`,
      incidentId: incident.id,
      incidentTitle: incident.title,
      alertType: 'risk_high_threshold',
      severity: 'high',
      title: `HIGH Risk Threshold Crossed (${assessment.overallScore}/100): ${incident.title}`,
      message: `${assessment.explanation}`,
      triggerFactor: 'overall_risk_score >= 60',
      previousValue: assessment.riskChange?.previousScore ?? null,
      currentValue: assessment.overallScore,
      source: RISK_ENGINE_VERSION,
      mode: incident.mode,
    });
    emit(res.alert);
  }

  // Rule 3: Significant rapid risk jump (>= +15 pts)
  if (assessment.riskChange?.significantJump && assessment.riskChange.scoreDelta !== null) {
    const res = store.triggerAlert({
      dedupKey: `${incident.mode}:risk_jump:${incident.id}:${assessment.overallScore}`,
      incidentId: incident.id,
      incidentTitle: incident.title,
      alertType: 'risk_significant_increase',
      severity: assessment.band === 'Critical' ? 'critical' : 'high',
      title: `Rapid Risk Escalation (+${assessment.riskChange.scoreDelta} pts): ${incident.title}`,
      message: `Risk jumped from ${assessment.riskChange.previousScore} to ${assessment.riskChange.currentScore}. Drivers: ${assessment.riskChange.changeDrivers.join('; ')}.`,
      triggerFactor: 'score_delta >= +15',
      previousValue: assessment.riskChange.previousScore,
      currentValue: assessment.riskChange.currentScore,
      source: 'risk-change-detector',
      mode: incident.mode,
    });
    emit(res.alert);
  }

  // Rule 4: Weather hazard threshold crossed
  if (weather) {
    const weatherRisk = calculateIncidentWeatherRisk(incident.type, weather);
    if (weatherRisk.triggeredRules.length > 0 && (weatherRisk.score ?? 0) >= 50) {
      const res = store.triggerAlert({
        dedupKey: `${incident.mode}:weather_rule:${incident.id}:${weatherRisk.hazardType}`,
        incidentId: incident.id,
        incidentTitle: incident.title,
        alertType: 'weather_threshold_crossed',
        severity: (weatherRisk.score ?? 0) >= 75 ? 'critical' : 'high',
        title: `Environmental Hazard Trigger (${weatherRisk.hazardType.toUpperCase()}): ${incident.title}`,
        message: weatherRisk.explanation,
        triggerFactor: weatherRisk.triggeredRules[0],
        previousValue: null,
        currentValue: weatherRisk.score,
        source: weather.provider,
        mode: incident.mode,
      });
      emit(res.alert);
    }

    // Rule 5: Weather provider outage / stale data degraded notice
    if (weather.freshnessCode === 'UNAVAILABLE' || weather.freshnessCode === 'STALE') {
      const res = store.triggerAlert({
        dedupKey: `${incident.mode}:weather_degraded:${incident.id}`,
        incidentId: incident.id,
        incidentTitle: incident.title,
        alertType: 'weather_provider_degraded',
        severity: 'warning',
        title: `Weather Data ${weather.freshnessCode}: ${incident.title}`,
        message: weather.unavailableNotice || weather.explanation,
        triggerFactor: `weather_freshness == ${weather.freshnessCode}`,
        previousValue: 'FRESH',
        currentValue: weather.freshnessCode,
        source: 'weather-freshness-monitor',
        cooldownMinutes: 30,
        mode: incident.mode,
      });
      emit(res.alert);
    }
  }

  // Rule 6: Incomplete / Insufficient risk assessment warning
  if (assessment.assessmentStatus === 'INSUFFICIENT_DATA') {
    const res = store.triggerAlert({
      dedupKey: `${incident.mode}:risk_insufficient:${incident.id}`,
      incidentId: incident.id,
      incidentTitle: incident.title,
      alertType: 'incomplete_risk_assessment',
      severity: 'warning',
      title: `Insufficient Data for Risk Assessment: ${incident.title}`,
      message: `Only ${assessment.dataCompletenessPct ?? 0}% of weighted factors present. Missing: ${assessment.missingFactors.join(', ')}.`,
      triggerFactor: 'assessment_status == INSUFFICIENT_DATA',
      previousValue: null,
      currentValue: `${assessment.dataCompletenessPct ?? 0}%`,
      source: RISK_ENGINE_VERSION,
      cooldownMinutes: 30,
      mode: incident.mode,
    });
    emit(res.alert);
  }

  // Rule 7: Manual verification required for unverified high/critical incidents
  if (
    (incident.severity === 'high' || incident.severity === 'critical') &&
    (incident.verificationStatus === 'unverified' || incident.verificationStatus === 'pending')
  ) {
    const res = store.triggerAlert({
      dedupKey: `${incident.mode}:verify_needed:${incident.id}`,
      incidentId: incident.id,
      incidentTitle: incident.title,
      alertType: 'manual_verification_required',
      severity: 'warning',
      title: `Commander Verification Required: ${incident.title}`,
      message: `Unverified ${incident.severity.toUpperCase()} incident requires human commander verification before resource commitment.`,
      triggerFactor: `verification_status == ${incident.verificationStatus}`,
      previousValue: null,
      currentValue: incident.verificationStatus,
      source: 'incident-lifecycle-engine',
      cooldownMinutes: 30,
      mode: incident.mode,
    });
    emit(res.alert);
  }

  return triggered;
}

// ============================================================================
// 2. EVENT-DRIVEN AUTOMATIC RISK REASSESSMENT COORDINATOR
//    Features: Debouncing, Per-Incident Lock, Superseded Detection, Retries
// ============================================================================

interface PendingTimer {
  timer: ReturnType<typeof setTimeout>;
  jobId: string;
}

const pendingTimers = new Map<string, PendingTimer>();
const activeLocks = new Set<string>();
const needsRerun = new Map<
  string,
  { reason: string; actorName: string; actorRole: UserRole; orgId: string; forceWeatherRefresh?: boolean }
>();

const coordinatorStats = {
  totalScheduled: 0,
  totalCompleted: 0,
  totalSuperseded: 0,
  totalFailed: 0,
  totalRetries: 0,
};

export function getReassessmentStats() {
  return {
    ...coordinatorStats,
    pendingDebounced: pendingTimers.size,
    activeLocks: activeLocks.size,
    recentJobs: store.state.reassessmentJobs.slice(0, 20),
  };
}

export async function reassessIncidentNow(params: {
  incidentId: string;
  reason: string;
  assessmentSource?: RiskAssessment['assessmentSource'];
  actorName: string;
  actorRole: UserRole;
  orgId: string;
  forceWeatherRefresh?: boolean;
  simulateWeatherOutage?: boolean;
}): Promise<{
  assessment: RiskAssessment;
  weather: WeatherObservation;
  alertsTriggered: AlertRecord[];
}> {
  const incident = store.state.incidents.find((i) => i.id === params.incidentId);
  if (!incident) {
    throw new Error(`Incident '${params.incidentId}' not found`);
  }

  const previousAssessment =
    store.state.riskAssessments.find((r) => r.incidentId === incident.id) || null;

  const weather = await fetchLiveWeather(incident.lat, incident.lng, incident.address, {
    forceRefresh: params.forceWeatherRefresh,
    simulateOutage: params.simulateWeatherOutage,
  });

  const assessment = computeDeterministicRisk(incident, weather, {
    assessmentSource: params.assessmentSource || 'manual',
    assessor: params.actorName,
    previousAssessment,
  });

  // Immutable history: ALWAYS unshift a new record, never overwrite prior assessments!
  store.state.riskAssessments.unshift(assessment);
  if (store.state.riskAssessments.length > 250) {
    store.state.riskAssessments.length = 250;
  }

  incident.riskScore = assessment.overallScore;
  incident.riskBand = assessment.band === 'Insufficient Data' ? null : assessment.band;
  incident.updatedAt = assessment.createdAt;
  store.save();

  store.addAudit({
    actor: params.actorName,
    role: params.actorRole,
    orgId: params.orgId,
    action: 'risk.assessed',
    entityType: 'incident',
    entityId: incident.id,
    summary: `Assessed deterministic risk ${
      assessment.overallScore !== null ? `${assessment.overallScore}/100` : 'INSUFFICIENT_DATA'
    } (${assessment.band}) [${params.reason}]`,
    mode: incident.mode,
  });

  const alertsTriggered = evaluateAlertsForAssessment({
    incident,
    assessment,
    weather,
    orgId: params.orgId,
  });

  eventBus.publish({
    event_type: 'risk.updated',
    organization_id: params.orgId,
    entity_id: incident.id,
    source: 'risk-engine-v2',
    mode: incident.mode,
    payload: {
      assessment,
      weather,
      riskChange: assessment.riskChange,
      alertsTriggeredCount: alertsTriggered.length,
    },
  });

  return { assessment, weather, alertsTriggered };
}

export function scheduleAutomaticReassessment(params: {
  incidentId: string;
  reason: string;
  assessmentSource?: RiskAssessment['assessmentSource'];
  actorName: string;
  actorRole: UserRole;
  orgId: string;
  debounceMs?: number;
  forceWeatherRefresh?: boolean;
}): ReassessmentJobRecord {
  coordinatorStats.totalScheduled += 1;
  const debounceMs = params.debounceMs ?? 250;

  // Mark any previously queued debounced job for this incident as superseded
  const existing = pendingTimers.get(params.incidentId);
  if (existing) {
    clearTimeout(existing.timer);
    pendingTimers.delete(params.incidentId);
    const prevJob = store.state.reassessmentJobs.find((j) => j.id === existing.jobId);
    if (prevJob && prevJob.status === 'queued') {
      prevJob.status = 'superseded';
      prevJob.completedAt = new Date().toISOString();
      coordinatorStats.totalSuperseded += 1;
    }
  }

  const job: ReassessmentJobRecord = {
    id: uuidv4(),
    incidentId: params.incidentId,
    reason: params.reason,
    actor: params.actorName,
    status: 'queued',
    attempts: 0,
    createdAt: new Date().toISOString(),
  };

  store.state.reassessmentJobs.unshift(job);
  if (store.state.reassessmentJobs.length > 100) {
    store.state.reassessmentJobs.length = 100;
  }

  const executeJob = async () => {
    pendingTimers.delete(params.incidentId);

    // Per-incident lock: if another run is active, mark for a single coalesced re-run after lock releases
    if (activeLocks.has(params.incidentId)) {
      job.status = 'superseded';
      job.completedAt = new Date().toISOString();
      coordinatorStats.totalSuperseded += 1;
      needsRerun.set(params.incidentId, {
        reason: params.reason,
        actorName: params.actorName,
        actorRole: params.actorRole,
        orgId: params.orgId,
        forceWeatherRefresh: params.forceWeatherRefresh,
      });
      return;
    }

    activeLocks.add(params.incidentId);
    job.status = 'running';

    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        job.attempts = attempt;
        try {
          const result = await reassessIncidentNow({
            incidentId: params.incidentId,
            reason: params.reason,
            assessmentSource: params.assessmentSource || 'auto_reassessment',
            actorName: params.actorName,
            actorRole: params.actorRole,
            orgId: params.orgId,
            forceWeatherRefresh: params.forceWeatherRefresh,
          });
          job.status = 'completed';
          job.assessmentId = result.assessment.id;
          job.completedAt = new Date().toISOString();
          coordinatorStats.totalCompleted += 1;
          break;
        } catch (err) {
          if (attempt < 2) {
            coordinatorStats.totalRetries += 1;
            await new Promise((r) => setTimeout(r, 200));
          } else {
            job.status = 'failed';
            job.error = err instanceof Error ? err.message : 'Reassessment execution failed';
            job.completedAt = new Date().toISOString();
            coordinatorStats.totalFailed += 1;
          }
        }
      }
      store.save();
    } finally {
      activeLocks.delete(params.incidentId);
      const rerun = needsRerun.get(params.incidentId);
      if (rerun) {
        needsRerun.delete(params.incidentId);
        scheduleAutomaticReassessment({
          incidentId: params.incidentId,
          ...rerun,
          debounceMs: 50,
        });
      }
    }
  };

  const timer = setTimeout(() => {
    void executeJob();
  }, debounceMs);

  pendingTimers.set(params.incidentId, { timer, jobId: job.id });
  return job;
}
