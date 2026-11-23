import { v4 as uuidv4 } from 'uuid';
import type {
  Allocation,
  AllocationLineItem,
  DataMode,
  DuplicateMatch,
  FreshnessStatus,
  Incident,
  IncidentStatus,
  IncidentType,
  InventoryStock,
  PredictionRecord,
  PriorityBreakdown,
  ReliefRequest,
  RiskAssessment,
  RiskAssessmentStatus,
  RiskBand,
  RiskChangeComparison,
  RiskFactorValue,
  RouteResult,
  Severity,
  SeverityLevelNumber,
  Warehouse,
  WeatherFreshnessCode,
  WeatherObservation,
  WeatherRiskResult,
} from '../src/shared/types.ts';
import { DEFAULT_RISK_WEIGHTS, store } from './store.ts';

// ============================================================================
// 1. GEOSPATIAL, VALIDATION, STATUS TRANSITIONS & DUPLICATE DETECTION ENGINE
// ============================================================================

export const SEVERITY_TO_LEVEL: Record<Severity, SeverityLevelNumber> = {
  low: 1,
  medium: 2,
  high: 4,
  critical: 5,
};

export function severityToLevel(sev: Severity): SeverityLevelNumber {
  return SEVERITY_TO_LEVEL[sev];
}

export function levelToSeverity(level: number): Severity {
  if (level >= 5) return 'critical';
  if (level === 4) return 'high';
  if (level >= 2) return 'medium';
  return 'low';
}

export const INCIDENT_STATUS_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  reported: ['under_review', 'verified', 'active', 'escalated', 'resolved', 'archived'],
  under_review: ['verified', 'active', 'escalated', 'resolved', 'archived'],
  verified: ['active', 'escalated', 'contained', 'resolved', 'archived'],
  active: ['escalated', 'contained', 'resolved', 'archived'],
  escalated: ['active', 'contained', 'resolved', 'archived'],
  contained: ['active', 'escalated', 'resolved', 'archived'],
  resolved: ['active', 'under_review', 'archived'],
  archived: ['under_review', 'active'],
};

export function isValidIncidentTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  if (from === to) return true;
  return (INCIDENT_STATUS_TRANSITIONS[from] || []).includes(to);
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100;
}

export function validateCoordinates(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export function analyzeCoordinates(lat: number, lng: number, region?: string): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  if (!validateCoordinates(lat, lng)) {
    return { valid: false, warnings: ['Coordinates fall outside valid WGS-84 bounds (lat -90..90, lng -180..180).'] };
  }
  if (lat === 0 && lng === 0) {
    warnings.push('Coordinates are (0, 0) Null Island — verify GPS fix before relying on spatial intelligence.');
  }
  // Heuristic check for commonly swapped lat/lng in South/East Asia or high-longitude regions
  const reg = (region || '').toLowerCase();
  if (
    (reg.includes('india') || reg.includes('tamil') || reg.includes('chennai') || reg.includes('chengalpattu') || reg.includes('kancheepuram')) &&
    (lat > 40 || lng < 60)
  ) {
    warnings.push('Coordinates may have latitude/longitude swapped or fall outside the stated region — verify location pin.');
  }
  return { valid: true, warnings };
}

export function detectDetailedDuplicates(
  candidate: {
    id?: string;
    type: IncidentType | string;
    lat: number;
    lng: number;
    title: string;
    reportedAt?: string;
    mode: DataMode;
  },
  existingIncidents: Incident[]
): DuplicateMatch[] {
  const windowMinutes = 24 * 60; // 24 hours
  const candidateTime = candidate.reportedAt ? new Date(candidate.reportedAt).getTime() : Date.now();
  const titleWords = new Set(
    candidate.title
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3)
  );

  const matches: DuplicateMatch[] = [];

  for (const inc of existingIncidents) {
    if (candidate.id && inc.id === candidate.id) continue;
    if (inc.mode !== candidate.mode) continue;
    if (inc.status === 'resolved' || inc.status === 'archived') continue;

    const distanceKm = haversineKm(candidate.lat, candidate.lng, inc.lat, inc.lng);
    const timeDiffMinutes = Math.round(Math.abs(candidateTime - new Date(inc.reportedAt).getTime()) / 60_000);
    const incWords = inc.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const overlapWords = incWords.filter((w) => titleWords.has(w));
    const sameType = inc.type === candidate.type;

    const similarityFactors: string[] = [];
    if (sameType) similarityFactors.push(`Matching incident type (${inc.type})`);
    if (distanceKm <= 5) similarityFactors.push(`Very close geographic proximity (${distanceKm} km)`);
    else if (distanceKm <= 15) similarityFactors.push(`Same operational vicinity (${distanceKm} km)`);
    if (timeDiffMinutes <= 180) similarityFactors.push(`Reported within ${timeDiffMinutes} minutes`);
    else if (timeDiffMinutes <= windowMinutes) similarityFactors.push(`Reported within 24h window (${Math.round(timeDiffMinutes / 60)}h apart)`);
    if (overlapWords.length >= 2) similarityFactors.push(`Shared title keywords: ${overlapWords.slice(0, 4).join(', ')}`);

    const isMatch =
      (sameType && distanceKm <= 12 && timeDiffMinutes <= windowMinutes) ||
      (distanceKm <= 4 && overlapWords.length >= 2);

    if (isMatch) {
      const likelihood: DuplicateMatch['likelihood'] =
        sameType && distanceKm <= 3 && timeDiffMinutes <= 180
          ? 'high'
          : (sameType && distanceKm <= 8) || overlapWords.length >= 3
          ? 'medium'
          : 'low';

      matches.push({
        duplicateIncidentId: inc.id,
        title: inc.title,
        type: inc.type,
        status: inc.status,
        distanceKm,
        timeDiffMinutes,
        similarityFactors,
        likelihood,
        recommendation:
          likelihood === 'high'
            ? 'Commander review recommended: consider linking as a field report under the existing incident rather than tracking separately.'
            : 'Review geographic overlap and timeline; confirm whether this represents a distinct impact zone.',
      });
    }
  }

  return matches.sort((a, b) => a.distanceKm - b.distanceKm);
}

export function detectPossibleDuplicates(
  candidate: { type: string; lat: number; lng: number; title: string; mode: DataMode },
  existingIncidents: Incident[]
): string[] {
  return detectDetailedDuplicates(candidate, existingIncidents).map((m) => m.duplicateIncidentId);
}

export function findNearestWarehouses(lat: number, lng: number, mode: DataMode, limit = 5) {
  return store.state.warehouses
    .filter((w) => w.mode === mode)
    .map((w) => ({
      warehouse: w,
      distanceKm: haversineKm(lat, lng, w.lat, w.lng),
      stockItems: store.state.inventory.filter((inv) => inv.warehouseId === w.id && inv.mode === mode).length,
      totalAvailableUnits: store.state.inventory
        .filter((inv) => inv.warehouseId === w.id && inv.mode === mode)
        .reduce((acc, item) => acc + item.availableQty, 0),
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}

// ============================================================================
// 2. DATA FRESHNESS ENGINE
// ============================================================================

export function computeFreshness(timestampIso: string | null, limitSeconds: number): FreshnessStatus {
  if (!timestampIso) return 'missing';
  const ageSec = (Date.now() - new Date(timestampIso).getTime()) / 1000;
  if (ageSec <= limitSeconds) return 'fresh';
  if (ageSec <= limitSeconds * 2) return 'delayed';
  return 'stale';
}

export function toWeatherFreshnessCode(status: FreshnessStatus, dataQuality?: string): WeatherFreshnessCode {
  if (dataQuality === 'invalid') return 'INVALID';
  if (status === 'outage' || status === 'missing') return 'UNAVAILABLE';
  if (status === 'stale' || status === 'delayed') return 'STALE';
  return 'FRESH';
}

// ============================================================================
// 3. WEATHER & ENVIRONMENTAL INTELLIGENCE (Open-Meteo + Dedup + Modular Risk)
// ============================================================================

export const WEATHER_UNAVAILABLE_NOTICE =
  'Weather data unavailable — displaying last available observation, if any.';

const WMO_CODES: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  71: 'Slight snow',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

const WEATHER_RULE_VERSION = 'weather-risk-v2.0';

// Provider telemetry, circuit breaker & in-flight deduplication map
const weatherInFlight = new Map<string, Promise<WeatherObservation>>();
let weatherConsecutiveFailures = 0;
let weatherCircuitOpenUntil = 0;
const weatherProviderStats = {
  provider: 'Open-Meteo REST API',
  endpoint: 'https://api.open-meteo.com/v1/forecast',
  totalRequests: 0,
  cacheHits: 0,
  dedupedHits: 0,
  failedRequests: 0,
  lastSuccessAt: null as string | null,
  lastFailureAt: null as string | null,
  lastError: null as string | null,
  lastLatencyMs: null as number | null,
};

export function getWeatherProviderStatus() {
  const freshnessLimit = store.state.settings.weatherFreshnessSeconds;
  const freshCached = store.state.weatherObservations.filter(
    (w) => computeFreshness(w.fetchTimestamp, freshnessLimit) === 'fresh'
  ).length;
  const health = store.state.integrations.find((i) => i.id === 'int-weather');
  const circuitOpen = weatherCircuitOpenUntil > Date.now();
  return {
    provider: weatherProviderStats.provider,
    status: circuitOpen ? 'degraded' : health?.status || 'healthy',
    circuitOpen,
    totalRequests: weatherProviderStats.totalRequests,
    cacheHits: weatherProviderStats.cacheHits,
    dedupedHits: weatherProviderStats.dedupedHits,
    failedRequests: weatherProviderStats.failedRequests,
    cachedObservations: store.state.weatherObservations.length,
    freshCachedObservations: freshCached,
    inFlightRequests: weatherInFlight.size,
    freshnessLimitSeconds: freshnessLimit,
    lastSuccessAt: weatherProviderStats.lastSuccessAt || health?.lastSuccessAt || null,
    lastFailureAt: weatherProviderStats.lastFailureAt,
    lastError: weatherProviderStats.lastError || health?.lastError || null,
    lastLatencyMs: weatherProviderStats.lastLatencyMs ?? health?.latencyMs ?? null,
    ruleVersion: WEATHER_RULE_VERSION,
  };
}

// ============================================================================
// 3A. MODULAR PROVIDER-INDEPENDENT WEATHER RISK CALCULATORS
// ============================================================================

export function calculateFloodWeatherRisk(weather: WeatherObservation | null): WeatherRiskResult {
  const unavailableFactors: string[] = [];
  const triggeredRules: string[] = [];
  const evidence: string[] = [];

  if (!weather || weather.freshnessStatus === 'outage' || weather.freshnessStatus === 'missing') {
    return {
      hazardType: 'flood',
      score: null,
      level: 'INSUFFICIENT_DATA',
      ruleVersion: WEATHER_RULE_VERSION,
      triggeredRules: [],
      unavailableFactors: ['Current rainfall (mm/hr)', 'Forecast precipitation accumulation (24h)'],
      evidence: [],
      explanation: 'Cannot evaluate flood weather risk — live meteorological telemetry unavailable.',
    };
  }

  const rainNow = weather.rainfallMm ?? weather.precipitationMm;
  const forecastPrecipValues = (weather.forecastSummary || [])
    .map((f) => f.precipMm)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const dailyPrecipValues = (weather.dailyForecast || [])
    .map((d) => d.precipSumMm)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  if (rainNow === null) unavailableFactors.push('Current rainfall intensity (mm/hr)');
  if (forecastPrecipValues.length === 0 && dailyPrecipValues.length === 0) {
    unavailableFactors.push('Forecast precipitation accumulation');
  }

  if (rainNow === null && forecastPrecipValues.length === 0 && dailyPrecipValues.length === 0) {
    return {
      hazardType: 'flood',
      score: null,
      level: 'INSUFFICIENT_DATA',
      ruleVersion: WEATHER_RULE_VERSION,
      triggeredRules,
      unavailableFactors,
      evidence,
      explanation: 'Insufficient rainfall and forecast data to score flood weather risk.',
    };
  }

  let score = 8;
  if (rainNow !== null) {
    evidence.push(`Current rainfall/precipitation: ${rainNow.toFixed(1)} mm/hr`);
    if (rainNow >= 30) {
      score += 62;
      triggeredRules.push(`Extreme rainfall intensity >= 30 mm/hr (${rainNow.toFixed(1)} mm/hr)`);
    } else if (rainNow >= 10) {
      score += 42;
      triggeredRules.push(`Heavy rainfall intensity >= 10 mm/hr (${rainNow.toFixed(1)} mm/hr)`);
    } else if (rainNow >= 2.5) {
      score += 20;
      triggeredRules.push(`Moderate rainfall intensity >= 2.5 mm/hr (${rainNow.toFixed(1)} mm/hr)`);
    }
  }

  const forecastSum =
    dailyPrecipValues.length > 0
      ? dailyPrecipValues[0]
      : forecastPrecipValues.reduce((acc, v) => acc + v, 0);
  if (forecastPrecipValues.length > 0 || dailyPrecipValues.length > 0) {
    evidence.push(`Projected 24h precipitation accumulation: ${forecastSum.toFixed(1)} mm`);
    if (forecastSum >= 100) {
      score += 32;
      triggeredRules.push(`24h rainfall accumulation >= 100 mm (${forecastSum.toFixed(1)} mm)`);
    } else if (forecastSum >= 50) {
      score += 22;
      triggeredRules.push(`24h rainfall accumulation >= 50 mm (${forecastSum.toFixed(1)} mm)`);
    } else if (forecastSum >= 20) {
      score += 10;
      triggeredRules.push(`24h rainfall accumulation >= 20 mm (${forecastSum.toFixed(1)} mm)`);
    }
  }

  const finalScore = Math.min(100, Math.round(score));
  return {
    hazardType: 'flood',
    score: finalScore,
    level: scoreToRiskBand(finalScore),
    ruleVersion: WEATHER_RULE_VERSION,
    triggeredRules,
    unavailableFactors,
    evidence,
    explanation:
      triggeredRules.length > 0
        ? `Flood weather risk ${finalScore}/100 (${scoreToRiskBand(finalScore)}): ${triggeredRules.join('; ')}.`
        : `Flood weather risk ${finalScore}/100 (${scoreToRiskBand(finalScore)}): precipitation within nominal range.`,
  };
}

export function calculateHeatWeatherRisk(weather: WeatherObservation | null): WeatherRiskResult {
  const unavailableFactors: string[] = [];
  const triggeredRules: string[] = [];
  const evidence: string[] = [];

  if (!weather || weather.freshnessStatus === 'outage' || weather.freshnessStatus === 'missing') {
    return {
      hazardType: 'heat',
      score: null,
      level: 'INSUFFICIENT_DATA',
      ruleVersion: WEATHER_RULE_VERSION,
      triggeredRules: [],
      unavailableFactors: ['Air temperature (°C)', 'Apparent temperature (°C)', 'Relative humidity (%)'],
      evidence: [],
      explanation: 'Cannot evaluate heat weather risk — meteorological data unavailable.',
    };
  }

  if (weather.temperatureC === null && weather.feelsLikeC === null) {
    return {
      hazardType: 'heat',
      score: null,
      level: 'INSUFFICIENT_DATA',
      ruleVersion: WEATHER_RULE_VERSION,
      triggeredRules: [],
      unavailableFactors: ['Air temperature (°C)', 'Apparent temperature (°C)'],
      evidence: [],
      explanation: 'Missing temperature readings; heat risk cannot be computed.',
    };
  }

  const effectiveTemp = weather.feelsLikeC ?? weather.temperatureC!;
  if (weather.temperatureC !== null) evidence.push(`Air temperature: ${weather.temperatureC.toFixed(1)}°C`);
  if (weather.feelsLikeC !== null) evidence.push(`Apparent temperature: ${weather.feelsLikeC.toFixed(1)}°C`);
  else unavailableFactors.push('Apparent temperature (°C)');
  if (weather.humidityPct !== null) evidence.push(`Relative humidity: ${weather.humidityPct.toFixed(0)}%`);
  else unavailableFactors.push('Relative humidity (%)');

  let score = 10;
  if (effectiveTemp >= 45) {
    score = 92;
    triggeredRules.push(`Extreme heat hazard >= 45°C apparent (${effectiveTemp.toFixed(1)}°C)`);
  } else if (effectiveTemp >= 41) {
    score = 74;
    triggeredRules.push(`Severe heat stress >= 41°C apparent (${effectiveTemp.toFixed(1)}°C)`);
  } else if (effectiveTemp >= 37) {
    score = 52;
    triggeredRules.push(`Elevated heat advisory >= 37°C apparent (${effectiveTemp.toFixed(1)}°C)`);
  } else if (effectiveTemp >= 33) {
    score = 30;
  }

  if (weather.humidityPct !== null && weather.humidityPct >= 75 && effectiveTemp >= 35) {
    score = Math.min(100, score + 10);
    triggeredRules.push(`Compounding high humidity (${weather.humidityPct.toFixed(0)}%) with elevated heat`);
  }

  return {
    hazardType: 'heat',
    score,
    level: scoreToRiskBand(score),
    ruleVersion: WEATHER_RULE_VERSION,
    triggeredRules,
    unavailableFactors,
    evidence,
    explanation:
      triggeredRules.length > 0
        ? `Heat weather risk ${score}/100 (${scoreToRiskBand(score)}): ${triggeredRules.join('; ')}.`
        : `Heat weather risk ${score}/100 (${scoreToRiskBand(score)}): thermal conditions within nominal range.`,
  };
}

export function calculateWindWeatherRisk(weather: WeatherObservation | null): WeatherRiskResult {
  const unavailableFactors: string[] = [];
  const triggeredRules: string[] = [];
  const evidence: string[] = [];

  if (!weather || weather.freshnessStatus === 'outage' || weather.freshnessStatus === 'missing') {
    return {
      hazardType: 'wind',
      score: null,
      level: 'INSUFFICIENT_DATA',
      ruleVersion: WEATHER_RULE_VERSION,
      triggeredRules: [],
      unavailableFactors: ['Sustained wind speed (km/h)', 'Wind gusts (km/h)'],
      evidence: [],
      explanation: 'Cannot evaluate wind weather risk — meteorological data unavailable.',
    };
  }

  if (weather.windSpeedKmh === null && (weather.windGustKmh === null || weather.windGustKmh === undefined)) {
    return {
      hazardType: 'wind',
      score: null,
      level: 'INSUFFICIENT_DATA',
      ruleVersion: WEATHER_RULE_VERSION,
      triggeredRules: [],
      unavailableFactors: ['Sustained wind speed (km/h)', 'Wind gusts (km/h)'],
      evidence: [],
      explanation: 'Missing wind speed and gust readings.',
    };
  }

  const wind = weather.windSpeedKmh ?? 0;
  const gust = weather.windGustKmh ?? null;
  if (weather.windSpeedKmh !== null) evidence.push(`Sustained wind: ${weather.windSpeedKmh.toFixed(1)} km/h`);
  else unavailableFactors.push('Sustained wind speed (km/h)');
  if (gust !== null) evidence.push(`Wind gusts: ${gust.toFixed(1)} km/h`);
  else unavailableFactors.push('Wind gusts (km/h)');

  const peakWind = Math.max(wind, gust ?? 0);
  let score = 10;
  if (peakWind >= 90) {
    score = 92;
    triggeredRules.push(`Destructive storm-force winds >= 90 km/h (${peakWind.toFixed(1)} km/h)`);
  } else if (peakWind >= 65) {
    score = 72;
    triggeredRules.push(`Severe wind hazard >= 65 km/h (${peakWind.toFixed(1)} km/h)`);
  } else if (peakWind >= 45) {
    score = 48;
    triggeredRules.push(`High wind advisory >= 45 km/h (${peakWind.toFixed(1)} km/h)`);
  } else if (peakWind >= 28) {
    score = 26;
  }

  return {
    hazardType: 'wind',
    score,
    level: scoreToRiskBand(score),
    ruleVersion: WEATHER_RULE_VERSION,
    triggeredRules,
    unavailableFactors,
    evidence,
    explanation:
      triggeredRules.length > 0
        ? `Wind weather risk ${score}/100 (${scoreToRiskBand(score)}): ${triggeredRules.join('; ')}.`
        : `Wind weather risk ${score}/100 (${scoreToRiskBand(score)}): winds within nominal range.`,
  };
}

export function calculateStormWeatherRisk(weather: WeatherObservation | null): WeatherRiskResult {
  const flood = calculateFloodWeatherRisk(weather);
  const wind = calculateWindWeatherRisk(weather);
  const unavailableFactors = Array.from(new Set([...flood.unavailableFactors, ...wind.unavailableFactors]));
  const triggeredRules = [...flood.triggeredRules, ...wind.triggeredRules];
  const evidence = [...flood.evidence, ...wind.evidence];

  if (flood.score === null && wind.score === null) {
    return {
      hazardType: 'storm',
      score: null,
      level: 'INSUFFICIENT_DATA',
      ruleVersion: WEATHER_RULE_VERSION,
      triggeredRules: [],
      unavailableFactors,
      evidence: [],
      explanation: 'Insufficient meteorological inputs to score storm risk.',
    };
  }

  const code = weather?.weatherCode ?? null;
  let stormBonus = 0;
  if (code !== null && code >= 95) {
    stormBonus = 22;
    triggeredRules.push(`Active convective thunderstorm WMO code ${code} (${weather?.condition})`);
    evidence.push(`Weather condition code: ${code} (${weather?.condition})`);
  }

  const base =
    flood.score !== null && wind.score !== null
      ? Math.round(Math.max(flood.score, wind.score) * 0.65 + ((flood.score + wind.score) / 2) * 0.35)
      : flood.score ?? wind.score ?? 0;

  const finalScore = Math.min(100, base + stormBonus);
  return {
    hazardType: 'storm',
    score: finalScore,
    level: scoreToRiskBand(finalScore),
    ruleVersion: WEATHER_RULE_VERSION,
    triggeredRules,
    unavailableFactors,
    evidence,
    explanation:
      triggeredRules.length > 0
        ? `Storm weather risk ${finalScore}/100 (${scoreToRiskBand(finalScore)}): ${triggeredRules.join('; ')}.`
        : `Storm weather risk ${finalScore}/100 (${scoreToRiskBand(finalScore)}): no severe storm triggers active.`,
  };
}

export function calculateGeneralEnvironmentalRisk(weather: WeatherObservation | null): WeatherRiskResult {
  const flood = calculateFloodWeatherRisk(weather);
  const heat = calculateHeatWeatherRisk(weather);
  const wind = calculateWindWeatherRisk(weather);
  const storm = calculateStormWeatherRisk(weather);

  const validScores = [flood.score, heat.score, wind.score, storm.score].filter(
    (s): s is number => s !== null
  );
  const unavailableFactors = Array.from(
    new Set([...flood.unavailableFactors, ...heat.unavailableFactors, ...wind.unavailableFactors])
  );
  const triggeredRules = Array.from(
    new Set([...flood.triggeredRules, ...heat.triggeredRules, ...wind.triggeredRules, ...storm.triggeredRules])
  );
  const evidence = Array.from(new Set([...flood.evidence, ...heat.evidence, ...wind.evidence]));

  if (validScores.length === 0) {
    return {
      hazardType: 'general',
      score: null,
      level: 'INSUFFICIENT_DATA',
      ruleVersion: WEATHER_RULE_VERSION,
      triggeredRules: [],
      unavailableFactors,
      evidence: [],
      explanation: 'Insufficient meteorological inputs to evaluate environmental exposure.',
    };
  }

  const maxScore = Math.max(...validScores);
  const avgScore = validScores.reduce((a, b) => a + b, 0) / validScores.length;
  const finalScore = Math.min(100, Math.round(maxScore * 0.72 + avgScore * 0.28));

  return {
    hazardType: 'general',
    score: finalScore,
    level: scoreToRiskBand(finalScore),
    ruleVersion: WEATHER_RULE_VERSION,
    triggeredRules,
    unavailableFactors,
    evidence,
    explanation:
      triggeredRules.length > 0
        ? `General environmental exposure ${finalScore}/100 (${scoreToRiskBand(finalScore)}): ${triggeredRules.join('; ')}.`
        : `General environmental exposure ${finalScore}/100 (${scoreToRiskBand(finalScore)}): nominal meteorological conditions.`,
  };
}

export function calculateIncidentWeatherRisk(incidentType: IncidentType, weather: WeatherObservation | null): WeatherRiskResult {
  if (incidentType === 'flood' || incidentType === 'flash_flood' || incidentType === 'landslide') {
    return calculateFloodWeatherRisk(weather);
  }
  if (incidentType === 'heatwave' || incidentType === 'wildfire') {
    return calculateHeatWeatherRisk(weather);
  }
  if (incidentType === 'cyclone' || incidentType === 'severe_storm') {
    return calculateStormWeatherRisk(weather);
  }
  if (incidentType === 'power_failure') {
    return calculateWindWeatherRisk(weather);
  }
  return calculateGeneralEnvironmentalRisk(weather);
}

function evaluateWeatherTriggers(obs: {
  rainfallMm: number | null;
  precipitationMm: number | null;
  windSpeedKmh: number | null;
  windGustKmh?: number | null;
  temperatureC: number | null;
}): { triggers: string[]; classification: RiskBand; explanation: string } {
  const triggers: string[] = [];
  let score = 10;

  const rain =
    obs.rainfallMm !== null || obs.precipitationMm !== null
      ? Math.max(obs.rainfallMm ?? 0, obs.precipitationMm ?? 0)
      : null;
  if (rain !== null) {
    if (rain >= 30) {
      triggers.push(`Extreme rainfall rule crossed (${rain.toFixed(1)} mm/hr >= 30 mm/hr system threshold)`);
      score += 55;
    } else if (rain >= 10) {
      triggers.push(`Heavy rainfall rule crossed (${rain.toFixed(1)} mm/hr >= 10 mm/hr system threshold)`);
      score += 32;
    } else if (rain >= 2.5) {
      triggers.push(`Moderate precipitation detected (${rain.toFixed(1)} mm/hr)`);
      score += 15;
    }
  }

  const wind = obs.windSpeedKmh !== null ? Math.max(obs.windSpeedKmh, obs.windGustKmh ?? 0) : null;
  if (wind !== null) {
    if (wind >= 75) {
      triggers.push(`Severe storm wind rule crossed (${wind.toFixed(1)} km/h >= 75 km/h system threshold)`);
      score += 40;
    } else if (wind >= 45) {
      triggers.push(`High wind advisory threshold (${wind.toFixed(1)} km/h >= 45 km/h)`);
      score += 22;
    }
  }

  const temp = obs.temperatureC;
  if (temp !== null) {
    if (temp >= 42) {
      triggers.push(`Extreme heat rule crossed (${temp.toFixed(1)}°C >= 42°C system threshold)`);
      score += 35;
    } else if (temp >= 38) {
      triggers.push(`Heat stress advisory (${temp.toFixed(1)}°C >= 38°C)`);
      score += 18;
    }
  }

  const band = scoreToRiskBand(Math.min(100, score));
  const explanation =
    triggers.length > 0
      ? `Rule-based environmental triggers active (system thresholds, not official met-agency declarations): ${triggers.join('; ')}.`
      : 'Current meteorological readings are within nominal system thresholds.';

  return { triggers, classification: band, explanation };
}

export async function fetchLiveWeather(
  lat: number,
  lng: number,
  locationName: string,
  options?: { forceRefresh?: boolean; simulateOutage?: boolean }
): Promise<WeatherObservation> {
  const freshnessLimit = store.state.settings.weatherFreshnessSeconds;
  weatherProviderStats.totalRequests += 1;

  // Coordinate-rounded deduplication key (~1.1 km grid)
  const dedupKey = `${lat.toFixed(2)},${lng.toFixed(2)}`;

  if (!options?.forceRefresh && !options?.simulateOutage) {
    const cached = store.state.weatherObservations.find(
      (w) =>
        haversineKm(w.lat, w.lng, lat, lng) < 2 &&
        computeFreshness(w.fetchTimestamp, freshnessLimit) === 'fresh' &&
        w.freshnessStatus !== 'outage'
    );
    if (cached) {
      weatherProviderStats.cacheHits += 1;
      const ageSec = Math.max(0, Math.round((Date.now() - new Date(cached.fetchTimestamp).getTime()) / 1000));
      const fStatus = computeFreshness(cached.fetchTimestamp, freshnessLimit);
      return {
        ...cached,
        freshnessStatus: fStatus,
        freshnessCode: toWeatherFreshnessCode(fStatus, cached.dataQuality),
        cacheAgeSeconds: ageSec,
      };
    }

    const existingPromise = weatherInFlight.get(dedupKey);
    if (existingPromise) {
      weatherProviderStats.dedupedHits += 1;
      return existingPromise;
    }
  }

  const runFetch = async (): Promise<WeatherObservation> => {
    const started = Date.now();
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(
      4
    )}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,surface_pressure&hourly=temperature_2m,precipitation,precipitation_probability,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max&forecast_days=3&timezone=auto`;

    let lastErr: unknown = null;
    const circuitOpen = weatherCircuitOpenUntil > Date.now();
    if (!options?.simulateOutage && !circuitOpen) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 7000);
        try {
          const resp = await fetch(url, { signal: controller.signal });
          clearTimeout(timer);
          if (!resp.ok) throw new Error(`Open-Meteo HTTP ${resp.status}`);
          weatherConsecutiveFailures = 0;
          weatherCircuitOpenUntil = 0;
          const json = (await resp.json()) as any;
          const cur = json.current || {};
          const hourly = json.hourly || {};
          const daily = json.daily || {};

          const forecastSummary: WeatherObservation['forecastSummary'] = [];
          const times: string[] = hourly.time || [];
          for (let i = 0; i < Math.min(times.length, 24); i += 2) {
            forecastSummary.push({
              time: times[i],
              tempC: typeof hourly.temperature_2m?.[i] === 'number' ? hourly.temperature_2m[i] : null,
              precipMm: typeof hourly.precipitation?.[i] === 'number' ? hourly.precipitation[i] : null,
              windKmh: typeof hourly.wind_speed_10m?.[i] === 'number' ? hourly.wind_speed_10m[i] : null,
              precipProbPct:
                typeof hourly.precipitation_probability?.[i] === 'number'
                  ? hourly.precipitation_probability[i]
                  : null,
            });
          }

          const dailyForecast: NonNullable<WeatherObservation['dailyForecast']> = [];
          const dailyDates: string[] = daily.time || [];
          for (let i = 0; i < Math.min(dailyDates.length, 3); i++) {
            dailyForecast.push({
              date: dailyDates[i],
              tempMaxC: typeof daily.temperature_2m_max?.[i] === 'number' ? daily.temperature_2m_max[i] : null,
              tempMinC: typeof daily.temperature_2m_min?.[i] === 'number' ? daily.temperature_2m_min[i] : null,
              precipSumMm: typeof daily.precipitation_sum?.[i] === 'number' ? daily.precipitation_sum[i] : null,
              windMaxKmh: typeof daily.wind_speed_10m_max?.[i] === 'number' ? daily.wind_speed_10m_max[i] : null,
            });
          }

          const rainfallMm = typeof cur.rain === 'number' && Number.isFinite(cur.rain) ? cur.rain : null;
          const precipitationMm =
            typeof cur.precipitation === 'number' && Number.isFinite(cur.precipitation) ? cur.precipitation : null;
          const windSpeedKmh =
            typeof cur.wind_speed_10m === 'number' && Number.isFinite(cur.wind_speed_10m) ? cur.wind_speed_10m : null;
          const windGustKmh =
            typeof cur.wind_gusts_10m === 'number' && Number.isFinite(cur.wind_gusts_10m) ? cur.wind_gusts_10m : null;
          const temperatureC =
            typeof cur.temperature_2m === 'number' && Number.isFinite(cur.temperature_2m) ? cur.temperature_2m : null;
          const pressureHpa =
            typeof cur.surface_pressure === 'number' && Number.isFinite(cur.surface_pressure)
              ? cur.surface_pressure
              : null;
          const weatherCode = typeof cur.weather_code === 'number' ? cur.weather_code : null;

          // Validate physical plausibility
          const isPhysicallyInvalid =
            (temperatureC !== null && (temperatureC < -90 || temperatureC > 65)) ||
            (windSpeedKmh !== null && (windSpeedKmh < 0 || windSpeedKmh > 450)) ||
            (rainfallMm !== null && rainfallMm < 0);

          const evalRes = evaluateWeatherTriggers({
            rainfallMm,
            precipitationMm,
            windSpeedKmh,
            windGustKmh,
            temperatureC,
          });
          const fetchTimestamp = new Date().toISOString();
          const dataQuality: WeatherObservation['dataQuality'] = isPhysicallyInvalid
            ? 'invalid'
            : temperatureC !== null && windSpeedKmh !== null
            ? 'valid'
            : 'partial';

          const obs: WeatherObservation = {
            id: uuidv4(),
            provider: 'Open-Meteo',
            sourceType: 'live_api',
            locationName,
            lat,
            lng,
            temperatureC,
            feelsLikeC: typeof cur.apparent_temperature === 'number' ? cur.apparent_temperature : null,
            rainfallMm,
            precipitationMm,
            windSpeedKmh,
            windGustKmh,
            windDirectionDeg: typeof cur.wind_direction_10m === 'number' ? cur.wind_direction_10m : null,
            humidityPct: typeof cur.relative_humidity_2m === 'number' ? cur.relative_humidity_2m : null,
            pressureHpa,
            weatherCode,
            condition: weatherCode !== null ? WMO_CODES[weatherCode] || 'Observed Conditions' : 'Observed Conditions',
            severeTriggers: evalRes.triggers,
            riskClassification: evalRes.classification,
            explanation: evalRes.explanation,
            dataTimestamp: cur.time ? new Date(cur.time).toISOString() : fetchTimestamp,
            fetchTimestamp,
            freshnessLimitSeconds: freshnessLimit,
            freshnessStatus: isPhysicallyInvalid ? 'partial' : 'fresh',
            freshnessCode: isPhysicallyInvalid ? 'INVALID' : 'FRESH',
            cacheAgeSeconds: 0,
            dataQuality,
            forecastSummary,
            dailyForecast,
          };

          obs.weatherRisk = calculateGeneralEnvironmentalRisk(obs);

          store.state.weatherObservations.unshift(obs);
          if (store.state.weatherObservations.length > 80) {
            store.state.weatherObservations.length = 80;
          }
          const latency = Date.now() - started;
          weatherProviderStats.lastSuccessAt = fetchTimestamp;
          weatherProviderStats.lastError = null;
          weatherProviderStats.lastLatencyMs = latency;

          store.updateIntegrationHealth('int-weather', {
            status: 'healthy',
            lastSuccessAt: fetchTimestamp,
            lastError: null,
            latencyMs: latency,
          });
          store.save();
          return obs;
        } catch (err) {
          clearTimeout(timer);
          lastErr = err;
          // Bounded exponential backoff with jitter to prevent retry storms
          const jitterMs = Math.floor(Math.random() * 150);
          await new Promise((r) => setTimeout(r, 250 * Math.pow(2, attempt) + jitterMs));
        }
      }
      weatherConsecutiveFailures += 1;
      if (weatherConsecutiveFailures >= 4) {
        weatherCircuitOpenUntil = Date.now() + 30_000;
      }
    } else if (circuitOpen) {
      lastErr = new Error('Weather provider circuit breaker open after repeated upstream failures; serving cached/unavailable status.');
    } else {
      lastErr = new Error('Simulated weather provider outage for resilience verification');
    }

    // Graceful fallback to last stored observation (explicitly marked STALE!)
    const errMsg = lastErr instanceof Error ? lastErr.message : 'Weather provider timeout';
    weatherProviderStats.failedRequests += 1;
    weatherProviderStats.lastFailureAt = new Date().toISOString();
    weatherProviderStats.lastError = errMsg;

    store.updateIntegrationHealth('int-weather', {
      status: 'degraded',
      lastError: errMsg,
    });

    const lastKnown = store.state.weatherObservations.find(
      (w) => haversineKm(w.lat, w.lng, lat, lng) < 25 && w.freshnessStatus !== 'outage'
    );
    if (lastKnown) {
      const ageSec = Math.max(0, Math.round((Date.now() - new Date(lastKnown.fetchTimestamp).getTime()) / 1000));
      return {
        ...lastKnown,
        sourceType: 'cached_fallback',
        freshnessStatus: 'stale',
        freshnessCode: 'STALE',
        cacheAgeSeconds: ageSec,
        unavailableNotice: WEATHER_UNAVAILABLE_NOTICE,
        explanation: `${WEATHER_UNAVAILABLE_NOTICE} Last cached reading from ${lastKnown.fetchTimestamp} (STALE).`,
      };
    }

    const now = new Date().toISOString();
    return {
      id: uuidv4(),
      provider: 'Open-Meteo (Unavailable)',
      sourceType: 'cached_fallback',
      locationName,
      lat,
      lng,
      temperatureC: null,
      feelsLikeC: null,
      rainfallMm: null,
      precipitationMm: null,
      windSpeedKmh: null,
      windGustKmh: null,
      windDirectionDeg: null,
      humidityPct: null,
      pressureHpa: null,
      weatherCode: null,
      condition: 'DATA NOT AVAILABLE',
      severeTriggers: [],
      riskClassification: 'Guarded',
      explanation: WEATHER_UNAVAILABLE_NOTICE,
      unavailableNotice: WEATHER_UNAVAILABLE_NOTICE,
      dataTimestamp: now,
      fetchTimestamp: now,
      freshnessLimitSeconds: freshnessLimit,
      freshnessStatus: 'outage',
      freshnessCode: 'UNAVAILABLE',
      cacheAgeSeconds: 0,
      dataQuality: 'unavailable',
      weatherRisk: calculateGeneralEnvironmentalRisk(null),
      forecastSummary: [],
      dailyForecast: [],
    };
  };

  const promise = runFetch().finally(() => {
    weatherInFlight.delete(dedupKey);
  });
  if (!options?.simulateOutage) {
    weatherInFlight.set(dedupKey, promise);
  }
  return promise;
}

// ============================================================================
// 4. DETERMINISTIC INCIDENT RISK SCORING ENGINE v2.0 + RISK CHANGE DETECTION
// ============================================================================

export const RISK_ENGINE_VERSION = 'risk-det-v2.0';
export const RISK_RULE_VERSION = 'phase3-risk-rules-v2.0';

export function scoreToRiskBand(score: number): RiskBand {
  if (score >= 80) return 'Critical';
  if (score >= 60) return 'High';
  if (score >= 40) return 'Elevated';
  if (score >= 20) return 'Guarded';
  return 'Low';
}

const SEVERITY_BASE: Record<Severity, number> = {
  low: 20,
  medium: 48,
  high: 75,
  critical: 95,
};

export interface ComputeRiskOptions {
  assessmentSource?: RiskAssessment['assessmentSource'];
  assessor?: string;
  previousAssessment?: RiskAssessment | null;
  ignoreNearestWarehouse?: boolean;
  customWeights?: Partial<typeof DEFAULT_RISK_WEIGHTS>;
}

export function detectRiskChange(
  previous: RiskAssessment | null | undefined,
  current: RiskAssessment
): RiskChangeComparison {
  if (!previous) {
    return {
      previousAssessmentId: null,
      previousScore: null,
      currentScore: current.overallScore,
      scoreDelta: null,
      previousBand: null,
      currentBand: current.band === 'Insufficient Data' ? null : current.band,
      bandChanged: false,
      criticalThresholdCrossed: current.band === 'Critical',
      significantJump: false,
      confidenceDeteriorated: false,
      changeDrivers: ['Initial deterministic baseline assessment recorded.'],
    };
  }

  const prevScore = previous.overallScore;
  const currScore = current.overallScore;
  const scoreDelta =
    prevScore !== null && currScore !== null ? Math.round((currScore - prevScore) * 10) / 10 : null;
  const prevBand = previous.band === 'Insufficient Data' ? null : previous.band;
  const currBand = current.band === 'Insufficient Data' ? null : current.band;
  const bandChanged = prevBand !== currBand;
  const criticalThresholdCrossed = prevBand !== 'Critical' && currBand === 'Critical';
  const significantJump = scoreDelta !== null && scoreDelta >= 15;
  const confidenceDeteriorated = current.confidenceScore < previous.confidenceScore - 0.12;

  const changeDrivers: string[] = [];
  for (const cf of current.factors) {
    const pf = previous.factors.find((f) => f.key === cf.key);
    if (!pf) continue;
    if (pf.missing && !cf.missing) {
      changeDrivers.push(`${cf.label} telemetry became available (${cf.normalizedScore}/100)`);
    } else if (!pf.missing && cf.missing) {
      changeDrivers.push(`${cf.label} telemetry became unavailable (confidence reduced)`);
    } else if (
      pf.normalizedScore !== null &&
      cf.normalizedScore !== null &&
      Math.abs(cf.normalizedScore - pf.normalizedScore) >= 5
    ) {
      const diff = cf.normalizedScore - pf.normalizedScore;
      changeDrivers.push(
        `${cf.label} ${diff > 0 ? 'increased' : 'decreased'} by ${Math.abs(diff)} pts (${pf.normalizedScore} → ${cf.normalizedScore})`
      );
    }
  }

  if (changeDrivers.length === 0) {
    changeDrivers.push(
      scoreDelta === 0 || scoreDelta === null
        ? 'No material change across scored risk dimensions.'
        : `Overall risk shifted by ${scoreDelta > 0 ? '+' : ''}${scoreDelta} points.`
    );
  }

  return {
    previousAssessmentId: previous.id,
    previousScore: prevScore,
    currentScore: currScore,
    scoreDelta,
    previousBand: prevBand,
    currentBand: currBand,
    bandChanged,
    criticalThresholdCrossed,
    significantJump,
    confidenceDeteriorated,
    changeDrivers,
  };
}

export function computeDeterministicRisk(
  incident: Incident,
  weather: WeatherObservation | null,
  options?: ComputeRiskOptions
): RiskAssessment {
  const weights = {
    ...(store.state.settings.riskWeights || DEFAULT_RISK_WEIGHTS),
    ...(options?.customWeights || {}),
  };

  const modeInventory = store.state.inventory.filter((i) => i.mode === incident.mode);
  const shortageCount = modeInventory.filter((i) => i.availableQty < i.minStock).length;
  const openRequests = store.state.reliefRequests.filter(
    (r) => r.incidentId === incident.id && r.status !== 'closed' && r.status !== 'delivered'
  );

  const missingFactors: string[] = [];

  // 1. SEVERITY_RISK (0.25)
  let severityNorm: number | null = null;
  if (incident.severity && SEVERITY_BASE[incident.severity] !== undefined) {
    severityNorm = incident.severityLevel
      ? Math.min(100, Math.round(incident.severityLevel * 19))
      : SEVERITY_BASE[incident.severity];
  } else {
    missingFactors.push('Incident Severity Level');
  }

  // 2. ENVIRONMENTAL_RISK (0.20) — powered by modular incident-type weather risk calculator
  const weatherRisk = calculateIncidentWeatherRisk(incident.type, weather);
  const envNorm: number | null = weatherRisk.score;
  if (envNorm === null) {
    missingFactors.push('Live Meteorological Telemetry (Weather Provider Unavailable)');
  }

  // 3. HUMAN_IMPACT_RISK (0.20) — never convert missing/unreported population into false 0 when unknown
  let humanImpactRisk: number | null = null;
  if (typeof incident.peopleAffected === 'number' && Number.isFinite(incident.peopleAffected) && incident.peopleAffected > 0) {
    humanImpactRisk = Math.min(
      100,
      Math.round((Math.log10(incident.peopleAffected + 1) / 4.2) * 100)
    );
  } else {
    missingFactors.push('Verified Affected Population Count');
  }

  // 4. VULNERABILITY_RISK (0.15)
  let vulnerabilityRisk: number | null = null;
  if (
    typeof incident.vulnerablePopulation === 'number' &&
    Number.isFinite(incident.vulnerablePopulation) &&
    incident.vulnerablePopulation > 0
  ) {
    const ratio =
      incident.peopleAffected > 0
        ? Math.min(1, incident.vulnerablePopulation / incident.peopleAffected)
        : 0.35;
    vulnerabilityRisk = Math.min(
      100,
      Math.round(ratio * 165 + Math.min(40, Math.log10(incident.vulnerablePopulation + 1) * 14))
    );
  } else if (incident.peopleAffected > 0) {
    // Population known but vulnerable cohort not assessed yet
    missingFactors.push('Vulnerable Population Assessment');
  } else {
    missingFactors.push('Vulnerable Population Assessment');
  }

  // 5. ACCESS_RISK (0.10)
  const nearestWh = options?.ignoreNearestWarehouse
    ? undefined
    : findNearestWarehouses(incident.lat, incident.lng, incident.mode, 1)[0];
  let accessRisk: number | null = null;
  if (nearestWh) {
    accessRisk = Math.min(
      100,
      Math.round(
        (nearestWh.distanceKm / 120) * 58 +
          (nearestWh.warehouse.accessibility === 'restricted'
            ? 35
            : nearestWh.warehouse.accessibility === 'moderate'
            ? 20
            : 8) +
          (['flood', 'flash_flood', 'landslide', 'cyclone'].includes(incident.type) ? 20 : 0)
      )
    );
  } else {
    missingFactors.push('Nearest Operational Warehouse / Access Telemetry');
  }

  // 6. INFRASTRUCTURE_RISK (0.10)
  let infrastructureRisk: number | null = null;
  const infraTypes: IncidentType[] = [
    'power_failure',
    'infrastructure_failure',
    'flash_flood',
    'flood',
    'earthquake',
    'cyclone',
    'chemical_incident',
  ];
  const hasArea = typeof incident.estimatedImpactAreaKm2 === 'number' && incident.estimatedImpactAreaKm2 > 0;
  const hasInfraList = Array.isArray(incident.infrastructureAffected) && incident.infrastructureAffected.length > 0;
  if (severityNorm !== null && (hasArea || hasInfraList || infraTypes.includes(incident.type))) {
    infrastructureRisk = Math.min(
      100,
      Math.round(
        severityNorm * 0.52 +
          (infraTypes.includes(incident.type) ? 26 : 10) +
          Math.min(16, (incident.estimatedImpactAreaKm2 || 0) * 1.1) +
          (hasInfraList ? Math.min(18, incident.infrastructureAffected!.length * 6) : 0)
      )
    );
  } else {
    missingFactors.push('Infrastructure Impact & Footprint Data');
  }

  // Auxiliary operational supply pressure metric (kept for analytics continuity)
  const supplyRisk = Math.min(100, Math.round(20 + shortageCount * 16 + openRequests.length * 14));

  const factors: RiskFactorValue[] = [
    {
      key: 'severity',
      label: 'Incident Severity',
      rawValue: severityNorm !== null ? `${incident.severity} (Level ${incident.severityLevel ?? severityToLevel(incident.severity)})` : null,
      normalizedScore: severityNorm,
      weight: weights.severity,
      missing: severityNorm === null,
      source: 'incident_record',
    },
    {
      key: 'environmental',
      label: 'Environmental / Weather Exposure',
      rawValue:
        weather && envNorm !== null
          ? `${weather.condition} (${weather.rainfallMm ?? 0} mm/h, ${weather.windSpeedKmh ?? 0} km/h, ${weather.temperatureC ?? 'N/A'}°C)`
          : null,
      normalizedScore: envNorm,
      weight: weights.environmental,
      missing: envNorm === null,
      source: weather?.provider || 'weather_unavailable',
    },
    {
      key: 'human_impact',
      label: 'Human Impact & Population',
      rawValue: humanImpactRisk !== null ? `${incident.peopleAffected} people affected` : null,
      normalizedScore: humanImpactRisk,
      weight: weights.humanImpact,
      missing: humanImpactRisk === null,
      source: 'incident_record',
    },
    {
      key: 'vulnerability',
      label: 'Vulnerable Population Exposure',
      rawValue:
        vulnerabilityRisk !== null
          ? `${incident.vulnerablePopulation} vulnerable${
              incident.peopleAffected > 0
                ? ` (${((incident.vulnerablePopulation / incident.peopleAffected) * 100).toFixed(1)}%)`
                : ''
            }`
          : null,
      normalizedScore: vulnerabilityRisk,
      weight: weights.vulnerability,
      missing: vulnerabilityRisk === null,
      source: 'incident_record',
    },
    {
      key: 'access',
      label: 'Access & Route Disruption',
      rawValue: nearestWh ? `${nearestWh.distanceKm} km to ${nearestWh.warehouse.name}` : null,
      normalizedScore: accessRisk,
      weight: weights.access,
      missing: accessRisk === null,
      source: 'geospatial_engine',
    },
    {
      key: 'infrastructure',
      label: 'Infrastructure Exposure',
      rawValue:
        infrastructureRisk !== null
          ? `${incident.type} (${incident.estimatedImpactAreaKm2} km²${
              hasInfraList ? `, ${incident.infrastructureAffected!.join(', ')}` : ''
            })`
          : null,
      normalizedScore: infrastructureRisk,
      weight: weights.infrastructure,
      missing: infrastructureRisk === null,
      source: 'incident_record',
    },
  ];

  const presentFactors = factors.filter((f) => !f.missing && f.normalizedScore !== null);
  const weightSum = presentFactors.reduce((acc, f) => acc + f.weight, 0);
  const totalWeight = factors.reduce((acc, f) => acc + f.weight, 0) || 1;
  const dataCompletenessPct = Math.round((weightSum / totalWeight) * 100);

  // Strict Phase 3 Missing-Data Policy:
  // If less than 40% of weighted factors (or fewer than 2 factors) are present, refuse to fabricate a score!
  const insufficientData = presentFactors.length < 2 || dataCompletenessPct < 40;
  const assessmentStatus: RiskAssessmentStatus = insufficientData
    ? 'INSUFFICIENT_DATA'
    : missingFactors.length === 0
    ? 'COMPLETE'
    : 'PARTIAL';

  const overallScore = insufficientData
    ? null
    : Math.min(
        100,
        Math.max(
          0,
          Math.round(
            presentFactors.reduce((acc, f) => acc + ((f.normalizedScore ?? 0) * f.weight) / weightSum, 0)
          )
        )
      );

  const band: RiskAssessment['band'] =
    overallScore === null ? 'Insufficient Data' : scoreToRiskBand(overallScore);

  const verificationFactor =
    incident.verificationStatus === 'verified'
      ? 0.96
      : incident.verificationStatus === 'pending'
      ? 0.78
      : 0.68;
  const freshnessPenalty = weather?.freshnessCode === 'STALE' ? 0.88 : 1;
  const confidenceScore = insufficientData
    ? Math.round((dataCompletenessPct / 100) * 0.4 * 100) / 100
    : Math.round((dataCompletenessPct / 100) * verificationFactor * freshnessPenalty * 100) / 100;

  const explanation = insufficientData
    ? `INSUFFICIENT DATA FOR RELIABLE RISK ASSESSMENT — Only ${presentFactors.length}/${factors.length} weighted factors available (${dataCompletenessPct}% completeness). Missing: ${missingFactors.join(', ')}. Collect field or weather data before operational scoring.`
    : `Deterministic system classification (${band}, ${overallScore}/100, ${assessmentStatus}, ${dataCompletenessPct}% data completeness) calculated from ${presentFactors.length}/${factors.length} verified inputs.${
        missingFactors.length > 0 ? ` INCOMPLETE DATA WARNING: Missing ${missingFactors.join(', ')}.` : ''
      } Not an official government disaster declaration.`;

  const assessment: RiskAssessment = {
    id: uuidv4(),
    incidentId: incident.id,
    incidentTitle: incident.title,
    calculationVersion: RISK_ENGINE_VERSION,
    ruleVersion: RISK_RULE_VERSION,
    overallScore,
    band,
    assessmentStatus,
    dataCompletenessPct,
    severityRisk: severityNorm,
    environmentalRisk: envNorm,
    humanImpactRisk,
    vulnerabilityRisk,
    infrastructureRisk,
    supplyRisk,
    accessRisk,
    factors,
    missingFactors,
    incompleteDataWarning: missingFactors.length > 0,
    confidenceScore,
    assessmentSource: options?.assessmentSource || 'manual',
    assessor: options?.assessor || 'Deterministic Risk Engine v2.0',
    weatherObservationId: weather?.id,
    previousAssessmentId: options?.previousAssessment?.id || null,
    riskChange: null,
    sourceIds: [incident.id, ...(weather ? [weather.id] : []), ...(nearestWh ? [nearestWh.warehouse.id] : [])],
    explanation,
    mode: incident.mode,
    createdAt: new Date().toISOString(),
  };

  assessment.riskChange = detectRiskChange(options?.previousAssessment, assessment);
  return assessment;
}

// ============================================================================
// 5. TRANSPARENT PRIORITY ENGINE: P = 0.30S + 0.25N + 0.20V + 0.15U + 0.10A
// ============================================================================

export function calculatePriority(
  request: Pick<ReliefRequest, 'incidentId' | 'peopleAffected' | 'vulnerableGroups' | 'urgency' | 'items' | 'lat' | 'lng' | 'mode'>,
  existingOverride?: PriorityBreakdown['override']
): { score: number; category: Severity; breakdown: PriorityBreakdown } {
  const weights = store.state.settings.priorityWeights;
  const incident = store.state.incidents.find((i) => i.id === request.incidentId);
  const missingInformation: string[] = [];

  const S = incident ? SEVERITY_BASE[incident.severity] : 60;
  if (!incident) missingInformation.push('Linked incident severity record missing (defaulted to 60)');

  const totalRequested = request.items.reduce((acc, i) => acc + i.quantity, 0);
  const totalAvailableForCategories = request.items.reduce((acc, item) => {
    const avail = store.state.inventory
      .filter((inv) => inv.mode === request.mode && inv.category === item.category)
      .reduce((s, inv) => s + inv.availableQty, 0);
    return acc + avail;
  }, 0);
  const scarcityRatio = totalRequested > 0 ? Math.min(1, totalRequested / Math.max(1, totalAvailableForCategories)) : 0.4;
  const N = Math.min(100, Math.round(45 + scarcityRatio * 55));

  const V = Math.min(
    100,
    Math.round(
      Math.min(60, (Math.log10(Math.max(1, request.peopleAffected) + 1) / 3.8) * 60) +
        Math.min(40, request.vulnerableGroups.length * 16)
    )
  );
  const U = SEVERITY_BASE[request.urgency];

  const nearestWh = findNearestWarehouses(request.lat, request.lng, request.mode, 1)[0];
  const A = nearestWh ? Math.min(100, Math.round((nearestWh.distanceKm / 100) * 70 + 20)) : 65;
  if (!nearestWh) missingInformation.push('No operational warehouse coordinates available');

  const algorithmicScore = Math.round(
    weights.S * S + weights.N * N + weights.V * V + weights.U * U + weights.A * A
  );
  const algorithmicCategory: Severity =
    algorithmicScore >= 80 ? 'critical' : algorithmicScore >= 60 ? 'high' : algorithmicScore >= 38 ? 'medium' : 'low';

  return {
    score: algorithmicScore,
    category: existingOverride ? existingOverride.newCategory : algorithmicCategory,
    breakdown: {
      severityScore: S,
      needScore: N,
      vulnerabilityScore: V,
      urgencyScore: U,
      accessScore: A,
      weights: { ...weights },
      algorithmicScore,
      algorithmicCategory,
      calculationVersion: 'priority-v1.0',
      missingInformation,
      override: existingOverride,
    },
  };
}

// ============================================================================
// 6. PREDICTIVE INTELLIGENCE (Rule + Statistical Burn-Rate & Escalation)
// ============================================================================

export function computeOperationalPredictions(mode: DataMode): PredictionRecord[] {
  const now = new Date().toISOString();
  const predictions: PredictionRecord[] = [];
  const modeInventory = store.state.inventory.filter((i) => i.mode === mode);
  const modeRequests = store.state.reliefRequests.filter((r) => r.mode === mode && r.status !== 'closed' && r.status !== 'delivered');
  const modeIncidents = store.state.incidents.filter((i) => i.mode === mode && i.status !== 'resolved' && i.status !== 'archived');

  // Warehouse Depletion Forecast per critical item category
  for (const inv of modeInventory) {
    const openDemand = modeRequests.reduce(
      (sum, req) =>
        sum +
        req.items
          .filter((it) => it.category === inv.category)
          .reduce((s, it) => s + Math.max(0, it.quantity - it.fulfilledQuantity), 0),
      0
    );
    if (openDemand > 0 || inv.availableQty <= inv.reorderThreshold) {
      const hourlyBurn = Math.max(1, Math.round(openDemand / 24 + (inv.reservedQty > 0 ? inv.reservedQty / 18 : 2)));
      const hoursToDepletion = Math.max(1, Math.round(inv.availableQty / hourlyBurn));
      const wh = store.state.warehouses.find((w) => w.id === inv.warehouseId);
      predictions.push({
        id: uuidv4(),
        predictionType: inv.availableQty < inv.minStock ? 'resource_shortage' : 'warehouse_depletion',
        targetId: inv.id,
        targetName: `${inv.itemName} @ ${wh?.name || inv.warehouseId}`,
        forecastHorizonHours: 24,
        modelVersion: 'stat-burnrate-v1.0',
        methodology: 'Linear demand-to-stock burn-rate ratio from current open relief requests & reserved quantities.',
        inputFeatures: {
          availableQty: inv.availableQty,
          reservedQty: inv.reservedQty,
          minStock: inv.minStock,
          openCategoryDemand: openDemand,
          estimatedHourlyBurn: hourlyBurn,
        },
        predictionSummary:
          hoursToDepletion <= 12
            ? `High stockout risk within ~${hoursToDepletion}h if unreplenished.`
            : `Projected stock coverage of ~${hoursToDepletion}h at current demand pace.`,
        projectedValue: hoursToDepletion,
        unit: 'hours',
        uncertaintyNote: 'Heuristic operational projection based on live queue volume; not a scientifically validated forecast.',
        actualOutcome: null,
        mode,
        createdAt: now,
      });
    }
  }

  // Incident Escalation Risk Forecast
  for (const inc of modeIncidents) {
    const linkedReqs = modeRequests.filter((r) => r.incidentId === inc.id);
    if ((inc.riskScore ?? 0) >= 65 || linkedReqs.some((r) => r.urgency === 'critical')) {
      const escalationIndex = Math.min(98, Math.round((inc.riskScore ?? 60) * 0.75 + linkedReqs.length * 10));
      predictions.push({
        id: uuidv4(),
        predictionType: 'escalation',
        targetId: inc.id,
        targetName: inc.title,
        forecastHorizonHours: 12,
        modelVersion: 'rule-escalation-v1.0',
        methodology: 'Deterministic threshold combination of current operational risk score and active relief request surge.',
        inputFeatures: {
          currentRiskScore: inc.riskScore ?? 0,
          openReliefRequests: linkedReqs.length,
          peopleAffected: inc.peopleAffected,
        },
        predictionSummary: `Elevated 12h escalation watch (index ${escalationIndex}/100) driven by ${linkedReqs.length} open request(s) and ${inc.peopleAffected} affected residents.`,
        projectedValue: escalationIndex,
        unit: 'index/100',
        uncertaintyNote: 'Rule-based operational watch indicator; requires human commander verification.',
        actualOutcome: null,
        mode,
        createdAt: now,
      });
    }
  }

  return predictions.slice(0, 12);
}

// ============================================================================
// 7. REAL ROUTE OPTIMIZATION ENGINE (OSRM + Google Routes API v2 + Fallback)
// ============================================================================

export function decodePolyline(encoded: string): { lat: number; lng: number }[] {
  const points: { lat: number; lng: number }[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let b = 0;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

export async function optimizeRoute(params: {
  origin: { lat: number; lng: number; label: string };
  destination: { lat: number; lng: number; label: string };
  waypoints?: { lat: number; lng: number; label: string }[];
}): Promise<RouteResult> {
  const started = Date.now();
  const waypoints = params.waypoints || [];
  const allPoints = [params.origin, ...waypoints, params.destination];
  const gmpKey = process.env.GOOGLE_MAPS_API_KEY || '';

  // Attempt 1: Google Maps Routes API v2 (server-side proxy, zero CORS issues)
  if (gmpKey) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      const body: Record<string, unknown> = {
        origin: { location: { latLng: { latitude: params.origin.lat, longitude: params.origin.lng } } },
        destination: { location: { latLng: { latitude: params.destination.lat, longitude: params.destination.lng } } },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        computeAlternativeRoutes: true,
      };
      if (waypoints.length > 0) {
        body.intermediates = waypoints.map((wp) => ({
          location: { latLng: { latitude: wp.lat, longitude: wp.lng } },
        }));
        body.optimizeWaypointOrder = true;
      }

      const resp = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': gmpKey,
          'X-Goog-FieldMask':
            'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.steps.navigationInstruction,routes.optimizedIntermediateWaypointIndex',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (resp.ok) {
        const data = (await resp.json()) as any;
        const primary = data.routes?.[0];
        if (primary) {
          const distanceKm = Math.round(((primary.distanceMeters || 0) / 1000) * 100) / 100;
          const durationSec = parseInt(String(primary.duration || '0s').replace('s', ''), 10) || 0;
          const durationMin = Math.max(1, Math.round(durationSec / 60));
          const geometry = primary.polyline?.encodedPolyline
            ? decodePolyline(primary.polyline.encodedPolyline)
            : allPoints.map((p) => ({ lat: p.lat, lng: p.lng }));
          const instructions: string[] = [];
          for (const leg of primary.legs || []) {
            for (const step of leg.steps || []) {
              if (step.navigationInstruction?.instructions) {
                instructions.push(step.navigationInstruction.instructions);
              }
            }
          }
          const optIdx: number[] | undefined = primary.optimizedIntermediateWaypointIndex;
          const orderedWaypoints = waypoints.map((wp, idx) => ({
            ...wp,
            order: optIdx ? optIdx.indexOf(idx) + 1 : idx + 1,
          }));

          const ts = new Date().toISOString();
          store.updateIntegrationHealth('int-routing', {
            status: 'healthy',
            provider: 'Google Routes API v2',
            lastSuccessAt: ts,
            lastError: null,
            latencyMs: Date.now() - started,
          });

          return {
            id: uuidv4(),
            provider: 'google_routes_v2',
            origin: params.origin,
            destination: params.destination,
            waypoints: orderedWaypoints,
            distanceKm,
            durationMin,
            geometry,
            instructions: instructions.slice(0, 14),
            roadConditionsNotice:
              'ROAD CONDITIONS NOT VERIFIED — Flooded roads or unmapped debris closures must be verified by local field scouts.',
            alternativesCount: Math.max(1, (data.routes || []).length),
            timestamp: ts,
            freshnessStatus: 'fresh',
          };
        }
      }
    } catch {
      // Fall through cleanly to OSRM
    }
  }

  // Attempt 2: Public OSRM Routing Engine
  try {
    const coordsStr = allPoints.map((p) => `${p.lng},${p.lat}`).join(';');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const resp = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson&steps=true&alternatives=true`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (resp.ok) {
      const data = (await resp.json()) as any;
      const primary = data.routes?.[0];
      if (primary) {
        const distanceKm = Math.round((primary.distance / 1000) * 100) / 100;
        const durationMin = Math.max(1, Math.round(primary.duration / 60));
        const geometry = (primary.geometry?.coordinates || []).map(([lng, lat]: [number, number]) => ({
          lat,
          lng,
        }));
        const instructions: string[] = [];
        for (const leg of primary.legs || []) {
          for (const step of leg.steps || []) {
            if (step.name) {
              instructions.push(`${step.maneuver?.type || 'Proceed'} on ${step.name} (${Math.round(step.distance)}m)`);
            }
          }
        }
        const ts = new Date().toISOString();
        store.updateIntegrationHealth('int-routing', {
          status: 'healthy',
          provider: 'OSRM Public Router',
          lastSuccessAt: ts,
          lastError: null,
          latencyMs: Date.now() - started,
        });
        return {
          id: uuidv4(),
          provider: 'osrm',
          origin: params.origin,
          destination: params.destination,
          waypoints: waypoints.map((wp, idx) => ({ ...wp, order: idx + 1 })),
          distanceKm,
          durationMin,
          geometry,
          instructions: instructions.slice(0, 14),
          roadConditionsNotice:
            'ROAD CONDITIONS NOT VERIFIED — OSRM reflects OpenStreetMap road topology without live disaster road-closure verification.',
          alternativesCount: Math.max(1, (data.routes || []).length),
          timestamp: ts,
          freshnessStatus: 'fresh',
        };
      }
    }
  } catch (err) {
    store.updateIntegrationHealth('int-routing', {
      status: 'degraded',
      lastError: err instanceof Error ? err.message : 'Routing providers unavailable',
    });
  }

  // Fallback: Honest straight-line distance ONLY (NEVER invent an ETA when routing fails!)
  let straightKm = 0;
  for (let i = 0; i < allPoints.length - 1; i++) {
    straightKm += haversineKm(allPoints[i].lat, allPoints[i].lng, allPoints[i + 1].lat, allPoints[i + 1].lng);
  }
  return {
    id: uuidv4(),
    provider: 'haversine_fallback',
    origin: params.origin,
    destination: params.destination,
    waypoints: waypoints.map((wp, idx) => ({ ...wp, order: idx + 1 })),
    distanceKm: Math.round(straightKm * 100) / 100,
    durationMin: null, // Explicitly null: do not invent ETA when routing fails
    geometry: allPoints.map((p) => ({ lat: p.lat, lng: p.lng })),
    instructions: ['Routing provider unavailable — straight-line reference shown for manual dispatcher review.'],
    roadConditionsNotice: 'ROUTING UNAVAILABLE / ROAD CONDITIONS NOT VERIFIED — Manual dispatcher review required.',
    alternativesCount: 0,
    timestamp: new Date().toISOString(),
    freshnessStatus: 'outage',
  };
}

// ============================================================================
// 8. ADVANCED RESOURCE ALLOCATION ENGINE (Multi-Criteria + Split Allocation)
// ============================================================================

export async function generateAllocationRecommendation(request: ReliefRequest): Promise<Allocation> {
  const mode = request.mode;
  const warehouses = store.state.warehouses.filter(
    (w) => w.mode === mode && (w.status === 'operational' || w.status === 'limited')
  );
  const availableVehicles = store.state.vehicles.filter((v) => v.mode === mode && v.status === 'available');

  const allocatedLines: AllocationLineItem[] = [];
  const unmetItems: Allocation['unmetItems'] = [];
  const warnings: string[] = [];
  const constraints: string[] = [];

  for (const reqItem of request.items) {
    let remaining = Math.max(0, reqItem.quantity - reqItem.fulfilledQuantity);
    if (remaining <= 0) continue;

    // Score candidate warehouses holding this category with available stock
    const candidates: {
      warehouse: Warehouse;
      stock: InventoryStock;
      distanceKm: number;
      score: number;
    }[] = [];

    for (const wh of warehouses) {
      const stock = store.state.inventory.find(
        (inv) => inv.mode === mode && inv.warehouseId === wh.id && inv.category === reqItem.category && inv.availableQty > 0
      );
      if (!stock) continue;

      const distanceKm = haversineKm(wh.lat, wh.lng, request.lat, request.lng);
      const fulfillmentRatio = Math.min(1, stock.availableQty / remaining);
      const postAllocationRatio = Math.max(0, (stock.availableQty - Math.min(stock.availableQty, remaining)) / Math.max(1, stock.minStock));
      const statusScore = wh.status === 'operational' ? 100 : 65;
      const accessScore = wh.accessibility === 'high' ? 100 : wh.accessibility === 'moderate' ? 70 : 40;
      const distanceScore = Math.max(10, 100 - distanceKm * 0.75);
      const shortageImpactScore = Math.min(100, postAllocationRatio * 75 + 25);

      const hasVehicle = availableVehicles.some((v) => v.warehouseId === wh.id);
      const vehicleBonus = hasVehicle ? 15 : 0;

      // Multi-criteria score (NOT merely nearest warehouse!)
      const candidateScore = Math.round(
        fulfillmentRatio * 32 +
          distanceScore * 22 +
          statusScore * 14 +
          accessScore * 12 +
          shortageImpactScore * 12 +
          vehicleBonus
      );

      candidates.push({ warehouse: wh, stock, distanceKm, score: candidateScore });
    }

    candidates.sort((a, b) => b.score - a.score);

    for (const cand of candidates) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, cand.stock.availableQty);
      if (take <= 0) continue;

      if (cand.stock.availableQty - take < cand.stock.minStock) {
        warnings.push(
          `Allocating ${take} ${reqItem.unit} of ${cand.stock.itemName} from ${cand.warehouse.name} will bring stock below minimum threshold (${cand.stock.minStock}).`
        );
      }
      if (cand.warehouse.status === 'limited') {
        warnings.push(`${cand.warehouse.name} is currently operating in LIMITED status.`);
      }

      allocatedLines.push({
        warehouseId: cand.warehouse.id,
        warehouseName: cand.warehouse.name,
        stockId: cand.stock.id,
        itemName: cand.stock.itemName,
        category: reqItem.category,
        quantity: take,
        unit: reqItem.unit,
        distanceKm: cand.distanceKm,
        estimatedEtaMin: null,
        candidateScore: cand.score,
      });
      remaining -= take;
    }

    if (remaining > 0) {
      unmetItems.push({
        category: reqItem.category,
        itemName: reqItem.itemName,
        quantity: remaining,
        unit: reqItem.unit,
      });
      warnings.push(`Unfulfilled demand: ${remaining} ${reqItem.unit} of ${reqItem.itemName} cannot be covered by current available inventory.`);
    }
  }

  const distinctWarehouses = Array.from(new Set(allocatedLines.map((l) => l.warehouseId)));
  const splitAllocation = distinctWarehouses.length > 1;
  if (splitAllocation) {
    constraints.push(`Split allocation across ${distinctWarehouses.length} warehouses to maximize fulfillment without depleting a single depot.`);
  }

  // Compute route from primary warehouse to destination
  let totalDistanceKm = 0;
  let estimatedDurationMin: number | null = null;
  let routeProvider = 'none';
  let roadConditionsNotice = 'ROAD CONDITIONS NOT VERIFIED';

  if (distinctWarehouses.length > 0) {
    const primaryWh = store.state.warehouses.find((w) => w.id === distinctWarehouses[0]);
    if (primaryWh) {
      const route = await optimizeRoute({
        origin: { lat: primaryWh.lat, lng: primaryWh.lng, label: primaryWh.name },
        destination: { lat: request.lat, lng: request.lng, label: request.locationName },
      });
      totalDistanceKm = route.distanceKm;
      estimatedDurationMin = route.durationMin;
      routeProvider = route.provider;
      roadConditionsNotice = route.roadConditionsNotice;
      for (const line of allocatedLines) {
        if (line.warehouseId === primaryWh.id) {
          line.estimatedEtaMin = route.durationMin;
        }
      }
    }
  }

  const totalUnits = allocatedLines.reduce((acc, l) => acc + l.quantity, 0);
  const matchedVehicle =
    availableVehicles.find((v) => v.warehouseId === distinctWarehouses[0] && v.capacityUnits >= totalUnits) ||
    availableVehicles.sort((a, b) => b.capacityUnits - a.capacityUnits)[0] ||
    null;

  if (!matchedVehicle) {
    warnings.push('No available vehicle currently registered in fleet — manual transport arrangement required.');
  } else if (matchedVehicle.capacityUnits < totalUnits) {
    constraints.push(
      `Total cargo (${totalUnits} units) exceeds ${matchedVehicle.callsign} single-trip capacity (${matchedVehicle.capacityUnits} units); multi-trip or secondary vehicle advised.`
    );
  }

  const now = new Date().toISOString();
  const allocation: Allocation = {
    id: uuidv4(),
    requestId: request.id,
    incidentId: request.incidentId,
    status: 'proposed',
    splitAllocation,
    items: allocatedLines,
    unmetItems,
    recommendedVehicleId: matchedVehicle?.id || null,
    totalDistanceKm,
    estimatedDurationMin,
    routeProvider,
    roadConditionsNotice,
    explanation:
      allocatedLines.length > 0
        ? `Multi-criteria allocation ranked ${distinctWarehouses.length} feasible depot(s) balancing fulfillment, stockout protection, accessibility, vehicle availability, and route distance (${totalDistanceKm} km). Human approval required before atomic stock reservation.`
        : 'No feasible stock currently available across operational warehouses for requested items.',
    constraints,
    warnings,
    confidence: unmetItems.length === 0 && allocatedLines.length > 0 ? 0.91 : allocatedLines.length > 0 ? 0.68 : 0.25,
    requiresApproval: true,
    mode,
    createdAt: now,
    updatedAt: now,
  };

  store.state.allocations.unshift(allocation);
  store.save();
  return allocation;
}

export interface ServerGeocodeCandidate {
  placeId: string | null;
  formattedAddress: string;
  lat: number;
  lng: number;
  granularity?: string;
}

export interface ServerGeocodeResponse {
  provider: 'google_geocoding_v4' | 'nominatim_fallback' | 'unavailable';
  googleConfigured: boolean;
  gmpQuotaExceeded?: boolean;
  notice?: string;
  results: ServerGeocodeCandidate[];
}

export async function geocodeAddressServer(address: string): Promise<ServerGeocodeResponse> {
  const query = address.trim();
  const googleKey = (process.env.GOOGLE_MAPS_API_KEY || '').trim();
  let gmpQuotaExceeded = false;

  if (!query) {
    return { provider: 'unavailable', googleConfigured: Boolean(googleKey), results: [] };
  }

  if (googleKey) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      const url = `https://geocode.googleapis.com/v4/geocode/address/${encodeURIComponent(query)}?languageCode=en`;
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': googleKey,
          'X-Goog-FieldMask': 'results.placeId,results.location,results.formattedAddress,results.granularity',
          'X-Goog-Maps-Solution-ID': 'gmp_git_agentskills_v1',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (resp.ok) {
        const data = (await resp.json()) as {
          results?: Array<{
            placeId?: string;
            formattedAddress?: string;
            granularity?: string;
            location?: { latitude?: number; longitude?: number };
          }>;
        };
        const mapped: ServerGeocodeCandidate[] = (data.results || [])
          .filter(
            (r) =>
              typeof r.location?.latitude === 'number' &&
              typeof r.location?.longitude === 'number' &&
              validateCoordinates(r.location.latitude, r.location.longitude)
          )
          .slice(0, 5)
          .map((r) => ({
            placeId: r.placeId || null,
            formattedAddress: r.formattedAddress || query,
            lat: r.location!.latitude!,
            lng: r.location!.longitude!,
            granularity: r.granularity,
          }));

        return {
          provider: 'google_geocoding_v4',
          googleConfigured: true,
          results: mapped,
        };
      }

      if (resp.status === 429) {
        gmpQuotaExceeded = true;
      } else {
        const errJson = (await resp.json().catch(() => null)) as { error?: { status?: string } } | null;
        if (errJson?.error?.status === 'RESOURCE_EXHAUSTED') {
          gmpQuotaExceeded = true;
        }
      }
    } catch {
      // fall through cleanly to Nominatim
    }
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const nomUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`;
    const resp = await fetch(nomUrl, {
      headers: {
        'User-Agent': 'RESQFLOW-AI-CommandCenter/1.0',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.ok) {
      const rows = (await resp.json()) as Array<{ lat?: string; lon?: string; display_name?: string; place_id?: number }>;
      const mapped: ServerGeocodeCandidate[] = (Array.isArray(rows) ? rows : [])
        .map((row) => ({
          placeId: row.place_id ? `osm-${row.place_id}` : null,
          formattedAddress: row.display_name || query,
          lat: Number(row.lat),
          lng: Number(row.lon),
        }))
        .filter((c) => validateCoordinates(c.lat, c.lng));

      return {
        provider: 'nominatim_fallback',
        googleConfigured: Boolean(googleKey),
        gmpQuotaExceeded: gmpQuotaExceeded || undefined,
        notice: googleKey
          ? 'Google Geocoding unavailable; using OpenStreetMap Nominatim lookup.'
          : 'GOOGLE_MAPS_API_KEY is not configured on the server; using OpenStreetMap Nominatim lookup.',
        results: mapped,
      };
    }
  } catch {
    // return unavailable
  }

  return {
    provider: 'unavailable',
    googleConfigured: Boolean(googleKey),
    gmpQuotaExceeded: gmpQuotaExceeded || undefined,
    notice: googleKey
      ? 'Geocoding service temporarily unavailable.'
      : 'GOOGLE_MAPS_API_KEY is not configured on the server and fallback geocoding is unreachable.',
    results: [],
  };
}

export async function reverseGeocodeServer(lat: number, lng: number): Promise<ServerGeocodeResponse> {
  const googleKey = (process.env.GOOGLE_MAPS_API_KEY || '').trim();
  let gmpQuotaExceeded = false;

  if (!validateCoordinates(lat, lng)) {
    return { provider: 'unavailable', googleConfigured: Boolean(googleKey), results: [] };
  }

  if (googleKey) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      const url = new URL('https://geocode.googleapis.com/v4/geocode/location');
      url.searchParams.set('location.latitude', String(lat));
      url.searchParams.set('location.longitude', String(lng));
      url.searchParams.set('languageCode', 'en');

      const resp = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': googleKey,
          'X-Goog-FieldMask': 'results.placeId,results.location,results.formattedAddress,results.granularity',
          'X-Goog-Maps-Solution-ID': 'gmp_git_agentskills_v1',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (resp.ok) {
        const data = (await resp.json()) as {
          results?: Array<{
            placeId?: string;
            formattedAddress?: string;
            granularity?: string;
            location?: { latitude?: number; longitude?: number };
          }>;
        };
        const mapped: ServerGeocodeCandidate[] = (data.results || []).slice(0, 3).map((r) => ({
          placeId: r.placeId || null,
          formattedAddress: r.formattedAddress || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
          lat: typeof r.location?.latitude === 'number' ? r.location.latitude : lat,
          lng: typeof r.location?.longitude === 'number' ? r.location.longitude : lng,
          granularity: r.granularity,
        }));
        return {
          provider: 'google_geocoding_v4',
          googleConfigured: true,
          results: mapped,
        };
      }

      if (resp.status === 429) {
        gmpQuotaExceeded = true;
      } else {
        const errJson = (await resp.json().catch(() => null)) as { error?: { status?: string } } | null;
        if (errJson?.error?.status === 'RESOURCE_EXHAUSTED') {
          gmpQuotaExceeded = true;
        }
      }
    } catch {
      // fall through
    }
  }

  return {
    provider: 'unavailable',
    googleConfigured: Boolean(googleKey),
    gmpQuotaExceeded: gmpQuotaExceeded || undefined,
    results: [
      {
        placeId: null,
        formattedAddress: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        lat,
        lng,
      },
    ],
  };
}

