// Shared Domain Types & Contracts for RESQFLOW AI

export type DataMode = 'operational' | 'demo';

export type UserRole =
  | 'super_admin'
  | 'emergency_commander'
  | 'logistics_manager'
  | 'warehouse_operator'
  | 'field_responder'
  | 'analyst'
  | 'citizen_reporter';

export type IncidentType =
  | 'flood'
  | 'flash_flood'
  | 'landslide'
  | 'cyclone'
  | 'severe_storm'
  | 'heatwave'
  | 'wildfire'
  | 'earthquake'
  | 'infrastructure_failure'
  | 'water_shortage'
  | 'power_failure'
  | 'chemical_incident'
  | 'other';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type IncidentStatus =
  | 'reported'
  | 'under_review'
  | 'verified'
  | 'active'
  | 'escalated'
  | 'contained'
  | 'resolved'
  | 'archived';

export type ReliefStatus =
  | 'submitted'
  | 'verified'
  | 'prioritized'
  | 'allocated'
  | 'approved'
  | 'dispatched'
  | 'delivered'
  | 'closed';

export type ResourceCategory =
  | 'drinking_water'
  | 'food'
  | 'medical_kits'
  | 'medicines'
  | 'shelter'
  | 'blankets'
  | 'clothing'
  | 'hygiene_kits'
  | 'rescue_equipment'
  | 'fuel'
  | 'power_equipment'
  | 'communication_equipment'
  | 'transportation'
  | 'other';

export type WarehouseStatus =
  | 'operational'
  | 'limited'
  | 'temporarily_closed'
  | 'temporarily_unavailable'
  | 'closed'
  | 'under_maintenance'
  | 'unknown';

export type WarehouseType =
  | 'central_hub'
  | 'regional_depot'
  | 'medical_cold_chain'
  | 'forward_staging'
  | 'mobile_unit'
  | 'ngo_partner';

export type StockAlertLevel = 'NORMAL' | 'LOW' | 'CRITICAL' | 'OUT_OF_STOCK';

export type MovementType =
  | 'inbound'
  | 'outbound'
  | 'transfer'
  | 'reservation'
  | 'release'
  | 'adjustment'
  | 'damage'
  | 'expiry'
  | 'return'
  | 'reconciliation';

export type VehicleStatus =
  | 'available'
  | 'assigned'
  | 'loading'
  | 'dispatched'
  | 'in_transit'
  | 'en_route'
  | 'delivering'
  | 'returning'
  | 'delayed'
  | 'completed'
  | 'maintenance'
  | 'unavailable';

export type VehicleType =
  | 'heavy_truck'
  | 'light_van'
  | 'ambulance'
  | 'relief_truck'
  | 'cargo_truck'
  | 'pickup'
  | 'rescue_vehicle'
  | 'water_tanker'
  | 'bus'
  | 'utility_vehicle'
  | 'motorcycle'
  | 'boat'
  | 'rescue_boat'
  | 'helicopter'
  | '4x4_utility'
  | 'other';

export type DispatchStatus =
  | 'dispatch_created'
  | 'vehicle_assigned'
  | 'loading'
  | 'departed'
  | 'in_transit'
  | 'arrived'
  | 'delivered'
  | 'delivery_failed'
  | 'cancelled'
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'LOADING'
  | 'DISPATCHED'
  | 'EN_ROUTE'
  | 'ARRIVED'
  | 'DELIVERING'
  | 'DELIVERED'
  | 'PARTIALLY_DELIVERED'
  | 'COMPLETED'
  | 'FAILED'
  | 'DELAYED'
  | 'RETURNING'
  | 'CANCELLED';

export type DriverStatus = 'Available' | 'Assigned' | 'On Duty' | 'Off Duty' | 'Unavailable';

export type AllocationPriorityLevel = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' | 'CRITICAL';

export type RouteStatus =
  | 'ROUTE_AVAILABLE'
  | 'ROUTE_UNAVAILABLE'
  | 'ROUTE_STALE'
  | 'ROUTE_REQUIRES_REVIEW';

export type RouteRiskBand = 'UNKNOWN' | 'LOW' | 'MODERATE' | 'HIGH' | 'BLOCKED';

export type EtaStatus = 'ON_TIME' | 'AT_RISK' | 'DELAYED' | 'UNKNOWN';

export type DeliveryStatus =
  | 'PENDING'
  | 'DELIVERED'
  | 'PARTIALLY_DELIVERED'
  | 'FAILED'
  | 'RETURNED';

export type TrackingStatus = 'LIVE_GPS' | 'STALE' | 'UNAVAILABLE' | 'SIMULATED_DEMO';

export type RiskBand = 'Low' | 'Guarded' | 'Elevated' | 'High' | 'Critical';

export type FreshnessStatus = 'fresh' | 'delayed' | 'stale' | 'missing' | 'outage' | 'partial';

export type RealtimeConnectionState = 'LIVE' | 'CONNECTING' | 'RECONNECTING' | 'DEGRADED' | 'OFFLINE';

export type AgentType =
  | 'risk_intelligence'
  | 'priority'
  | 'resource'
  | 'allocation'
  | 'route'
  | 'demand_forecast'
  | 'situation_report'
  | 'coordination';

export interface Organization {
  id: string;
  name: string;
  type: 'command_center' | 'government' | 'ngo' | 'logistics' | 'medical';
  region: string;
  contactEmail: string;
  activeMembers: number;
  createdAt: string;
}

export interface IncidentHistoryEntry {
  id: string;
  timestamp: string;
  actor: string;
  role: UserRole;
  action: string;
  note?: string;
  previousStatus?: IncidentStatus;
  newStatus?: IncidentStatus;
}

export type SeverityLevelNumber = 1 | 2 | 3 | 4 | 5;

export interface DuplicateMatch {
  duplicateIncidentId: string;
  title: string;
  type: IncidentType;
  status: IncidentStatus;
  distanceKm: number;
  timeDiffMinutes: number;
  similarityFactors: string[];
  likelihood: 'low' | 'medium' | 'high';
  recommendation: string;
}

export interface IncidentReportRecord {
  id: string;
  incidentId: string;
  reporterName: string;
  reporterRole: UserRole;
  sourceType: 'citizen' | 'field_responder' | 'agency' | 'sensor' | 'command_desk';
  summary: string;
  peopleAffectedUpdate?: number;
  vulnerablePopulationUpdate?: number;
  severitySuggestion?: Severity;
  evidenceUrls: string[];
  lat?: number;
  lng?: number;
  mode: DataMode;
  createdAt: string;
}

export interface Incident {
  id: string;
  title: string;
  description: string;
  type: IncidentType;
  severity: Severity;
  severityLevel?: SeverityLevelNumber;
  status: IncidentStatus;
  lat: number;
  lng: number;
  address: string;
  region: string;
  district?: string;
  state?: string;
  country?: string;
  reportedAt: string;
  incidentStartTime?: string;
  source: string;
  sourceType?: 'citizen' | 'field_responder' | 'agency' | 'sensor' | 'command_desk';
  reporter: string;
  peopleAffected: number;
  familiesAffected?: number;
  vulnerablePopulation: number;
  estimatedImpactAreaKm2: number;
  infrastructureAffected?: string[];
  immediateNeeds: string[];
  evidenceUrls: string[];
  verificationStatus: 'unverified' | 'pending' | 'verified' | 'rejected';
  rejectedReason?: string;
  riskScore: number | null;
  riskBand?: RiskBand | null;
  priorityScore: number | null;
  assignedOrgId: string;
  assignedTeam: string;
  mode: DataMode;
  ownerId: string;
  possibleDuplicateOf?: string[];
  duplicateMatches?: DuplicateMatch[];
  coordinateWarnings?: string[];
  notes: { id: string; text: string; author: string; createdAt: string }[];
  history: IncidentHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

export type WeatherFreshnessCode = 'FRESH' | 'STALE' | 'UNAVAILABLE' | 'INVALID';

export interface WeatherRiskResult {
  hazardType: 'flood' | 'heat' | 'wind' | 'storm' | 'general';
  score: number | null;
  level: RiskBand | 'INSUFFICIENT_DATA';
  ruleVersion: string;
  triggeredRules: string[];
  unavailableFactors: string[];
  evidence: string[];
  explanation: string;
}

export interface WeatherObservation {
  id: string;
  provider: string;
  sourceType: 'live_api' | 'cached_fallback';
  locationName: string;
  lat: number;
  lng: number;
  temperatureC: number | null;
  feelsLikeC: number | null;
  rainfallMm: number | null;
  precipitationMm: number | null;
  windSpeedKmh: number | null;
  windGustKmh?: number | null;
  windDirectionDeg: number | null;
  humidityPct: number | null;
  pressureHpa?: number | null;
  weatherCode?: number | null;
  condition: string;
  severeTriggers: string[];
  riskClassification: RiskBand;
  explanation: string;
  dataTimestamp: string;
  fetchTimestamp: string;
  freshnessLimitSeconds: number;
  freshnessStatus: FreshnessStatus;
  freshnessCode?: WeatherFreshnessCode;
  cacheAgeSeconds?: number;
  dataQuality?: 'valid' | 'partial' | 'invalid' | 'unavailable';
  unavailableNotice?: string;
  weatherRisk?: WeatherRiskResult;
  forecastSummary: { time: string; tempC: number | null; precipMm: number | null; windKmh: number | null; precipProbPct?: number | null }[];
  dailyForecast?: { date: string; tempMaxC: number | null; tempMinC: number | null; precipSumMm: number | null; windMaxKmh: number | null }[];
}

export interface RiskFactorValue {
  key: string;
  label: string;
  rawValue: number | string | null;
  normalizedScore: number | null;
  weight: number;
  missing: boolean;
  source?: string;
}

export type RiskAssessmentStatus = 'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_DATA';

export interface RiskChangeComparison {
  previousAssessmentId: string | null;
  previousScore: number | null;
  currentScore: number | null;
  scoreDelta: number | null;
  previousBand: RiskBand | null;
  currentBand: RiskBand | null;
  bandChanged: boolean;
  criticalThresholdCrossed: boolean;
  significantJump: boolean;
  confidenceDeteriorated: boolean;
  changeDrivers: string[];
}

export interface RiskAssessment {
  id: string;
  incidentId: string;
  incidentTitle: string;
  calculationVersion: string;
  ruleVersion?: string;
  overallScore: number | null;
  band: RiskBand | 'Insufficient Data';
  assessmentStatus?: RiskAssessmentStatus;
  dataCompletenessPct?: number;
  severityRisk?: number | null;
  environmentalRisk: number | null;
  humanImpactRisk: number | null;
  vulnerabilityRisk?: number | null;
  infrastructureRisk: number | null;
  supplyRisk: number | null;
  accessRisk: number | null;
  factors: RiskFactorValue[];
  missingFactors: string[];
  incompleteDataWarning: boolean;
  confidenceScore: number;
  assessmentSource?: 'manual' | 'auto_reassessment' | 'incident_creation' | 'weather_update' | 'report_update';
  assessor?: string;
  weatherObservationId?: string;
  previousAssessmentId?: string | null;
  riskChange?: RiskChangeComparison | null;
  aiBriefingId?: string | null;
  sourceIds: string[];
  explanation: string;
  mode: DataMode;
  createdAt: string;
}

export type AlertStatus = 'TRIGGERED' | 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface AlertRecord {
  id: string;
  dedupKey: string;
  incidentId?: string;
  incidentTitle?: string;
  alertType:
    | 'risk_high_threshold'
    | 'risk_critical_threshold'
    | 'risk_significant_increase'
    | 'weather_threshold_crossed'
    | 'incident_severity_increased'
    | 'weather_provider_degraded'
    | 'incomplete_risk_assessment'
    | 'manual_verification_required'
    | 'inventory_low_stock'
    | 'inventory_critical_stock'
    | 'inventory_out_of_stock'
    | 'new_relief_request'
    | 'unfulfilled_demand'
    | 'reservation_conflict'
    | 'inventory_expiring_supply'
    | 'inventory_expired_supply'
    | 'incoming_supply_delayed'
    | 'warehouse_unavailable'
    | 'stock_discrepancy';
  warehouseId?: string;
  warehouseName?: string;
  itemId?: string;
  itemName?: string;
  severity: 'info' | 'warning' | 'high' | 'critical';
  status: AlertStatus;
  title: string;
  message: string;
  triggerFactor: string;
  previousValue?: string | number | null;
  currentValue?: string | number | null;
  source: string;
  cooldownMinutes: number;
  acknowledgedBy?: string | null;
  acknowledgedAt?: string | null;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
  resolutionNote?: string | null;
  mode: DataMode;
  createdAt: string;
  updatedAt: string;
}

export interface AIRiskBriefing {
  id: string;
  incident_id: string;
  assessment_id: string;
  summary: string;
  risk_drivers: string[];
  potential_escalation: string[];
  recommended_actions: string[];
  verification_required: string[];
  missing_information: string[];
  evidence_references: string[];
  uncertainty: string;
  generated_at: string;
  model: string;
  requires_human_review: true;
  mode: DataMode;
}

export interface ReassessmentJobRecord {
  id: string;
  incidentId: string;
  reason: string;
  actor: string;
  status: 'queued' | 'running' | 'completed' | 'superseded' | 'failed';
  attempts: number;
  assessmentId?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export interface PredictionRecord {
  id: string;
  predictionType: 'escalation' | 'resource_shortage' | 'demand_growth' | 'warehouse_depletion' | 'delivery_delay';
  targetId: string;
  targetName: string;
  forecastHorizonHours: number;
  modelVersion: string;
  methodology: string;
  inputFeatures: Record<string, number | string>;
  predictionSummary: string;
  projectedValue: number;
  unit: string;
  uncertaintyNote: string;
  actualOutcome?: string | null;
  mode: DataMode;
  createdAt: string;
}

export interface RequestItem {
  category: ResourceCategory;
  itemName: string;
  quantity: number;
  fulfilledQuantity: number;
  unit: string;
}

export interface PriorityBreakdown {
  severityScore: number;
  needScore: number;
  vulnerabilityScore: number;
  urgencyScore: number;
  accessScore: number;
  weights: { S: number; N: number; V: number; U: number; A: number };
  algorithmicScore: number;
  algorithmicCategory: Severity;
  calculationVersion: string;
  missingInformation: string[];
  override?: {
    previousCategory: Severity;
    newCategory: Severity;
    reason: string;
    userId: string;
    timestamp: string;
  };
}

export interface ReliefRequest {
  id: string;
  incidentId: string;
  orgId: string;
  requestingOrg?: string;
  requesterRole: UserRole;
  requesterName: string;
  contactMasked: string;
  locationName: string;
  lat: number;
  lng: number;
  peopleAffected: number;
  familiesAffected: number;
  vulnerableGroups: string[];
  urgency: Severity;
  deliveryDeadline?: string | null;
  items: RequestItem[];
  notes: string;
  status: ReliefStatus;
  verificationStatus: 'unverified' | 'verified';
  fulfillmentStatus?: 'unfulfilled' | 'partially_fulfilled' | 'fulfilled';
  priorityScore: number;
  priorityCategory: Severity;
  priorityBreakdown: PriorityBreakdown;
  mode: DataMode;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Warehouse {
  id: string;
  name: string;
  warehouseType?: WarehouseType;
  location: string;
  region: string;
  district?: string;
  state?: string;
  country?: string;
  lat: number;
  lng: number;
  orgId: string;
  managerName?: string;
  capacityUnits: number;
  usedUnits: number;
  status: WarehouseStatus;
  contact: string;
  operatingHours: string;
  accessibility: 'high' | 'moderate' | 'restricted';
  supportedResponseTypes?: IncidentType[];
  active?: boolean;
  lastVerified: string;
  mode: DataMode;
  createdAt?: string;
  updatedAt: string;
}

export interface InventoryCatalogItem {
  id: string;
  sku: string;
  name: string;
  category: ResourceCategory;
  categoryGroup:
    | 'Food & Nutrition'
    | 'Water & Hydration'
    | 'Medical & Healthcare'
    | 'Shelter & Protection'
    | 'Clothing'
    | 'Rescue Equipment'
    | 'Infrastructure & Utilities'
    | 'Other';
  description: string;
  unit: string;
  minStock: number;
  criticalStock: number;
  reorderQty: number;
  storageRequirements: string;
  expiryTracking: boolean;
  supplier: string;
  active: boolean;
  mode: DataMode;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryBatch {
  id: string;
  stockId: string;
  warehouseId: string;
  itemId?: string;
  sku: string;
  itemName: string;
  lotNumber: string;
  quantity: number;
  receivedDate: string;
  expiryDate: string | null;
  qualityStatus: 'good' | 'quarantined' | 'damaged' | 'expired';
  storageRequirements: string;
  batchLocation: string;
  mode: DataMode;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryStock {
  id: string;
  itemId?: string;
  warehouseId: string;
  sku: string;
  itemName: string;
  category: ResourceCategory;
  unit: string;
  totalQty: number;
  availableQty: number;
  reservedQty: number;
  inTransitQty: number;
  damagedQty: number;
  expiredQty: number;
  minStock: number;
  criticalStock?: number;
  reorderThreshold: number;
  stockStatus?: StockAlertLevel;
  version: number;
  mode: DataMode;
  updatedAt: string;
}

export interface StockMovement {
  id: string;
  idempotencyKey?: string;
  stockId: string;
  itemId?: string;
  warehouseId: string;
  itemName: string;
  type: MovementType;
  quantity: number;
  previousAvailable: number;
  newAvailable: number;
  reason: string;
  referenceId?: string;
  actor: string;
  role: UserRole;
  orgId?: string;
  mode: DataMode;
  createdAt: string;
}

export type ReservationStatus =
  | 'Requested'
  | 'Reserved'
  | 'Partially Reserved'
  | 'Allocated'
  | 'Dispatched'
  | 'Delivered'
  | 'Reservation Released'
  | 'Expired'
  | 'Cancelled';

export interface StockReservation {
  id: string;
  requestId?: string | null;
  incidentId?: string | null;
  warehouseId: string;
  warehouseName: string;
  stockId: string;
  itemId?: string;
  sku: string;
  itemName: string;
  category: ResourceCategory;
  unit: string;
  requestedQty: number;
  reservedQty: number;
  status: ReservationStatus;
  expiresAt: string;
  orgId: string;
  reservedBy: string;
  notes?: string;
  auditHistory: { timestamp: string; actor: string; action: string; detail: string }[];
  mode: DataMode;
  createdAt: string;
  updatedAt: string;
}

export type IncomingSupplyStatus =
  | 'Pending'
  | 'Approved'
  | 'In Transit'
  | 'Partially Received'
  | 'Received'
  | 'Verified'
  | 'Delayed'
  | 'Cancelled';

export interface IncomingSupplyItem {
  itemId?: string;
  sku: string;
  itemName: string;
  category: ResourceCategory;
  unit: string;
  orderedQty: number;
  receivedQty: number;
  damagedQty: number;
  lotNumber?: string;
  expiryDate?: string | null;
}

export interface IncomingSupplyOrder {
  id: string;
  supplier: string;
  warehouseId: string;
  warehouseName: string;
  trackingReference: string;
  expectedArrival: string;
  actualArrival: string | null;
  status: IncomingSupplyStatus;
  verificationStatus: 'unverified' | 'verified' | 'discrepancy';
  items: IncomingSupplyItem[];
  discrepancyNotes?: string;
  orgId: string;
  createdBy: string;
  verifiedBy?: string | null;
  mode: DataMode;
  createdAt: string;
  updatedAt: string;
}

export interface ReplenishmentRecommendation {
  stockId: string;
  itemName: string;
  sku: string;
  category: ResourceCategory;
  warehouseId: string;
  warehouseName: string;
  currentAvailable: number;
  minThreshold: number;
  criticalThreshold: number;
  alertLevel: StockAlertLevel;
  averageDailyDemand: number | null;
  averageDemandLabel: string;
  incomingSupplyQty: number;
  recommendedReplenishmentQty: number;
  reason: string;
  priority: Severity;
  timestamp: string;
}

export interface WarehouseMatchRecommendation {
  warehouseId: string;
  warehouseName: string;
  warehouseStatus: WarehouseStatus;
  accessibility: Warehouse['accessibility'];
  resourceName: string;
  category: ResourceCategory;
  availableQty: number;
  requestedQty: number;
  fulfillableQty: number;
  shortageQty: number;
  estimatedDistanceKm: number | null;
  score: number;
  incompleteData: boolean;
  reason: string;
}

export interface AllocationPriorityResult {
  score: number;
  band: AllocationPriorityLevel;
  reasoning: string[];
  evidence: string[];
  missingInformation: string[];
  fairnessAgingBoost: number;
  waitingHours: number;
  timestamp: string;
  scoreVersion: string;
}

export interface AllocationAlternative {
  warehouseId: string;
  warehouseName: string;
  warehouseStatus: WarehouseStatus;
  fulfillableQty: number;
  distanceKm: number;
  estimatedDurationMin: number | null;
  hasAvailableVehicle: boolean;
  score: number;
  reason: string;
}

export interface AllocationLineItem {
  warehouseId: string;
  warehouseName: string;
  stockId: string;
  sku?: string;
  itemName: string;
  category: ResourceCategory;
  quantity: number;
  unit: string;
  distanceKm: number;
  estimatedEtaMin: number | null;
  candidateScore: number;
  expiryRiskNote?: string | null;
}

export interface Allocation {
  id: string;
  requestId: string;
  incidentId: string;
  status: 'proposed' | 'approved' | 'rejected' | 'reserved' | 'dispatched' | 'completed';
  splitAllocation: boolean;
  items: AllocationLineItem[];
  unmetItems: { category: ResourceCategory; itemName: string; quantity: number; unit: string }[];
  fulfillmentPct?: number;
  recommendedVehicleId: string | null;
  totalDistanceKm: number;
  estimatedDurationMin: number | null;
  routeProvider: string;
  roadConditionsNotice: string;
  explanation: string;
  constraints: string[];
  warnings: string[];
  alternatives?: AllocationAlternative[];
  priorityResult?: AllocationPriorityResult;
  reservationIds?: string[];
  dataFreshness?: FreshnessStatus;
  fairnessNotes?: string[];
  confidence: number;
  requiresApproval: true;
  approvedBy?: string;
  approvedAt?: string;
  rejectionReason?: string;
  mode: DataMode;
  createdAt: string;
  updatedAt: string;
}

export interface VehicleHistoryEntry {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  previousStatus?: VehicleStatus;
  newStatus?: VehicleStatus;
  dispatchId?: string | null;
  note?: string;
}

export interface Vehicle {
  id: string;
  registrationNumber?: string;
  callsign: string;
  name?: string;
  vehicleType: VehicleType;
  orgId: string;
  warehouseId: string;
  capacityKg: number;
  capacityUnits: number;
  capacityUnit?: string;
  status: VehicleStatus;
  driverId?: string | null;
  driverTeam: string;
  driverContact?: string;
  fuelPct?: number | null;
  maintenanceStatus?: 'operational' | 'due_soon' | 'in_maintenance' | 'out_of_service';
  equipment?: string[];
  lastServiceDate?: string | null;
  lat: number | null;
  lng: number | null;
  lastLocationAt: string | null;
  gpsSource: 'authorized_device' | 'last_known' | 'simulated_demo' | 'unavailable';
  assignedDispatchId: string | null;
  history?: VehicleHistoryEntry[];
  mode: DataMode;
  createdAt?: string;
  updatedAt: string;
}

export interface Driver {
  id: string;
  name: string;
  contact: string;
  contactMasked: string;
  orgId: string;
  status: DriverStatus;
  assignedVehicleId: string | null;
  assignedDispatchId: string | null;
  certifications: string[];
  lastKnownLat: number | null;
  lastKnownLng: number | null;
  lastLocationAt: string | null;
  assignmentHistory: {
    id: string;
    timestamp: string;
    action: string;
    vehicleId?: string | null;
    dispatchId?: string | null;
    actor: string;
  }[];
  mode: DataMode;
  createdAt: string;
  updatedAt: string;
}

export interface RouteHazardReport {
  id: string;
  type: 'closure' | 'flood' | 'landslide' | 'bridge_damage' | 'severe_weather' | 'debris' | 'other';
  severity: Severity;
  lat: number;
  lng: number;
  radiusKm: number;
  description: string;
  source: string;
  verified: boolean;
  reportedBy: string;
  active: boolean;
  mode: DataMode;
  createdAt: string;
  updatedAt: string;
}

export interface RouteRiskAssessment {
  riskBand: RouteRiskBand;
  hazards: {
    id: string;
    type: string;
    severity: string;
    description: string;
    distanceFromRouteKm: number;
    source: string;
    verified: boolean;
  }[];
  source: string;
  sourceTimestamp: string;
  confidence: number | null;
  missingInformation: string[];
  lastVerificationTime: string | null;
  safetyNotice: string;
}

export interface RouteAlternativeSummary {
  id: string;
  label: string;
  distanceKm: number;
  durationMin: number | null;
  deltaDistanceKm: number;
  deltaDurationMin: number | null;
  geometry: { lat: number; lng: number }[];
  riskBand: RouteRiskBand;
  hazardsCount: number;
  selectionReason: string;
}

export interface RouteResult {
  id: string;
  provider: 'osrm' | 'google_routes_v2' | 'openrouteservice' | 'haversine_fallback' | 'unavailable';
  routeStatus?: RouteStatus;
  origin: { lat: number; lng: number; label: string };
  destination: { lat: number; lng: number; label: string };
  waypoints: { lat: number; lng: number; label: string; order: number; etaMin?: number }[];
  vehicleType?: VehicleType;
  distanceKm: number;
  durationMin: number | null;
  geometry: { lat: number; lng: number }[];
  instructions: string[];
  roadConditionsNotice: string;
  alternativesCount: number;
  alternatives?: RouteAlternativeSummary[];
  riskAssessment?: RouteRiskAssessment;
  timestamp: string;
  expiresAt?: string;
  cacheHit?: boolean;
  freshnessStatus: FreshnessStatus;
  gmpQuotaExceeded?: boolean;
}

export interface DispatchItemRecord {
  stockId: string;
  sku?: string;
  itemName: string;
  category: ResourceCategory;
  quantity: number;
  deliveredQty: number;
  damagedQty: number;
  unit: string;
  warehouseId: string;
  warehouseName: string;
}

export interface DispatchPlan {
  id: string;
  requestId: string;
  incidentId: string;
  allocationId: string | null;
  priorityLevel: AllocationPriorityLevel;
  warehouseId: string;
  warehouseName: string;
  vehicleId: string | null;
  vehicleCallsign: string | null;
  driverId: string | null;
  driverName: string | null;
  items: DispatchItemRecord[];
  totalUnits: number;
  estimatedWeightKg: number;
  vehicleCapacityOk: boolean;
  capacityWarning: string | null;
  route: RouteResult | null;
  routeRisk: RouteRiskAssessment | null;
  deliveryDeadline: string | null;
  estimatedArrivalAt: string | null;
  etaStatus: EtaStatus;
  feasibilityWarnings: string[];
  readyForApproval: boolean;
  mode: DataMode;
  createdAt: string;
}

export interface Dispatch {
  id: string;
  allocationId: string;
  requestId: string;
  incidentId: string;
  warehouseId: string;
  warehouseName: string;
  vehicleId: string;
  vehicleCallsign: string;
  driverId?: string | null;
  driverName?: string | null;
  priorityLevel?: AllocationPriorityLevel;
  destinationName: string;
  destinationLat: number;
  destinationLng: number;
  items?: DispatchItemRecord[];
  reservationIds?: string[];
  status: DispatchStatus;
  approvalStatus?: 'pending_approval' | 'approved' | 'rejected';
  approvedBy?: string | null;
  approvedAt?: string | null;
  rejectedBy?: string | null;
  rejectionReason?: string | null;
  deliveryDeadline?: string | null;
  initialEtaMin?: number | null;
  currentEtaMin?: number | null;
  etaStatus?: EtaStatus;
  etaHistory?: { timestamp: string; etaMin: number | null; etaStatus: EtaStatus; reason: string }[];
  actualDepartureAt?: string | null;
  actualArrivalAt?: string | null;
  deliveredAt?: string | null;
  route: RouteResult | null;
  routeRisk?: RouteRiskAssessment | null;
  currentLat: number | null;
  currentLng: number | null;
  lastLocationAt?: string | null;
  trackingStatus?: TrackingStatus;
  gpsLabel: string;
  locationHistory?: { lat: number; lng: number; timestamp: string; source: string; speedKmh?: number | null }[];
  deliveryConfirmationId?: string | null;
  events: { id: string; status: DispatchStatus; note: string; actor: string; timestamp: string }[];
  mode: DataMode;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryItemRecord {
  stockId: string;
  sku?: string;
  itemName: string;
  category: ResourceCategory;
  dispatchedQty: number;
  deliveredQty: number;
  damagedQty: number;
  remainingQty: number;
  unit: string;
}

export interface DeliveryConfirmation {
  id: string;
  dispatchId: string;
  requestId: string;
  incidentId: string;
  allocationId: string;
  warehouseId: string;
  items: DeliveryItemRecord[];
  status: DeliveryStatus;
  recipientName: string;
  recipientOrg: string;
  recipientRole?: string;
  notes: string;
  proofRef?: string | null;
  confirmedBy: string;
  confirmedAt: string;
  verifiedBy?: string | null;
  verifiedAt?: string | null;
  discrepancyNotes?: string | null;
  mode: DataMode;
  createdAt: string;
  updatedAt: string;
}

export interface LogisticsAIAdvisory {
  id: string;
  summary: string;
  recommended_action: string;
  allocation_explanation: string;
  warehouse_comparison: string[];
  route_comparison: string[];
  risks: string[];
  constraints: string[];
  missing_data: string[];
  evidence_references: string[];
  confidence: number | null;
  model_used: string;
  requires_human_approval: true;
  timestamp: string;
  mode: DataMode;
}

export interface AppNotification {
  id: string;
  dedupKey: string;
  userId: string;
  orgId: string;
  eventType: string;
  severity: 'info' | 'warning' | 'high' | 'critical';
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
  read: boolean;
  channel: 'in_app' | 'email';
  mode: DataMode;
  createdAt: string;
}

export interface StructuredAIAgentOutput {
  task_id: string;
  agent_type: AgentType;
  model_used: string;
  status: 'completed' | 'failed';
  summary: string;
  recommendations: {
    title: string;
    action: string;
    priority: Severity;
    rationale: string;
  }[];
  evidence: string[];
  source_ids: string[];
  missing_information: string[];
  uncertainty: {
    level: 'low' | 'medium' | 'high';
    notes: string;
  };
  confidence: number | null;
  created_at: string;
  requires_approval: true;
  mode: DataMode;
}

export interface SystemEvent {
  event_id: string;
  event_type: string;
  organization_id: string;
  entity_id: string;
  timestamp: string;
  version: number;
  source: string;
  mode: DataMode;
  payload: Record<string, unknown>;
  correlation_id: string;
}

export interface AuditLog {
  id: string;
  timestamp: string;
  actor: string;
  role: UserRole;
  orgId: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  mode: DataMode;
}

export interface IntegrationHealth {
  id: string;
  name: string;
  provider: string;
  status: 'healthy' | 'degraded' | 'offline' | 'unconfigured';
  lastSuccessAt: string | null;
  lastError: string | null;
  latencyMs: number | null;
  freshnessLimitSeconds: number;
  notes: string;
}

// ============================================================================
// PHASE 6 — AUTONOMOUS EMERGENCY COORDINATION & MULTI-AGENT INTELLIGENCE
// ============================================================================

export type CoordinationAgentId =
  | 'agent-emergency-intel'
  | 'agent-environmental-intel'
  | 'agent-resource-intel'
  | 'agent-logistics-intel'
  | 'agent-human-impact'
  | 'agent-response-planner'
  | 'agent-response-monitor'
  | 'agent-safety-verifier';

export type AIAgentRuntimeStatus =
  | 'IDLE'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'CANCELLED'
  | 'DEGRADED';

export type ClaimClassification =
  | 'VERIFIED FACT'
  | 'CALCULATED RESULT'
  | 'AI INTERPRETATION'
  | 'ASSUMPTION'
  | 'UNKNOWN';

export type SafetyValidationStatus =
  | 'VALID'
  | 'VALID_WITH_WARNINGS'
  | 'INCOMPLETE'
  | 'REJECTED';

export type CoordinationSessionStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'FAILED'
  | 'CANCELLED';

export type AgentTaskStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'CANCELLED'
  | 'SKIPPED';

export interface AIAgentDefinition {
  agent_id: CoordinationAgentId;
  name: string;
  role: string;
  description: string;
  version: string;
  phase: 'A_PARALLEL' | 'B_SEQUENTIAL' | 'C_SYNTHESIS' | 'D_MONITORING' | 'E_VERIFICATION';
  allowed_tools: string[];
  permissions: string[];
  read_only: boolean;
  can_execute_mutations: boolean;
  model_config: {
    provider: 'gemini' | 'openai' | 'deterministic';
    primary_model: string;
    fallback_model: string;
    deterministic_core: boolean;
  };
  max_execution_time_ms: number;
  max_tool_calls: number;
  output_schema: string;
  error_policy: 'fail_partial' | 'retry_then_degrade' | 'hard_block_on_reject';
  runtime_status: AIAgentRuntimeStatus;
  last_run_at: string | null;
  last_duration_ms: number | null;
  total_runs: number;
  failed_runs: number;
  active: boolean;
  updated_at: string;
}

export interface AIAgentVersionRecord {
  version_id: string;
  agent_id: CoordinationAgentId;
  version: string;
  changelog: string;
  allowed_tools: string[];
  model_primary: string;
  created_at: string;
}

export interface AIEvidenceRecord {
  evidence_id: string;
  session_id: string;
  task_id: string;
  agent_id: CoordinationAgentId;
  org_id: string;
  source_type:
    | 'incident'
    | 'incident_report'
    | 'risk_assessment'
    | 'weather'
    | 'warehouse'
    | 'inventory'
    | 'reservation'
    | 'incoming_supply'
    | 'relief_request'
    | 'allocation'
    | 'vehicle'
    | 'driver'
    | 'route'
    | 'route_hazard'
    | 'dispatch'
    | 'delivery'
    | 'memory'
    | 'ai_synthesis'
    | 'safety_check';
  source_id: string;
  claim: string;
  claim_classification: ClaimClassification;
  observed_at: string | null;
  retrieved_at: string;
  source_status: 'LIVE' | 'FRESH' | 'STALE' | 'UNAVAILABLE' | 'UNVERIFIED' | 'SIMULATED';
  data_snapshot?: Record<string, unknown>;
  mode: DataMode;
}

export interface AIRecommendation {
  recommendation_id: string;
  session_id: string;
  task_id: string;
  agent_id: CoordinationAgentId;
  org_id: string;
  type:
    | 'verification'
    | 'resource_allocation'
    | 'stock_reservation'
    | 'dispatch_plan'
    | 'route_reassignment'
    | 'warehouse_rebalance'
    | 'humanitarian_priority'
    | 'monitoring_alert'
    | 'replenishment'
    | 'safety_caution';
  priority: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  description: string;
  action_type:
    | 'CREATE_ALLOCATION'
    | 'CREATE_PENDING_DISPATCH'
    | 'RESERVE_STOCK'
    | 'ESCALATE_INCIDENT'
    | 'REASSESS_RISK'
    | 'FIELD_VERIFICATION'
    | 'REASSIGN_ROUTE'
    | 'REQUEST_REPLENISHMENT'
    | 'ADVISORY_ONLY';
  proposed_parameters: Record<string, unknown>;
  reasoning: string;
  evidence_ids: string[];
  constraints: string[];
  risk: string;
  requires_human_approval: true;
  created_at: string;
  mode: DataMode;
}

export interface AIAgentResult {
  result_id: string;
  agent_id: CoordinationAgentId;
  agent_version: string;
  session_id: string;
  task_id: string;
  org_id: string;
  status: 'COMPLETED' | 'DEGRADED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED';
  summary: string;
  findings: {
    title: string;
    detail: string;
    classification: ClaimClassification;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    evidence_ids: string[];
  }[];
  recommendations: AIRecommendation[];
  evidence: AIEvidenceRecord[];
  missing_information: string[];
  warnings: string[];
  confidence: number | null;
  data_freshness: 'FRESH' | 'PARTIAL' | 'STALE' | 'UNAVAILABLE';
  tool_calls_used: number;
  tools_invoked: string[];
  ai_provider_used: string | null;
  ai_model_used: string | null;
  ai_synthesis_status: 'LIVE_AI' | 'DETERMINISTIC_ONLY' | 'AI_UNAVAILABLE';
  tokens_estimated: number;
  created_at: string;
  execution_time_ms: number;
  mode: DataMode;
}

export interface AIAgentTask {
  task_id: string;
  session_id: string;
  agent_id: CoordinationAgentId;
  agent_name: string;
  agent_version: string;
  org_id: string;
  phase: AIAgentDefinition['phase'];
  depends_on_agents: CoordinationAgentId[];
  status: AgentTaskStatus;
  attempt: number;
  max_attempts: number;
  tool_calls_used: number;
  max_tool_calls: number;
  started_at: string | null;
  completed_at: string | null;
  execution_time_ms: number | null;
  result_id: string | null;
  error_message: string | null;
  mode: DataMode;
}

export interface AICoordinationEvent {
  event_id: string;
  session_id: string;
  org_id: string;
  event_type: string;
  agent_id?: CoordinationAgentId | 'orchestrator' | 'human';
  task_id?: string;
  summary: string;
  details?: Record<string, unknown>;
  created_at: string;
  mode: DataMode;
}

export interface AIConflictRecord {
  conflict_id: string;
  session_id: string;
  plan_id: string | null;
  org_id: string;
  incident_id: string | null;
  conflict_type:
    | 'WAREHOUSE_SHORTAGE_VS_PREFERENCE'
    | 'ROUTE_HAZARD_VS_PRIORITY'
    | 'WEATHER_RISK_VS_DISPATCH'
    | 'COMPETING_INCIDENT_DEMAND'
    | 'UNAVAILABLE_RESOURCE_PROPOSED'
    | 'UNVERIFIED_SOURCE_CONFLICT';
  severity: 'critical' | 'high' | 'medium';
  involved_agents: CoordinationAgentId[];
  title: string;
  description: string;
  conflicting_claims: { agent_id: CoordinationAgentId; claim: string; evidence_ids: string[] }[];
  revalidated_fact: string;
  resolution_status: 'OPEN' | 'RESOLVED_DETERMINISTIC' | 'ESCALATED_HUMAN' | 'RESOLVED_HUMAN';
  resolution_strategy: string;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
  mode: DataMode;
}

export interface AISafetyValidationReport {
  validation_id: string;
  session_id: string;
  plan_id: string;
  status: SafetyValidationStatus;
  checked_at: string;
  checks: {
    check_name: string;
    category: 'incident' | 'risk' | 'inventory' | 'warehouse' | 'fleet' | 'route' | 'evidence' | 'rbac' | 'safety';
    passed: boolean;
    severity: 'blocking' | 'warning' | 'info';
    detail: string;
  }[];
  blocking_issues: string[];
  warnings: string[];
  missing_evidence: string[];
  verified_evidence_count: number;
  unverified_claim_count: number;
  rbac_verified: boolean;
  stale_data_detected: boolean;
}

export interface AIPlanAction {
  action_id: string;
  plan_id: string;
  session_id: string;
  org_id: string;
  recommendation_id: string | null;
  title: string;
  description: string;
  action_type: AIRecommendation['action_type'];
  priority: 'critical' | 'high' | 'medium' | 'low';
  proposed_parameters: Record<string, unknown>;
  modified_parameters: Record<string, unknown> | null;
  evidence_ids: string[];
  constraints: string[];
  risk: string;
  status:
    | 'PROPOSED'
    | 'APPROVED'
    | 'MODIFIED'
    | 'REJECTED'
    | 'DEFERRED'
    | 'EXECUTED'
    | 'EXECUTION_BLOCKED'
    | 'INVALIDATED';
  requires_human_approval: true;
  executed_at: string | null;
  executed_by: string | null;
  execution_result: Record<string, unknown> | null;
  execution_error: string | null;
  mode: DataMode;
}

export interface AIResponsePlan {
  plan_id: string;
  session_id: string;
  incident_id: string | null;
  org_id: string;
  version: number;
  title: string;
  incident_summary: string;
  risk_summary: string;
  human_impact_summary: string;
  resource_strategy: string;
  logistics_and_route_plan: string;
  alternative_options: { title: string; summary: string; tradeoffs: string }[];
  unresolved_conflicts: string[];
  missing_information: string[];
  verification_needed: string[];
  evidence_ids: string[];
  safety_validation: AISafetyValidationReport;
  status:
    | 'DRAFT'
    | 'PENDING_APPROVAL'
    | 'APPROVED'
    | 'PARTIALLY_APPROVED'
    | 'MODIFIED'
    | 'REJECTED'
    | 'DEFERRED'
    | 'EXECUTED'
    | 'INVALIDATED'
    | 'EXPIRED';
  expires_at: string;
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  modification_notes: string | null;
  ai_synthesis_note: string | null;
  requires_human_approval: true;
  created_at: string;
  updated_at: string;
  mode: DataMode;
}

export interface AIApprovalRequest {
  approval_id: string;
  plan_id: string;
  session_id: string;
  incident_id: string | null;
  org_id: string;
  title: string;
  impact_level: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  requested_by: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'MODIFIED' | 'DEFERRED' | 'EXPIRED' | 'EXECUTED' | 'INVALIDATED';
  action_ids: string[];
  safety_status: SafetyValidationStatus;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  updated_at: string;
  mode: DataMode;
}

export interface AIApprovalEvent {
  event_id: string;
  approval_id: string;
  plan_id: string;
  org_id: string;
  decision:
    | 'CREATED'
    | 'APPROVED'
    | 'REJECTED'
    | 'MODIFIED'
    | 'DEFERRED'
    | 'ESCALATED'
    | 'REANALYSIS_REQUESTED'
    | 'EXECUTED'
    | 'EXECUTION_BLOCKED'
    | 'INVALIDATED';
  actor_id: string;
  actor_name: string;
  actor_role: UserRole;
  note: string;
  revalidation_passed?: boolean;
  created_at: string;
  mode: DataMode;
}

export interface AICoordinationSession {
  session_id: string;
  org_id: string;
  incident_id: string | null;
  incident_title: string | null;
  trigger_source: 'manual_operator' | 'incident_panel' | 'proactive_trigger' | 'reanalysis' | 'api';
  objective: string;
  status: CoordinationSessionStatus;
  initiated_by: string;
  initiated_role: UserRole;
  agent_ids: CoordinationAgentId[];
  plan_id: string | null;
  approval_id: string | null;
  safety_status: SafetyValidationStatus | null;
  conflict_count: number;
  evidence_count: number;
  limits: {
    max_agents: number;
    max_parallel: number;
    max_tool_calls_per_agent: number;
    timeout_ms: number;
    token_budget: number;
  };
  metrics: {
    started_at: string;
    completed_at: string | null;
    total_execution_ms: number | null;
    completed_agents: number;
    failed_agents: number;
    total_tool_calls: number;
    tokens_estimated: number;
    provider_used: string | null;
    ai_available: boolean;
  };
  cancel_requested: boolean;
  error_message: string | null;
  mode: DataMode;
  created_at: string;
  updated_at: string;
}

export interface AISessionMemory {
  memory_id: string;
  session_id: string;
  incident_id: string | null;
  org_id: string;
  memory_type: 'session_context' | 'verified_incident_history' | 'human_decision' | 'ai_conclusion';
  classification: ClaimClassification;
  title: string;
  content: string;
  structured_data?: Record<string, unknown>;
  source_refs: string[];
  version: number;
  compressed: boolean;
  expires_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  mode: DataMode;
}

export type AISimulationType =
  | 'flood_escalation'
  | 'rainfall_increase'
  | 'warehouse_closure'
  | 'resource_shortage'
  | 'vehicle_breakdown'
  | 'route_disruption'
  | 'new_emergency_request'
  | 'population_increase'
  | 'delivery_delay'
  | 'power_outage'
  | 'multi_incident';

export interface AISimulationSession {
  simulation_id: string;
  org_id: string;
  incident_id: string | null;
  title: string;
  scenario_type: AISimulationType;
  label: 'SIMULATION — NOT A LIVE EMERGENCY';
  parameters: Record<string, unknown>;
  status: 'CREATED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  created_by: string;
  created_at: string;
  completed_at: string | null;
  result_id: string | null;
  mutated_live_data: false;
  mode: DataMode;
}

export interface AISimulationResult {
  result_id: string;
  simulation_id: string;
  org_id: string;
  label: 'SIMULATION — NOT A LIVE EMERGENCY';
  scenario_type: AISimulationType;
  baseline_metrics: {
    incident_risk_score: number | null;
    total_demand_units: number;
    total_available_stock: number;
    shortage_units: number;
    fulfillment_pct: number;
    operational_warehouses: number;
    available_vehicles: number;
    estimated_delivery_min: number | null;
  };
  projected_metrics: {
    incident_risk_score: number | null;
    total_demand_units: number;
    total_available_stock: number;
    shortage_units: number;
    fulfillment_pct: number;
    operational_warehouses: number;
    available_vehicles: number;
    estimated_delivery_min: number | null;
  };
  deltas: {
    risk_score_delta: number;
    shortage_delta: number;
    fulfillment_pct_delta: number;
    delivery_delay_min_delta: number;
  };
  risk_escalation_notes: string[];
  supply_impact_notes: string[];
  route_and_fleet_notes: string[];
  recommended_contingencies: string[];
  evidence_basis: string[];
  mutated_live_data: false;
  created_at: string;
  mode: DataMode;
}

export interface AITriggerEvent {
  trigger_id: string;
  org_id: string;
  trigger_type:
    | 'INCIDENT_RISK_THRESHOLD_CROSSED'
    | 'CRITICAL_INCIDENT_VERIFIED'
    | 'SEVERE_WEATHER_CHANGE'
    | 'WAREHOUSE_UNAVAILABLE'
    | 'CRITICAL_STOCK_SHORTAGE'
    | 'DISPATCH_DELAYED'
    | 'ROUTE_HAZARD_VERIFIED'
    | 'PARTIAL_DELIVERY_UNMET_NEED'
    | 'HIGH_PRIORITY_REQUEST_CREATED'
    | 'VEHICLE_UNAVAILABLE';
  dedup_key: string;
  entity_type: string;
  entity_id: string;
  incident_id: string | null;
  severity: 'critical' | 'high' | 'medium';
  title: string;
  reason: string;
  recommended_action: string;
  status: 'ACTIVE' | 'ACKNOWLEDGED' | 'SESSION_STARTED' | 'DISMISSED';
  linked_session_id: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  cooldown_minutes: number;
  created_at: string;
  mode: DataMode;
}

export interface AIProviderStatus {
  primary_provider: 'gemini' | 'openai' | 'none';
  fallback_provider: 'gemini' | 'openai' | 'deterministic';
  providers: {
    id: 'gemini' | 'openai';
    configured: boolean;
    status: 'healthy' | 'degraded' | 'unconfigured';
    primary_model: string;
    fallback_model: string;
    last_success_at: string | null;
    last_error: string | null;
    total_calls: number;
    failed_calls: number;
    avg_latency_ms: number | null;
  }[];
  rate_limit_per_minute: number;
  default_token_budget: number;
}

export interface AICoordinationAnalytics {
  mode: DataMode;
  total_sessions: number;
  completed_sessions: number;
  partial_sessions: number;
  failed_sessions: number;
  cancelled_sessions: number;
  avg_session_duration_ms: number | null;
  agent_metrics: {
    agent_id: CoordinationAgentId;
    name: string;
    total_tasks: number;
    completed_tasks: number;
    failed_tasks: number;
    success_rate_pct: number | null;
    avg_execution_ms: number | null;
  }[];
  plans_total: number;
  plans_approved: number;
  plans_modified: number;
  plans_rejected: number;
  plans_executed: number;
  approval_rate_pct: number | null;
  modification_rate_pct: number | null;
  rejection_rate_pct: number | null;
  conflicts_total: number;
  conflicts_resolved: number;
  conflicts_open: number;
  evidence_total: number;
  evidence_by_classification: Record<ClaimClassification, number>;
  safety_rejections: number;
  safety_warnings: number;
  triggers_total: number;
  triggers_active: number;
  simulations_total: number;
  tokens_estimated_total: number;
  provider_health: AIProviderStatus;
}

export type AuthProviderType = 'password' | 'google' | 'both';

export interface AuthUserProfile {
  id: string;
  uid: string;
  email: string;
  name: string;
  role: UserRole;
  baseRole: UserRole;
  orgId: string;
  provider: AuthProviderType;
  emailVerified: boolean;
  firebaseUid?: string | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string;
}


