import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type {
  AIAgentDefinition,
  AIAgentResult,
  AIAgentTask,
  AIAgentVersionRecord,
  AIApprovalEvent,
  AIApprovalRequest,
  AIConflictRecord,
  AICoordinationEvent,
  AICoordinationSession,
  AIEvidenceRecord,
  AIPlanAction,
  AIRecommendation,
  AIResponsePlan,
  AIRiskBriefing,
  AISessionMemory,
  AISimulationResult,
  AISimulationSession,
  AITriggerEvent,
  AlertRecord,
  Allocation,
  AppNotification,
  AuditLog,
  AuthProviderType,
  DataMode,
  DeliveryConfirmation,
  Dispatch,
  Driver,
  Incident,
  IncidentReportRecord,
  IncomingSupplyOrder,
  IntegrationHealth,
  InventoryBatch,
  InventoryCatalogItem,
  InventoryStock,
  LogisticsAIAdvisory,
  Organization,
  PredictionRecord,
  ReassessmentJobRecord,
  ReliefRequest,
  RiskAssessment,
  RouteHazardReport,
  RouteResult,
  StockMovement,
  StockReservation,
  StructuredAIAgentOutput,
  SystemEvent,
  UserRole,
  Vehicle,
  Warehouse,
  WeatherObservation,
} from '../src/shared/types.ts';

export interface AuthUserRecord {
  id: string;
  uid: string;
  email: string;
  name: string;
  role: UserRole;
  baseRole: UserRole;
  orgId: string;
  provider: AuthProviderType;
  emailVerified: boolean;
  firebaseUid: string | null;
  passwordHash: string | null;
  passwordSalt: string | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string;
}

export interface AuthSessionRecord {
  id: string;
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent: string;
}

export interface PasswordResetRecord {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface RiskWeightConfig {
  severity: number;
  environmental: number;
  humanImpact: number;
  vulnerability: number;
  access: number;
  infrastructure: number;
}

export const DEFAULT_RISK_WEIGHTS: RiskWeightConfig = {
  severity: 0.25,
  environmental: 0.2,
  humanImpact: 0.2,
  vulnerability: 0.15,
  access: 0.1,
  infrastructure: 0.1,
};

export interface AllocationWeightConfig {
  fulfillment: number;
  distance: number;
  travelTime: number;
  warehouseStatus: number;
  accessibility: number;
  shortageProtection: number;
  vehicleReadiness: number;
  freshness: number;
}

export const DEFAULT_ALLOCATION_WEIGHTS: AllocationWeightConfig = {
  fulfillment: 0.24,
  distance: 0.14,
  travelTime: 0.12,
  warehouseStatus: 0.12,
  accessibility: 0.1,
  shortageProtection: 0.12,
  vehicleReadiness: 0.1,
  freshness: 0.06,
};

export interface StoreState {
  organizations: Organization[];
  incidents: Incident[];
  incidentReports: IncidentReportRecord[];
  weatherObservations: WeatherObservation[];
  riskAssessments: RiskAssessment[];
  aiRiskAnalyses: AIRiskBriefing[];
  alerts: AlertRecord[];
  reassessmentJobs: ReassessmentJobRecord[];
  predictions: PredictionRecord[];
  reliefRequests: ReliefRequest[];
  warehouses: Warehouse[];
  inventoryCatalog: InventoryCatalogItem[];
  inventory: InventoryStock[];
  inventoryBatches: InventoryBatch[];
  stockMovements: StockMovement[];
  stockReservations: StockReservation[];
  incomingSupplies: IncomingSupplyOrder[];
  allocations: Allocation[];
  vehicles: Vehicle[];
  drivers: Driver[];
  routeRecords: RouteResult[];
  routeHazards: RouteHazardReport[];
  dispatches: Dispatch[];
  deliveryConfirmations: DeliveryConfirmation[];
  logisticsAdvisories: LogisticsAIAdvisory[];
  notifications: AppNotification[];
  aiTasks: StructuredAIAgentOutput[];
  aiAgents: AIAgentDefinition[];
  aiAgentVersions: AIAgentVersionRecord[];
  aiCoordinationSessions: AICoordinationSession[];
  aiAgentTasks: AIAgentTask[];
  aiAgentResults: AIAgentResult[];
  aiCoordinationEvents: AICoordinationEvent[];
  aiEvidenceRecords: AIEvidenceRecord[];
  aiRecommendations: AIRecommendation[];
  aiResponsePlans: AIResponsePlan[];
  aiPlanActions: AIPlanAction[];
  aiApprovalRequests: AIApprovalRequest[];
  aiApprovalEvents: AIApprovalEvent[];
  aiConflicts: AIConflictRecord[];
  aiSessionMemory: AISessionMemory[];
  aiSimulationSessions: AISimulationSession[];
  aiSimulationResults: AISimulationResult[];
  aiTriggerEvents: AITriggerEvent[];
  events: SystemEvent[];
  auditLogs: AuditLog[];
  integrations: IntegrationHealth[];
  settings: {
    priorityWeights: { S: number; N: number; V: number; U: number; A: number };
    riskWeights: RiskWeightConfig;
    allocationWeights: AllocationWeightConfig;
    fairnessAgingPointsPerHour: number;
    fairnessMaxBoost: number;
    weatherFreshnessSeconds: number;
    inventoryFreshnessSeconds: number;
    alertCooldownMinutes: number;
  };
  offlineIdempotency: Record<string, OfflineIdempotencyRecord>;
  authUsers: AuthUserRecord[];
  authSessions: AuthSessionRecord[];
  passwordResets: PasswordResetRecord[];
}

export interface OfflineIdempotencyRecord {
  actionId: string;
  method: string;
  path: string;
  status: number;
  body: unknown;
  processedAt: string;
  replayedFromOffline: boolean;
}

const DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'resqflow-data')
  : path.resolve(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'resqflow_store.json');

function createDefaultOrganizations(): Organization[] {
  const now = new Date().toISOString();
  return [
    {
      id: 'org-central-cmd',
      name: 'National Emergency Operations Center',
      type: 'command_center',
      region: 'Coastal & River Basin Sector',
      contactEmail: 'ops@neoc.resqflow.org',
      activeMembers: 42,
      createdAt: now,
    },
    {
      id: 'org-rapid-relief',
      name: 'Rapid Relief Logistics Corps',
      type: 'logistics',
      region: 'Regional Corridor North',
      contactEmail: 'dispatch@rapidrelief.org',
      activeMembers: 28,
      createdAt: now,
    },
    {
      id: 'org-med-aid',
      name: 'DirectMed Humanitarian Response',
      type: 'medical',
      region: 'Metro & Delta District',
      contactEmail: 'triage@directmed.org',
      activeMembers: 19,
      createdAt: now,
    },
    {
      id: 'org-civic-ngo',
      name: 'Civic Shelter & Water Alliance',
      type: 'ngo',
      region: 'Southern Floodplain',
      contactEmail: 'field@civicshelter.org',
      activeMembers: 35,
      createdAt: now,
    },
  ];
}

function createDefaultIntegrations(): IntegrationHealth[] {
  return [
    {
      id: 'int-weather',
      name: 'Open-Meteo Weather Intelligence',
      provider: 'Open-Meteo REST API',
      status: 'healthy',
      lastSuccessAt: null,
      lastError: null,
      latencyMs: null,
      freshnessLimitSeconds: 900,
      notes: 'Live meteorological telemetry & rainfall triggers (keyless public API).',
    },
    {
      id: 'int-routing',
      name: 'Route Optimization Engine',
      provider: process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY ? 'Google Routes API v2 / OSRM' : 'OSRM Public Router',
      status: 'healthy',
      lastSuccessAt: null,
      lastError: null,
      latencyMs: null,
      freshnessLimitSeconds: 600,
      notes: 'Multi-stop route distance, duration & road geometry calculation.',
    },
    {
      id: 'int-gemini',
      name: 'Gemini AI Orchestration Suite',
      provider: '@google/genai Server SDK',
      status: process.env.GEMINI_API_KEY ? 'healthy' : 'unconfigured',
      lastSuccessAt: null,
      lastError: process.env.GEMINI_API_KEY ? null : 'GEMINI_API_KEY not configured in runtime environment',
      latencyMs: null,
      freshnessLimitSeconds: 300,
      notes: '8 structured agents, Grounding (Search & Maps), Vision, Audio, Video & Live API.',
    },
    {
      id: 'int-firestore',
      name: 'Firebase Firestore & Auth',
      provider: 'Firebase Enterprise Firestore',
      status: 'healthy',
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
      latencyMs: 18,
      freshnessLimitSeconds: 60,
      notes: 'Client-side Google Sign-In, Workspace OAuth token bridge & real-time Firestore sync.',
    },
    {
      id: 'int-realtime',
      name: 'RESQFLOW Real-Time Event Bus',
      provider: 'WebSocket Event Pipeline (/ws/events)',
      status: 'healthy',
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
      latencyMs: 4,
      freshnessLimitSeconds: 30,
      notes: 'Post-persistence event broadcast with cursor reconciliation and backoff.',
    },
  ];
}

export function buildDemoDataset(): Pick<
  StoreState,
  | 'incidents'
  | 'incidentReports'
  | 'reliefRequests'
  | 'warehouses'
  | 'inventoryCatalog'
  | 'inventory'
  | 'inventoryBatches'
  | 'stockMovements'
  | 'stockReservations'
  | 'incomingSupplies'
  | 'vehicles'
  | 'drivers'
  | 'routeHazards'
  | 'allocations'
  | 'dispatches'
  | 'deliveryConfirmations'
  | 'riskAssessments'
  | 'alerts'
  | 'predictions'
  | 'notifications'
> {
  const now = Date.now();
  const ago = (mins: number) => new Date(now - mins * 60_000).toISOString();
  const daysFromNow = (days: number) => new Date(now + days * 24 * 60 * 60_000).toISOString();

  const wh1: Warehouse = {
    id: 'demo-wh-1',
    name: 'Central Coastal Supply Hub (DEMO)',
    warehouseType: 'central_hub',
    location: 'Port Logistics Park, Sector 4, Chennai',
    region: 'Tamil Nadu Coastal',
    district: 'Chennai',
    state: 'Tamil Nadu',
    country: 'India',
    lat: 13.0827,
    lng: 80.2707,
    orgId: 'org-rapid-relief',
    managerName: 'Vikram Sundaram',
    capacityUnits: 50000,
    usedUnits: 7210,
    status: 'operational',
    contact: '+91-44-5550-0101',
    operatingHours: '24/7 Emergency Operations',
    accessibility: 'high',
    supportedResponseTypes: ['flood', 'flash_flood', 'cyclone', 'severe_storm', 'power_failure'],
    active: true,
    lastVerified: ago(12),
    mode: 'demo',
    createdAt: ago(4320),
    updatedAt: ago(12),
  };

  const wh2: Warehouse = {
    id: 'demo-wh-2',
    name: 'Inland Medical & Relief Depot (DEMO)',
    warehouseType: 'medical_cold_chain',
    location: 'Sriperumbudur Industrial Corridor',
    region: 'Kancheepuram District',
    district: 'Kancheepuram',
    state: 'Tamil Nadu',
    country: 'India',
    lat: 12.9675,
    lng: 79.9419,
    orgId: 'org-med-aid',
    managerName: 'Dr. Kavitha Raman',
    capacityUnits: 35000,
    usedUnits: 3378,
    status: 'operational',
    contact: '+91-44-5550-0144',
    operatingHours: '24/7 Emergency Operations',
    accessibility: 'high',
    supportedResponseTypes: ['flood', 'flash_flood', 'heatwave', 'power_failure', 'chemical_incident'],
    active: true,
    lastVerified: ago(25),
    mode: 'demo',
    createdAt: ago(4320),
    updatedAt: ago(25),
  };

  const wh3: Warehouse = {
    id: 'demo-wh-3',
    name: 'South Basin Forward Staging (DEMO)',
    warehouseType: 'forward_staging',
    location: 'Chengalpattu Highway Depot',
    region: 'Chengalpattu Basin',
    district: 'Chengalpattu',
    state: 'Tamil Nadu',
    country: 'India',
    lat: 12.6921,
    lng: 79.9765,
    orgId: 'org-civic-ngo',
    managerName: 'Suresh Natarajan',
    capacityUnits: 18000,
    usedUnits: 700,
    status: 'limited',
    contact: '+91-44-5550-0199',
    operatingHours: '06:00–22:00 (Flood Access Caution)',
    accessibility: 'moderate',
    supportedResponseTypes: ['flood', 'landslide', 'cyclone'],
    active: true,
    lastVerified: ago(45),
    mode: 'demo',
    createdAt: ago(2880),
    updatedAt: ago(45),
  };

  const inventoryCatalog: InventoryCatalogItem[] = [
    {
      id: 'demo-cat-1',
      sku: 'WTR-20L-001',
      name: 'Potable Drinking Water Packs (20L)',
      category: 'drinking_water',
      categoryGroup: 'Water & Hydration',
      description: 'Sealed food-grade 20L potable drinking water jerrycans and purification sachets.',
      unit: 'packs',
      minStock: 1000,
      criticalStock: 400,
      reorderQty: 1500,
      storageRequirements: 'Cool, shaded pallet racking',
      expiryTracking: true,
      supplier: 'AquaSafe Humanitarian Supply (DEMO)',
      active: true,
      mode: 'demo',
      createdAt: ago(4320),
      updatedAt: ago(30),
    },
    {
      id: 'demo-cat-2',
      sku: 'FOD-RTR-002',
      name: 'Ready-to-Eat High-Energy Ration Kits',
      category: 'food',
      categoryGroup: 'Food & Nutrition',
      description: '72-hour family nutrition pack with fortified grains, dry rations, and infant nutrition.',
      unit: 'kits',
      minStock: 800,
      criticalStock: 350,
      reorderQty: 1200,
      storageRequirements: 'Dry climate-controlled bay (<28°C)',
      expiryTracking: true,
      supplier: 'NutriRelief Foods Ltd (DEMO)',
      active: true,
      mode: 'demo',
      createdAt: ago(4320),
      updatedAt: ago(30),
    },
    {
      id: 'demo-cat-3',
      sku: 'MED-TRM-003',
      name: 'Emergency Trauma & First-Aid Kits',
      category: 'medical_kits',
      categoryGroup: 'Medical & Healthcare',
      description: 'Field trauma dressings, ORS packets, antiseptics, and primary triage supplies.',
      unit: 'kits',
      minStock: 200,
      criticalStock: 100,
      reorderQty: 300,
      storageRequirements: 'Temperature-controlled medical vault (15–25°C)',
      expiryTracking: true,
      supplier: 'DirectMed Pharma Logistics (DEMO)',
      active: true,
      mode: 'demo',
      createdAt: ago(4320),
      updatedAt: ago(30),
    },
    {
      id: 'demo-cat-4',
      sku: 'PWR-GEN-006',
      name: 'Portable 5kW Relief Generators',
      category: 'power_equipment',
      categoryGroup: 'Infrastructure & Utilities',
      description: 'Dual-fuel portable emergency generators for shelters and cold-chain clinics.',
      unit: 'units',
      minStock: 15,
      criticalStock: 6,
      reorderQty: 12,
      storageRequirements: 'Ventilated equipment bay; fuel stored separately',
      expiryTracking: false,
      supplier: 'GridShield Power Systems (DEMO)',
      active: true,
      mode: 'demo',
      createdAt: ago(4320),
      updatedAt: ago(30),
    },
    {
      id: 'demo-cat-5',
      sku: 'SHL-TNT-007',
      name: 'All-Weather Family Relief Tents',
      category: 'shelter',
      categoryGroup: 'Shelter & Protection',
      description: 'Waterproof 6-person rapid-deploy shelter tents with tarpaulin groundsheets.',
      unit: 'tents',
      minStock: 150,
      criticalStock: 75,
      reorderQty: 200,
      storageRequirements: 'Elevated dry warehouse shelving',
      expiryTracking: false,
      supplier: 'ShelterCore Relief Fabrics (DEMO)',
      active: true,
      mode: 'demo',
      createdAt: ago(4320),
      updatedAt: ago(30),
    },
    {
      id: 'demo-cat-6',
      sku: 'HYG-KIT-008',
      name: 'Sanitation & Water Purification Kits',
      category: 'hygiene_kits',
      categoryGroup: 'Water & Hydration',
      description: 'Chlorine water purification tablets, soap, and family hygiene kits.',
      unit: 'kits',
      minStock: 200,
      criticalStock: 100,
      reorderQty: 300,
      storageRequirements: 'Dry chemical-safe shelving',
      expiryTracking: true,
      supplier: 'CivicWash Supplies (DEMO)',
      active: true,
      mode: 'demo',
      createdAt: ago(4320),
      updatedAt: ago(30),
    },
    {
      id: 'demo-cat-7',
      sku: 'CLH-KIT-009',
      name: 'Emergency Clothing & Raincoat Kits',
      category: 'clothing',
      categoryGroup: 'Clothing',
      description: 'Waterproof raincoats, thermal blankets, and protective footwear sets.',
      unit: 'kits',
      minStock: 250,
      criticalStock: 100,
      reorderQty: 400,
      storageRequirements: 'Dry textile storage',
      expiryTracking: false,
      supplier: 'CivicWear Relief Co-op (DEMO)',
      active: true,
      mode: 'demo',
      createdAt: ago(4320),
      updatedAt: ago(30),
    },
    {
      id: 'demo-cat-8',
      sku: 'RSC-LJK-010',
      name: 'Swift-Water Life Jackets & Rescue Kits',
      category: 'rescue_equipment',
      categoryGroup: 'Rescue Equipment',
      description: 'High-buoyancy life jackets, throw-ropes, and waterproof LED floodlights.',
      unit: 'kits',
      minStock: 120,
      criticalStock: 50,
      reorderQty: 150,
      storageRequirements: 'Rapid-load rescue bay',
      expiryTracking: false,
      supplier: 'AeroMarine Rescue Gear (DEMO)',
      active: true,
      mode: 'demo',
      createdAt: ago(4320),
      updatedAt: ago(30),
    },
  ];

  const inventory: InventoryStock[] = [
    {
      id: 'demo-inv-1',
      itemId: 'demo-cat-1',
      warehouseId: wh1.id,
      sku: 'WTR-20L-001',
      itemName: 'Potable Drinking Water Packs (20L)',
      category: 'drinking_water',
      unit: 'packs',
      totalQty: 4200,
      availableQty: 3600,
      reservedQty: 600,
      inTransitQty: 400,
      damagedQty: 15,
      expiredQty: 0,
      minStock: 1000,
      criticalStock: 400,
      reorderThreshold: 1500,
      stockStatus: 'NORMAL',
      version: 1,
      mode: 'demo',
      updatedAt: ago(10),
    },
    {
      id: 'demo-inv-2',
      itemId: 'demo-cat-2',
      warehouseId: wh1.id,
      sku: 'FOD-RTR-002',
      itemName: 'Ready-to-Eat High-Energy Ration Kits',
      category: 'food',
      unit: 'kits',
      totalQty: 2800,
      availableQty: 2450,
      reservedQty: 350,
      inTransitQty: 200,
      damagedQty: 0,
      expiredQty: 0,
      minStock: 800,
      criticalStock: 350,
      reorderThreshold: 1200,
      stockStatus: 'NORMAL',
      version: 1,
      mode: 'demo',
      updatedAt: ago(10),
    },
    {
      id: 'demo-inv-3',
      itemId: 'demo-cat-3',
      warehouseId: wh1.id,
      sku: 'MED-TRM-003',
      itemName: 'Emergency Trauma & First-Aid Kits',
      category: 'medical_kits',
      unit: 'kits',
      totalQty: 210,
      availableQty: 140,
      reservedQty: 70,
      inTransitQty: 40,
      damagedQty: 2,
      expiredQty: 0,
      minStock: 200,
      criticalStock: 100,
      reorderThreshold: 300,
      stockStatus: 'LOW',
      version: 1,
      mode: 'demo',
      updatedAt: ago(18),
    },
    {
      id: 'demo-inv-4',
      itemId: 'demo-cat-3',
      warehouseId: wh2.id,
      sku: 'MED-TRM-003',
      itemName: 'Emergency Trauma & First-Aid Kits',
      category: 'medical_kits',
      unit: 'kits',
      totalQty: 950,
      availableQty: 890,
      reservedQty: 60,
      inTransitQty: 0,
      damagedQty: 0,
      expiredQty: 0,
      minStock: 250,
      criticalStock: 120,
      reorderThreshold: 400,
      stockStatus: 'NORMAL',
      version: 1,
      mode: 'demo',
      updatedAt: ago(22),
    },
    {
      id: 'demo-inv-5',
      itemId: 'demo-cat-1',
      warehouseId: wh2.id,
      sku: 'WTR-20L-001',
      itemName: 'Potable Drinking Water Packs (20L)',
      category: 'drinking_water',
      unit: 'packs',
      totalQty: 2400,
      availableQty: 2400,
      reservedQty: 0,
      inTransitQty: 0,
      damagedQty: 0,
      expiredQty: 0,
      minStock: 700,
      criticalStock: 300,
      reorderThreshold: 1100,
      stockStatus: 'NORMAL',
      version: 1,
      mode: 'demo',
      updatedAt: ago(22),
    },
    {
      id: 'demo-inv-6',
      itemId: 'demo-cat-4',
      warehouseId: wh2.id,
      sku: 'PWR-GEN-006',
      itemName: 'Portable 5kW Relief Generators',
      category: 'power_equipment',
      unit: 'units',
      totalQty: 28,
      availableQty: 18,
      reservedQty: 10,
      inTransitQty: 4,
      damagedQty: 1,
      expiredQty: 0,
      minStock: 15,
      criticalStock: 6,
      reorderThreshold: 22,
      stockStatus: 'NORMAL',
      version: 1,
      mode: 'demo',
      updatedAt: ago(30),
    },
    {
      id: 'demo-inv-7',
      itemId: 'demo-cat-5',
      warehouseId: wh3.id,
      sku: 'SHL-TNT-007',
      itemName: 'All-Weather Family Relief Tents',
      category: 'shelter',
      unit: 'tents',
      totalQty: 520,
      availableQty: 460,
      reservedQty: 60,
      inTransitQty: 0,
      damagedQty: 4,
      expiredQty: 0,
      minStock: 150,
      criticalStock: 75,
      reorderThreshold: 250,
      stockStatus: 'NORMAL',
      version: 1,
      mode: 'demo',
      updatedAt: ago(40),
    },
    {
      id: 'demo-inv-8',
      itemId: 'demo-cat-6',
      warehouseId: wh3.id,
      sku: 'HYG-KIT-008',
      itemName: 'Sanitation & Water Purification Kits',
      category: 'hygiene_kits',
      unit: 'kits',
      totalQty: 180,
      availableQty: 95,
      reservedQty: 85,
      inTransitQty: 0,
      damagedQty: 0,
      expiredQty: 0,
      minStock: 200,
      criticalStock: 100,
      reorderThreshold: 300,
      stockStatus: 'CRITICAL',
      version: 1,
      mode: 'demo',
      updatedAt: ago(35),
    },
  ];

  const inventoryBatches: InventoryBatch[] = [
    {
      id: 'demo-batch-1',
      stockId: 'demo-inv-3',
      warehouseId: wh1.id,
      itemId: 'demo-cat-3',
      sku: 'MED-TRM-003',
      itemName: 'Emergency Trauma & First-Aid Kits',
      lotNumber: 'LOT-MED-2026-09A',
      quantity: 45,
      receivedDate: ago(14400),
      expiryDate: daysFromNow(5),
      qualityStatus: 'good',
      storageRequirements: '15–25°C controlled medical vault',
      batchLocation: 'Bay M2 / Rack 1',
      mode: 'demo',
      createdAt: ago(14400),
      updatedAt: ago(30),
    },
    {
      id: 'demo-batch-2',
      stockId: 'demo-inv-2',
      warehouseId: wh1.id,
      itemId: 'demo-cat-2',
      sku: 'FOD-RTR-002',
      itemName: 'Ready-to-Eat High-Energy Ration Kits',
      lotNumber: 'LOT-FOD-2026-11B',
      quantity: 450,
      receivedDate: ago(7200),
      expiryDate: daysFromNow(22),
      qualityStatus: 'good',
      storageRequirements: 'Dry climate-controlled bay (<28°C)',
      batchLocation: 'Bay F1 / Pallet 14',
      mode: 'demo',
      createdAt: ago(7200),
      updatedAt: ago(30),
    },
    {
      id: 'demo-batch-3',
      stockId: 'demo-inv-6',
      warehouseId: wh2.id,
      itemId: 'demo-cat-4',
      sku: 'PWR-GEN-006',
      itemName: 'Portable 5kW Relief Generators',
      lotNumber: 'LOT-GEN-2026-01',
      quantity: 28,
      receivedDate: ago(28800),
      expiryDate: null,
      qualityStatus: 'good',
      storageRequirements: 'Ventilated equipment bay',
      batchLocation: 'Equipment Floor A',
      mode: 'demo',
      createdAt: ago(28800),
      updatedAt: ago(30),
    },
  ];

  const stockReservations: StockReservation[] = [
    {
      id: 'demo-res-1',
      requestId: 'demo-req-1',
      incidentId: 'demo-inc-1',
      warehouseId: wh1.id,
      warehouseName: wh1.name,
      stockId: 'demo-inv-1',
      itemId: 'demo-cat-1',
      sku: 'WTR-20L-001',
      itemName: 'Potable Drinking Water Packs (20L)',
      category: 'drinking_water',
      unit: 'packs',
      requestedQty: 600,
      reservedQty: 600,
      status: 'Reserved',
      expiresAt: daysFromNow(1),
      orgId: 'org-rapid-relief',
      reservedBy: 'Logistics Command (DEMO)',
      notes: 'Held for Velachery Shelter rapid water convoy',
      auditHistory: [
        {
          timestamp: ago(45),
          actor: 'Logistics Command (DEMO)',
          action: 'reservation.created',
          detail: 'Reserved 600 packs against demo-req-1',
        },
      ],
      mode: 'demo',
      createdAt: ago(45),
      updatedAt: ago(45),
    },
  ];

  const incomingSupplies: IncomingSupplyOrder[] = [
    {
      id: 'demo-sup-1',
      supplier: 'DirectMed Pharma Logistics (DEMO)',
      warehouseId: wh1.id,
      warehouseName: wh1.name,
      trackingReference: 'TRK-DM-2026-8841',
      expectedArrival: daysFromNow(1),
      actualArrival: null,
      status: 'In Transit',
      verificationStatus: 'unverified',
      items: [
        {
          itemId: 'demo-cat-3',
          sku: 'MED-TRM-003',
          itemName: 'Emergency Trauma & First-Aid Kits',
          category: 'medical_kits',
          unit: 'kits',
          orderedQty: 300,
          receivedQty: 0,
          damagedQty: 0,
          lotNumber: 'LOT-MED-2027-01C',
          expiryDate: daysFromNow(240),
        },
      ],
      orgId: 'org-med-aid',
      createdBy: 'Procurement Desk (DEMO)',
      verifiedBy: null,
      mode: 'demo',
      createdAt: ago(180),
      updatedAt: ago(60),
    },
    {
      id: 'demo-sup-2',
      supplier: 'CivicWash Supplies (DEMO)',
      warehouseId: wh3.id,
      warehouseName: wh3.name,
      trackingReference: 'TRK-CW-2026-4410',
      expectedArrival: daysFromNow(2),
      actualArrival: null,
      status: 'Pending',
      verificationStatus: 'unverified',
      items: [
        {
          itemId: 'demo-cat-6',
          sku: 'HYG-KIT-008',
          itemName: 'Sanitation & Water Purification Kits',
          category: 'hygiene_kits',
          unit: 'kits',
          orderedQty: 250,
          receivedQty: 0,
          damagedQty: 0,
          lotNumber: 'LOT-HYG-2027-02A',
          expiryDate: daysFromNow(180),
        },
      ],
      orgId: 'org-civic-ngo',
      createdBy: 'Logistics Manager (DEMO)',
      verifiedBy: null,
      mode: 'demo',
      createdAt: ago(120),
      updatedAt: ago(120),
    },
  ];

  const inc1: Incident = {
    id: 'demo-inc-1',
    title: 'Adyar River Basin Flash Flood — Velachery & Tambaram Lowlands',
    description:
      'Sustained monsoon squall triggered rapid river overflow across residential blocks in Velachery and Mudichur. Ground teams report waist-deep inundation along arterial approaches and two compromised substations.',
    type: 'flash_flood',
    severity: 'critical',
    status: 'escalated',
    lat: 12.9784,
    lng: 80.2186,
    address: 'Velachery Bypass & Adyar South Embankment',
    region: 'Tamil Nadu Coastal',
    reportedAt: ago(140),
    source: 'Field Responder Unit R-09',
    reporter: 'Capt. Meera Krishnan',
    peopleAffected: 4850,
    vulnerablePopulation: 1120,
    estimatedImpactAreaKm2: 18.4,
    immediateNeeds: ['drinking_water', 'medical_kits', 'food', 'rescue_equipment'],
    evidenceUrls: ['/assets/aistudio/Screenshot_2026-11-20_191220_271d894c.png'],
    verificationStatus: 'verified',
    riskScore: 86,
    priorityScore: 88,
    assignedOrgId: 'org-central-cmd',
    assignedTeam: 'Swift Water Rescue Alpha',
    mode: 'demo',
    ownerId: 'cmd-local-01',
    notes: [
      {
        id: 'note-1',
        text: 'Shelter at Velachery Govt School reached 78% occupancy; backup generators requested.',
        author: 'Capt. Meera Krishnan',
        createdAt: ago(55),
      },
    ],
    history: [
      { id: 'h-1', timestamp: ago(140), actor: 'Capt. Meera Krishnan', role: 'field_responder', action: 'Incident reported', newStatus: 'reported' },
      { id: 'h-2', timestamp: ago(110), actor: 'Command Operator', role: 'emergency_commander', action: 'Verified via hydro-gauge & responder evidence', previousStatus: 'reported', newStatus: 'verified' },
      { id: 'h-3', timestamp: ago(65), actor: 'Command Operator', role: 'emergency_commander', action: 'Escalated to Critical — rapid water rise', previousStatus: 'verified', newStatus: 'escalated' },
    ],
    createdAt: ago(140),
    updatedAt: ago(25),
  };

  const inc2: Incident = {
    id: 'demo-inc-2',
    title: 'Coastal Power Grid Failure & Cold-Chain Risk — Mahabalipuram Corridor',
    description:
      'High gusting winds felled 3 distribution feeders supplying two coastal primary health centers and three evacuation shelters. Backup diesel reserves projected to last 14 hours.',
    type: 'power_failure',
    severity: 'high',
    status: 'active',
    lat: 12.6269,
    lng: 80.1927,
    address: 'ECR Coastal Feeder Zone, Mahabalipuram',
    region: 'Chengalpattu Basin',
    reportedAt: ago(95),
    source: 'District Utility Liaison',
    reporter: 'Arjun Subramanian',
    peopleAffected: 1920,
    vulnerablePopulation: 430,
    estimatedImpactAreaKm2: 9.2,
    immediateNeeds: ['power_equipment', 'medical_kits', 'drinking_water'],
    evidenceUrls: [],
    verificationStatus: 'verified',
    riskScore: 71,
    priorityScore: 74,
    assignedOrgId: 'org-med-aid',
    assignedTeam: 'Grid & Cold-Chain Support 2',
    mode: 'demo',
    ownerId: 'cmd-local-01',
    notes: [],
    history: [
      { id: 'h-4', timestamp: ago(95), actor: 'Arjun Subramanian', role: 'field_responder', action: 'Incident reported', newStatus: 'reported' },
      { id: 'h-5', timestamp: ago(80), actor: 'Command Operator', role: 'emergency_commander', action: 'Verified and marked Active', previousStatus: 'reported', newStatus: 'active' },
    ],
    createdAt: ago(95),
    updatedAt: ago(40),
  };

  const inc3: Incident = {
    id: 'demo-inc-3',
    title: 'Embankment Slope Instability — Western Hill Access Road',
    description:
      'Saturated hillside soil shows tension cracks above secondary evacuation route. Road currently passable for light vehicles only; geological inspection requested.',
    type: 'landslide',
    severity: 'medium',
    status: 'under_review',
    lat: 12.8406,
    lng: 80.0604,
    address: 'Guduvanchery Ridge Link',
    region: 'Kancheepuram District',
    reportedAt: ago(48),
    source: 'Citizen Report #CR-441',
    reporter: 'Priya Narayanan',
    peopleAffected: 410,
    vulnerablePopulation: 85,
    estimatedImpactAreaKm2: 2.1,
    immediateNeeds: ['shelter', 'hygiene_kits'],
    evidenceUrls: [],
    verificationStatus: 'pending',
    riskScore: 52,
    priorityScore: 54,
    assignedOrgId: 'org-civic-ngo',
    assignedTeam: 'Geo-Recon Patrol 4',
    mode: 'demo',
    ownerId: 'cmd-local-01',
    notes: [],
    history: [
      { id: 'h-6', timestamp: ago(48), actor: 'Priya Narayanan', role: 'citizen_reporter', action: 'Citizen alert submitted', newStatus: 'reported' },
    ],
    createdAt: ago(48),
    updatedAt: ago(30),
  };

  const req1: ReliefRequest = {
    id: 'demo-req-1',
    incidentId: inc1.id,
    orgId: 'org-civic-ngo',
    requesterRole: 'field_responder',
    requesterName: 'Velachery Relief Shelter Coordinator',
    contactMasked: '+91-98***-***21',
    locationName: 'Velachery Government High School Shelter',
    lat: 12.9762,
    lng: 80.2211,
    peopleAffected: 1250,
    familiesAffected: 310,
    vulnerableGroups: ['elderly', 'infants', 'medical_dependent'],
    urgency: 'critical',
    items: [
      { category: 'drinking_water', itemName: 'Potable Drinking Water Packs (20L)', quantity: 900, fulfilledQuantity: 0, unit: 'packs' },
      { category: 'medical_kits', itemName: 'Emergency Trauma & First-Aid Kits', quantity: 220, fulfilledQuantity: 0, unit: 'kits' },
      { category: 'food', itemName: 'Ready-to-Eat High-Energy Ration Kits', quantity: 650, fulfilledQuantity: 0, unit: 'kits' },
    ],
    notes: 'High-clearance truck recommended; secondary north gate remains dry.',
    status: 'prioritized',
    verificationStatus: 'verified',
    priorityScore: 91,
    priorityCategory: 'critical',
    priorityBreakdown: {
      severityScore: 95,
      needScore: 88,
      vulnerabilityScore: 90,
      urgencyScore: 95,
      accessScore: 80,
      weights: { S: 0.3, N: 0.25, V: 0.2, U: 0.15, A: 0.1 },
      algorithmicScore: 91,
      algorithmicCategory: 'critical',
      calculationVersion: 'priority-v1.0',
      missingInformation: [],
    },
    mode: 'demo',
    ownerId: 'cmd-local-01',
    createdAt: ago(70),
    updatedAt: ago(20),
  };

  const req2: ReliefRequest = {
    id: 'demo-req-2',
    incidentId: inc2.id,
    orgId: 'org-med-aid',
    requesterRole: 'logistics_manager',
    requesterName: 'Mahabalipuram PHC Medical Officer',
    contactMasked: '+91-94***-***88',
    locationName: 'Coastal Primary Health Center',
    lat: 12.6208,
    lng: 80.1945,
    peopleAffected: 480,
    familiesAffected: 115,
    vulnerableGroups: ['medical_dependent', 'pregnant_women'],
    urgency: 'high',
    items: [
      { category: 'power_equipment', itemName: 'Portable 5kW Relief Generators', quantity: 6, fulfilledQuantity: 0, unit: 'units' },
      { category: 'drinking_water', itemName: 'Potable Drinking Water Packs (20L)', quantity: 300, fulfilledQuantity: 0, unit: 'packs' },
    ],
    notes: 'Insulin and vaccine refrigeration requires stabilized power within 8 hours.',
    status: 'verified',
    verificationStatus: 'verified',
    priorityScore: 76,
    priorityCategory: 'high',
    priorityBreakdown: {
      severityScore: 75,
      needScore: 78,
      vulnerabilityScore: 82,
      urgencyScore: 75,
      accessScore: 65,
      weights: { S: 0.3, N: 0.25, V: 0.2, U: 0.15, A: 0.1 },
      algorithmicScore: 76,
      algorithmicCategory: 'high',
      calculationVersion: 'priority-v1.0',
      missingInformation: [],
    },
    mode: 'demo',
    ownerId: 'cmd-local-01',
    createdAt: ago(50),
    updatedAt: ago(15),
  };

  const drivers: Driver[] = [
    {
      id: 'demo-drv-1',
      name: 'R. Karthik (DEMO)',
      contact: '+91-98401-10401',
      contactMasked: '+91-98***-***01',
      orgId: 'org-rapid-relief',
      status: 'Available',
      assignedVehicleId: 'demo-veh-1',
      assignedDispatchId: null,
      certifications: ['Heavy Commercial', 'Flood-Zone Convoy', 'Hazmat Basic'],
      lastKnownLat: 13.0827,
      lastKnownLng: 80.2707,
      lastLocationAt: ago(8),
      assignmentHistory: [],
      mode: 'demo',
      createdAt: ago(1440),
      updatedAt: ago(8),
    },
    {
      id: 'demo-drv-2',
      name: 'S. Divya (DEMO)',
      contact: '+91-98401-20802',
      contactMasked: '+91-98***-***02',
      orgId: 'org-med-aid',
      status: 'Available',
      assignedVehicleId: 'demo-veh-2',
      assignedDispatchId: null,
      certifications: ['Emergency Medical Transport', 'Cold-Chain Handling'],
      lastKnownLat: 12.9675,
      lastKnownLng: 79.9419,
      lastLocationAt: ago(5),
      assignmentHistory: [],
      mode: 'demo',
      createdAt: ago(1440),
      updatedAt: ago(5),
    },
    {
      id: 'demo-drv-3',
      name: 'M. Vikram (DEMO)',
      contact: '+91-98401-31203',
      contactMasked: '+91-98***-***03',
      orgId: 'org-civic-ngo',
      status: 'Assigned',
      assignedVehicleId: 'demo-veh-3',
      assignedDispatchId: 'demo-dsp-1',
      certifications: ['4x4 Off-Road Recovery', 'Swift Water Logistics'],
      lastKnownLat: 12.66,
      lastKnownLng: 80.08,
      lastLocationAt: ago(3),
      assignmentHistory: [
        {
          id: 'dah-1',
          timestamp: ago(35),
          action: 'Assigned to demo-dsp-1',
          vehicleId: 'demo-veh-3',
          dispatchId: 'demo-dsp-1',
          actor: 'Command Operator',
        },
      ],
      mode: 'demo',
      createdAt: ago(1440),
      updatedAt: ago(3),
    },
  ];

  const routeHazards: RouteHazardReport[] = [
    {
      id: 'demo-haz-1',
      type: 'flood',
      severity: 'high',
      lat: 12.989,
      lng: 80.223,
      radiusKm: 1.5,
      description: 'DEMO HAZARD: Knee-deep standing water reported along Velachery Inner Ring culvert; low-clearance vehicles advised to detour.',
      source: 'Field Responder Unit R-09 (DEMO)',
      verified: true,
      reportedBy: 'Capt. Meera Krishnan',
      active: true,
      mode: 'demo',
      createdAt: ago(42),
      updatedAt: ago(42),
    },
  ];

  const vehicles: Vehicle[] = [
    {
      id: 'demo-veh-1',
      registrationNumber: 'TN-01-RF-1040',
      callsign: 'RF-TRK-104 (High-Clearance 6x6)',
      name: 'High-Clearance Relief Truck 104 (DEMO)',
      vehicleType: 'heavy_truck',
      orgId: 'org-rapid-relief',
      warehouseId: wh1.id,
      capacityKg: 8000,
      capacityUnits: 2500,
      capacityUnit: 'units',
      status: 'available',
      driverId: 'demo-drv-1',
      driverTeam: 'Crew Alpha-4 (R. Karthik)',
      driverContact: '+91-98401-10401',
      fuelPct: 92,
      maintenanceStatus: 'operational',
      equipment: ['Hydraulic Liftgate', 'VHF Radio', 'Winch 12T'],
      lastServiceDate: ago(10080),
      lat: 13.0827,
      lng: 80.2707,
      lastLocationAt: ago(8),
      gpsSource: 'simulated_demo',
      assignedDispatchId: null,
      history: [],
      mode: 'demo',
      createdAt: ago(4320),
      updatedAt: ago(8),
    },
    {
      id: 'demo-veh-2',
      registrationNumber: 'TN-09-RF-2080',
      callsign: 'RF-MED-208 (Cold-Chain Van)',
      name: 'Cold-Chain Medical Van 208 (DEMO)',
      vehicleType: 'ambulance',
      orgId: 'org-med-aid',
      warehouseId: wh2.id,
      capacityKg: 2500,
      capacityUnits: 1200,
      capacityUnit: 'units',
      status: 'available',
      driverId: 'demo-drv-2',
      driverTeam: 'Med Logistics 2 (S. Divya)',
      driverContact: '+91-98401-20802',
      fuelPct: 86,
      maintenanceStatus: 'operational',
      equipment: ['2-8C Vaccine Fridge', 'Trauma Stretcher', 'Satellite Beacon'],
      lastServiceDate: ago(7200),
      lat: 12.9675,
      lng: 79.9419,
      lastLocationAt: ago(5),
      gpsSource: 'simulated_demo',
      assignedDispatchId: null,
      history: [],
      mode: 'demo',
      createdAt: ago(4320),
      updatedAt: ago(5),
    },
    {
      id: 'demo-veh-3',
      registrationNumber: 'TN-11-RF-3120',
      callsign: 'RF-UTL-312 (4x4 Flood Support)',
      name: '4x4 Utility Convoy 312 (DEMO)',
      vehicleType: '4x4_utility',
      orgId: 'org-civic-ngo',
      warehouseId: wh3.id,
      capacityKg: 1800,
      capacityUnits: 900,
      capacityUnit: 'units',
      status: 'in_transit',
      driverId: 'demo-drv-3',
      driverTeam: 'Field Convoy 7 (M. Vikram)',
      driverContact: '+91-98401-31203',
      fuelPct: 74,
      maintenanceStatus: 'operational',
      equipment: ['Snorkel Intake', 'Portable Floodlights', 'First-Aid Kit'],
      lastServiceDate: ago(14400),
      lat: 12.835,
      lng: 80.125,
      lastLocationAt: ago(3),
      gpsSource: 'simulated_demo',
      assignedDispatchId: 'demo-dsp-1',
      history: [],
      mode: 'demo',
      createdAt: ago(4320),
      updatedAt: ago(3),
    },
  ];

  const stockMovements: StockMovement[] = [
    {
      id: 'demo-mov-1',
      stockId: 'demo-inv-1',
      warehouseId: wh1.id,
      itemName: 'Potable Drinking Water Packs (20L)',
      type: 'inbound',
      quantity: 1200,
      previousAvailable: 2400,
      newAvailable: 3600,
      reason: 'Pre-monsoon regional replenishment',
      actor: 'Warehouse Operator',
      role: 'warehouse_operator',
      mode: 'demo',
      createdAt: ago(180),
    },
    {
      id: 'demo-mov-2',
      stockId: 'demo-inv-3',
      warehouseId: wh1.id,
      itemName: 'Emergency Trauma & First-Aid Kits',
      type: 'reservation',
      quantity: 70,
      previousAvailable: 210,
      newAvailable: 140,
      reason: 'Reserved for Tambaram Clinic emergency staging',
      actor: 'Logistics Manager',
      role: 'logistics_manager',
      mode: 'demo',
      createdAt: ago(60),
    },
  ];

  const riskAssessments: RiskAssessment[] = [
    {
      id: 'demo-risk-1',
      incidentId: inc1.id,
      incidentTitle: inc1.title,
      calculationVersion: 'risk-det-v2.0',
      ruleVersion: 'phase3-risk-rules-v2.0',
      overallScore: 86,
      band: 'Critical',
      assessmentStatus: 'COMPLETE',
      dataCompletenessPct: 100,
      severityRisk: 95,
      environmentalRisk: 84,
      humanImpactRisk: 90,
      vulnerabilityRisk: 88,
      infrastructureRisk: 84,
      supplyRisk: 78,
      accessRisk: 82,
      factors: [
        { key: 'severity', label: 'Incident Severity', rawValue: 'critical (Level 5)', normalizedScore: 95, weight: 0.25, missing: false, source: 'incident_record' },
        { key: 'environmental', label: 'Environmental / Weather Exposure', rawValue: 'Heavy Rain Trigger (24mm/h)', normalizedScore: 84, weight: 0.2, missing: false, source: 'weather_engine' },
        { key: 'human_impact', label: 'Human Impact & Population', rawValue: '4850 people affected', normalizedScore: 90, weight: 0.2, missing: false, source: 'incident_record' },
        { key: 'vulnerability', label: 'Vulnerable Population Exposure', rawValue: '1120 vulnerable (23.1%)', normalizedScore: 88, weight: 0.15, missing: false, source: 'incident_record' },
        { key: 'access', label: 'Access & Route Disruption', rawValue: 'Inundated Approaches', normalizedScore: 82, weight: 0.1, missing: false, source: 'geospatial_engine' },
        { key: 'infrastructure', label: 'Infrastructure Exposure', rawValue: 'flash_flood (18.4 km²)', normalizedScore: 84, weight: 0.1, missing: false, source: 'incident_record' },
      ],
      missingFactors: [],
      incompleteDataWarning: false,
      confidenceScore: 0.94,
      assessmentSource: 'incident_creation',
      assessor: 'Deterministic Risk Engine v2.0',
      previousAssessmentId: null,
      riskChange: null,
      sourceIds: [inc1.id, wh1.id],
      explanation: 'Deterministic system classification (not an official disaster declaration): CRITICAL (86/100) driven by critical severity, high affected and vulnerable population, and coastal flood inundation.',
      mode: 'demo',
      createdAt: ago(25),
    },
  ];

  const alerts: AlertRecord[] = [
    {
      id: 'demo-alert-1',
      dedupKey: `demo:risk_critical:${inc1.id}`,
      incidentId: inc1.id,
      incidentTitle: inc1.title,
      alertType: 'risk_critical_threshold',
      severity: 'critical',
      status: 'ACTIVE',
      title: `CRITICAL Risk Band Crossed: ${inc1.title}`,
      message: 'Deterministic risk score reached 86/100 (Critical). Immediate verification of evacuation routes and relief allocation required.',
      triggerFactor: 'overall_risk_score >= 80',
      previousValue: 68,
      currentValue: 86,
      source: 'deterministic-risk-engine-v2',
      cooldownMinutes: 15,
      acknowledgedBy: null,
      acknowledgedAt: null,
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
      mode: 'demo',
      createdAt: ago(24),
      updatedAt: ago(24),
    },
    {
      id: 'demo-alert-2',
      dedupKey: `demo:verify_needed:${inc3.id}`,
      incidentId: inc3.id,
      incidentTitle: inc3.title,
      alertType: 'manual_verification_required',
      severity: 'warning',
      status: 'ACTIVE',
      title: `Field Verification Required: ${inc3.title}`,
      message: 'Citizen landslide report awaiting commander verification and geological confirmation before resource commitment.',
      triggerFactor: 'verification_status == pending',
      previousValue: 'reported',
      currentValue: 'under_review',
      source: 'incident-lifecycle-engine',
      cooldownMinutes: 30,
      acknowledgedBy: null,
      acknowledgedAt: null,
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
      mode: 'demo',
      createdAt: ago(38),
      updatedAt: ago(38),
    },
  ];

  const incidentReports: IncidentReportRecord[] = [
    {
      id: 'demo-rep-1',
      incidentId: inc1.id,
      reporterName: 'Capt. Meera Krishnan',
      reporterRole: 'field_responder',
      sourceType: 'field_responder',
      summary: 'Water level rose 0.6m at Velachery South Bridge over past 40 minutes; two transformers submerged.',
      peopleAffectedUpdate: 4850,
      vulnerablePopulationUpdate: 1120,
      severitySuggestion: 'critical',
      evidenceUrls: ['/assets/aistudio/Screenshot_2026-11-20_191220_271d894c.png'],
      lat: 12.9784,
      lng: 80.2186,
      mode: 'demo',
      createdAt: ago(68),
    },
  ];

  const dispatches: Dispatch[] = [
    {
      id: 'demo-dsp-1',
      allocationId: 'demo-alloc-seed',
      requestId: req2.id,
      incidentId: inc2.id,
      warehouseId: wh3.id,
      warehouseName: wh3.name,
      vehicleId: 'demo-veh-3',
      vehicleCallsign: 'RF-UTL-312 (4x4 Flood Support)',
      destinationName: 'Coastal Primary Health Center',
      destinationLat: 12.6208,
      destinationLng: 80.1945,
      status: 'in_transit',
      route: {
        id: 'demo-route-1',
        provider: 'haversine_fallback',
        origin: { lat: wh3.lat, lng: wh3.lng, label: wh3.name },
        destination: { lat: 12.6208, lng: 80.1945, label: 'Coastal Primary Health Center' },
        waypoints: [],
        distanceKm: 24.8,
        durationMin: 42,
        geometry: [
          { lat: wh3.lat, lng: wh3.lng },
          { lat: 12.66, lng: 80.08 },
          { lat: 12.6208, lng: 80.1945 },
        ],
        instructions: ['Depart Chengalpattu Depot east toward ECR corridor', 'Proceed south to Mahabalipuram PHC'],
        roadConditionsNotice: 'ROAD CONDITIONS NOT VERIFIED — Verify local road closures before movement.',
        alternativesCount: 1,
        timestamp: ago(20),
        freshnessStatus: 'fresh',
      },
      currentLat: 12.66,
      currentLng: 80.08,
      gpsLabel: 'SIMULATED DEMO TRACKING',
      events: [
        { id: 'de-1', status: 'dispatch_created', note: 'Initial forward stabilization dispatch approved', actor: 'Command Operator', timestamp: ago(35) },
        { id: 'de-2', status: 'loading', note: 'Verified cargo manifest at South Basin Depot', actor: 'Warehouse Operator', timestamp: ago(28) },
        { id: 'de-3', status: 'in_transit', note: 'Convoy departed toward ECR corridor', actor: 'Field Convoy 7', timestamp: ago(18) },
      ],
      mode: 'demo',
      createdAt: ago(35),
      updatedAt: ago(3),
    },
  ];

  const notifications: AppNotification[] = [
    {
      id: 'demo-notif-1',
      dedupKey: 'demo:inc:escalated:demo-inc-1',
      userId: 'all',
      orgId: 'org-central-cmd',
      eventType: 'incident.severity_changed',
      severity: 'critical',
      title: 'Critical Incident Escalated: Adyar River Basin Flash Flood',
      message: 'Risk score crossed Critical band (86/100). 4,850 people affected; immediate water & trauma kit allocation advised.',
      entityType: 'incident',
      entityId: inc1.id,
      read: false,
      channel: 'in_app',
      mode: 'demo',
      createdAt: ago(24),
    },
    {
      id: 'demo-notif-2',
      dedupKey: 'demo:inv:shortage:demo-inv-3',
      userId: 'all',
      orgId: 'org-rapid-relief',
      eventType: 'inventory.critical_shortage',
      severity: 'high',
      title: 'Critical Stock Shortage: Emergency Trauma Kits at Central Hub',
      message: 'Available stock (140 kits) dropped below minimum safety threshold (200 kits). Split allocation with Inland Depot recommended.',
      entityType: 'inventory',
      entityId: 'demo-inv-3',
      read: false,
      channel: 'in_app',
      mode: 'demo',
      createdAt: ago(16),
    },
  ];

  return {
    incidents: [inc1, inc2, inc3],
    incidentReports,
    reliefRequests: [req1, req2],
    warehouses: [wh1, wh2, wh3],
    inventoryCatalog,
    inventory,
    inventoryBatches,
    stockMovements,
    stockReservations,
    incomingSupplies,
    vehicles,
    drivers,
    routeHazards,
    allocations: [],
    dispatches,
    deliveryConfirmations: [],
    riskAssessments,
    alerts,
    predictions: [],
    notifications,
  };
}

function createInitialState(): StoreState {
  const demo = buildDemoDataset();
  return {
    organizations: createDefaultOrganizations(),
    incidents: [...demo.incidents],
    incidentReports: [...demo.incidentReports],
    weatherObservations: [],
    riskAssessments: [...demo.riskAssessments],
    aiRiskAnalyses: [],
    alerts: [...demo.alerts],
    reassessmentJobs: [],
    predictions: [...demo.predictions],
    reliefRequests: [...demo.reliefRequests],
    warehouses: [...demo.warehouses],
    inventoryCatalog: [...demo.inventoryCatalog],
    inventory: [...demo.inventory],
    inventoryBatches: [...demo.inventoryBatches],
    stockMovements: [...demo.stockMovements],
    stockReservations: [...demo.stockReservations],
    incomingSupplies: [...demo.incomingSupplies],
    allocations: [...demo.allocations],
    vehicles: [...demo.vehicles],
    drivers: [...demo.drivers],
    routeRecords: [],
    routeHazards: [...demo.routeHazards],
    dispatches: [...demo.dispatches],
    deliveryConfirmations: [...demo.deliveryConfirmations],
    logisticsAdvisories: [],
    notifications: [...demo.notifications],
    aiTasks: [],
    aiAgents: [],
    aiAgentVersions: [],
    aiCoordinationSessions: [],
    aiAgentTasks: [],
    aiAgentResults: [],
    aiCoordinationEvents: [],
    aiEvidenceRecords: [],
    aiRecommendations: [],
    aiResponsePlans: [],
    aiPlanActions: [],
    aiApprovalRequests: [],
    aiApprovalEvents: [],
    aiConflicts: [],
    aiSessionMemory: [],
    aiSimulationSessions: [],
    aiSimulationResults: [],
    aiTriggerEvents: [],
    events: [],
    auditLogs: [
      {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        actor: 'System Bootstrap',
        role: 'super_admin',
        orgId: 'org-central-cmd',
        action: 'system.initialized',
        entityType: 'system',
        entityId: 'resqflow-core',
        summary: 'RESQFLOW AI store initialized with isolated Demo dataset and empty Operational dataset.',
        mode: 'demo',
      },
    ],
    integrations: createDefaultIntegrations(),
    settings: {
      priorityWeights: { S: 0.3, N: 0.25, V: 0.2, U: 0.15, A: 0.1 },
      riskWeights: { ...DEFAULT_RISK_WEIGHTS },
      allocationWeights: { ...DEFAULT_ALLOCATION_WEIGHTS },
      fairnessAgingPointsPerHour: 1.5,
      fairnessMaxBoost: 18,
      weatherFreshnessSeconds: 900,
      inventoryFreshnessSeconds: 1800,
      alertCooldownMinutes: 15,
    },
    offlineIdempotency: {},
    authUsers: [],
    authSessions: [],
    passwordResets: [],
  };
}

class PersistentStore {
  public state: StoreState;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private writeInFlight: Promise<void> | null = null;
  private dirty = false;
  private lastFlushAt: string | null = null;
  private lastFlushDurationMs = 0;
  private flushCount = 0;
  private flushErrors = 0;

  constructor() {
    this.state = this.load();
  }

  private load(): StoreState {
    try {
      if (fs.existsSync(STORE_FILE)) {
        const raw = fs.readFileSync(STORE_FILE, 'utf8');
        const parsed = JSON.parse(raw) as StoreState;
        if (parsed && Array.isArray(parsed.incidents) && Array.isArray(parsed.warehouses)) {
          // Always refresh integration status for runtime env keys
          parsed.integrations = createDefaultIntegrations();
          if (!parsed.offlineIdempotency || typeof parsed.offlineIdempotency !== 'object') {
            parsed.offlineIdempotency = {};
          }
          const demoDefaults = buildDemoDataset();
          if (!Array.isArray(parsed.alerts)) {
            parsed.alerts = demoDefaults.alerts;
          }
          if (!Array.isArray(parsed.aiRiskAnalyses)) {
            parsed.aiRiskAnalyses = [];
          }
          if (!Array.isArray(parsed.incidentReports)) {
            parsed.incidentReports = demoDefaults.incidentReports;
          }
          if (!Array.isArray(parsed.reassessmentJobs)) {
            parsed.reassessmentJobs = [];
          }
          if (!Array.isArray(parsed.inventoryCatalog)) {
            parsed.inventoryCatalog = demoDefaults.inventoryCatalog;
          }
          if (!Array.isArray(parsed.inventoryBatches)) {
            parsed.inventoryBatches = demoDefaults.inventoryBatches;
          }
          if (!Array.isArray(parsed.stockReservations)) {
            parsed.stockReservations = demoDefaults.stockReservations;
          }
          if (!Array.isArray(parsed.incomingSupplies)) {
            parsed.incomingSupplies = demoDefaults.incomingSupplies;
          }
          if (!Array.isArray(parsed.drivers)) {
            parsed.drivers = demoDefaults.drivers;
          }
          if (!Array.isArray(parsed.routeRecords)) {
            parsed.routeRecords = [];
          }
          if (!Array.isArray(parsed.routeHazards)) {
            parsed.routeHazards = demoDefaults.routeHazards;
          }
          if (!Array.isArray(parsed.deliveryConfirmations)) {
            parsed.deliveryConfirmations = [];
          }
          if (!Array.isArray(parsed.logisticsAdvisories)) {
            parsed.logisticsAdvisories = [];
          }
          if (!Array.isArray(parsed.aiAgents)) parsed.aiAgents = [];
          if (!Array.isArray(parsed.aiAgentVersions)) parsed.aiAgentVersions = [];
          if (!Array.isArray(parsed.aiCoordinationSessions)) parsed.aiCoordinationSessions = [];
          if (!Array.isArray(parsed.aiAgentTasks)) parsed.aiAgentTasks = [];
          if (!Array.isArray(parsed.aiAgentResults)) parsed.aiAgentResults = [];
          if (!Array.isArray(parsed.aiCoordinationEvents)) parsed.aiCoordinationEvents = [];
          if (!Array.isArray(parsed.aiEvidenceRecords)) parsed.aiEvidenceRecords = [];
          if (!Array.isArray(parsed.aiRecommendations)) parsed.aiRecommendations = [];
          if (!Array.isArray(parsed.aiResponsePlans)) parsed.aiResponsePlans = [];
          if (!Array.isArray(parsed.aiPlanActions)) parsed.aiPlanActions = [];
          if (!Array.isArray(parsed.aiApprovalRequests)) parsed.aiApprovalRequests = [];
          if (!Array.isArray(parsed.aiApprovalEvents)) parsed.aiApprovalEvents = [];
          if (!Array.isArray(parsed.aiConflicts)) parsed.aiConflicts = [];
          if (!Array.isArray(parsed.aiSessionMemory)) parsed.aiSessionMemory = [];
          if (!Array.isArray(parsed.aiSimulationSessions)) parsed.aiSimulationSessions = [];
          if (!Array.isArray(parsed.aiSimulationResults)) parsed.aiSimulationResults = [];
          if (!Array.isArray(parsed.aiTriggerEvents)) parsed.aiTriggerEvents = [];
          if (!parsed.settings.riskWeights) {
            parsed.settings.riskWeights = { ...DEFAULT_RISK_WEIGHTS };
          }
          if (!parsed.settings.allocationWeights) {
            parsed.settings.allocationWeights = { ...DEFAULT_ALLOCATION_WEIGHTS };
          }
          if (typeof parsed.settings.fairnessAgingPointsPerHour !== 'number') {
            parsed.settings.fairnessAgingPointsPerHour = 1.5;
          }
          if (typeof parsed.settings.fairnessMaxBoost !== 'number') {
            parsed.settings.fairnessMaxBoost = 18;
          }
          if (typeof parsed.settings.alertCooldownMinutes !== 'number') {
            parsed.settings.alertCooldownMinutes = 15;
          }
          if (!Array.isArray(parsed.authUsers)) {
            parsed.authUsers = [];
          }
          if (!Array.isArray(parsed.authSessions)) {
            parsed.authSessions = [];
          }
          if (!Array.isArray(parsed.passwordResets)) {
            parsed.passwordResets = [];
          }
          return parsed;
        }
      }
    } catch (err) {
      console.error('Failed to load store file, recreating initial state:', err);
    }
    const fresh = createInitialState();
    this.flushSync(fresh);
    return fresh;
  }

  /**
   * Coalesced non-blocking persistence: marks state dirty and schedules an
   * asynchronous atomic write (write temp file -> rename) so rapid concurrent
   * mutations never block the Node.js event loop or corrupt the store file.
   */
  public save(nextState: StoreState = this.state) {
    if (nextState !== this.state) {
      this.state = nextState;
    }
    this.dirty = true;
    // In serverless Vercel environments, flush immediately on micro-turn since process may freeze after response
    if (process.env.VERCEL) {
      this.flushSync(this.state);
      return;
    }
    if (this.saveTimer || this.writeInFlight) {
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.drainAsyncWrites();
    }, 150);
    if (typeof this.saveTimer.unref === 'function') {
      this.saveTimer.unref();
    }
  }

  private async drainAsyncWrites(): Promise<void> {
    if (this.writeInFlight) return;
    this.writeInFlight = (async () => {
      while (this.dirty) {
        this.dirty = false;
        const started = Date.now();
        try {
          await fs.promises.mkdir(DATA_DIR, { recursive: true });
          const payload = JSON.stringify(this.state);
          const tmpFile = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
          await fs.promises.writeFile(tmpFile, payload, 'utf8');
          await fs.promises.rename(tmpFile, STORE_FILE);
          this.lastFlushDurationMs = Date.now() - started;
          this.lastFlushAt = new Date().toISOString();
          this.flushCount += 1;
        } catch (err) {
          this.flushErrors += 1;
          console.error('Failed to persist store file asynchronously:', err);
          break;
        }
      }
    })().finally(() => {
      this.writeInFlight = null;
      if (this.dirty && !this.saveTimer) {
        this.saveTimer = setTimeout(() => {
          this.saveTimer = null;
          void this.drainAsyncWrites();
        }, 150);
        if (typeof this.saveTimer.unref === 'function') {
          this.saveTimer.unref();
        }
      }
    });
    await this.writeInFlight;
  }

  /**
   * Synchronous atomic flush reserved for startup bootstrap, Vercel serverless turns,
   * and graceful shutdown (SIGTERM/SIGINT).
   */
  public flushSync(nextState: StoreState = this.state) {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const started = Date.now();
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const tmpFile = `${STORE_FILE}.${process.pid}.sync.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(nextState), 'utf8');
      fs.renameSync(tmpFile, STORE_FILE);
      this.dirty = false;
      this.lastFlushDurationMs = Date.now() - started;
      this.lastFlushAt = new Date().toISOString();
      this.flushCount += 1;
    } catch (err) {
      this.flushErrors += 1;
      console.error('Failed to persist store file:', err);
    }
  }

  public getPersistenceStats() {
    return {
      dirty: this.dirty,
      writeInFlight: Boolean(this.writeInFlight),
      lastFlushAt: this.lastFlushAt,
      lastFlushDurationMs: this.lastFlushDurationMs,
      flushCount: this.flushCount,
      flushErrors: this.flushErrors,
    };
  }

  public addAudit(entry: Omit<AuditLog, 'id' | 'timestamp'>): AuditLog {
    const log: AuditLog = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.state.auditLogs.unshift(log);
    if (this.state.auditLogs.length > 500) {
      this.state.auditLogs.length = 500;
    }
    this.save();
    return log;
  }

  public addNotification(
    notif: Omit<AppNotification, 'id' | 'createdAt' | 'read'>
  ): AppNotification | null {
    // Deduplicate unread alerts with the same dedupKey within 10 minutes
    const tenMinsAgo = Date.now() - 10 * 60_000;
    const duplicate = this.state.notifications.find(
      (n) => n.dedupKey === notif.dedupKey && !n.read && new Date(n.createdAt).getTime() > tenMinsAgo
    );
    if (duplicate) return null;

    const record: AppNotification = {
      id: uuidv4(),
      read: false,
      createdAt: new Date().toISOString(),
      ...notif,
    };
    this.state.notifications.unshift(record);
    if (this.state.notifications.length > 200) {
      this.state.notifications.length = 200;
    }
    this.save();
    return record;
  }

  public updateIntegrationHealth(
    id: string,
    patch: Partial<IntegrationHealth>
  ) {
    const item = this.state.integrations.find((i) => i.id === id);
    if (item) {
      Object.assign(item, patch);
      this.save();
    }
  }

  public triggerAlert(
    input: Omit<AlertRecord, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'cooldownMinutes'> & {
      cooldownMinutes?: number;
      forceBypassCooldown?: boolean;
    }
  ): { alert: AlertRecord | null; deduplicated: boolean } {
    const cooldownMin = input.cooldownMinutes ?? this.state.settings.alertCooldownMinutes ?? 15;
    const cutoff = Date.now() - cooldownMin * 60_000;

    if (!input.forceBypassCooldown) {
      const existing = this.state.alerts.find(
        (a) =>
          a.dedupKey === input.dedupKey &&
          a.mode === input.mode &&
          a.status !== 'RESOLVED' &&
          new Date(a.createdAt).getTime() > cutoff
      );
      if (existing) {
        return { alert: null, deduplicated: true };
      }
    }

    const now = new Date().toISOString();
    const record: AlertRecord = {
      id: uuidv4(),
      dedupKey: input.dedupKey,
      incidentId: input.incidentId,
      incidentTitle: input.incidentTitle,
      warehouseId: input.warehouseId,
      warehouseName: input.warehouseName,
      itemId: input.itemId,
      itemName: input.itemName,
      alertType: input.alertType,
      severity: input.severity,
      status: 'ACTIVE',
      title: input.title,
      message: input.message,
      triggerFactor: input.triggerFactor,
      previousValue: input.previousValue ?? null,
      currentValue: input.currentValue ?? null,
      source: input.source,
      cooldownMinutes: cooldownMin,
      acknowledgedBy: null,
      acknowledgedAt: null,
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
      mode: input.mode,
      createdAt: now,
      updatedAt: now,
    };

    this.state.alerts.unshift(record);
    if (this.state.alerts.length > 300) {
      this.state.alerts.length = 300;
    }

    // Mirror into notifications feed so existing UI indicators stay in sync
    this.addNotification({
      dedupKey: `alert:${record.dedupKey}`,
      userId: 'all',
      orgId: 'org-central-cmd',
      eventType: `alert.${record.alertType}`,
      severity: record.severity,
      title: record.title,
      message: record.message,
      entityType: record.incidentId ? 'incident' : record.warehouseId ? 'warehouse' : 'alert',
      entityId: record.incidentId || record.warehouseId || record.id,
      channel: 'in_app',
      mode: record.mode,
    });

    this.save();
    return { alert: record, deduplicated: false };
  }

  public acknowledgeAlert(alertId: string, actorName: string): AlertRecord | null {
    const alert = this.state.alerts.find((a) => a.id === alertId);
    if (!alert) return null;
    if (alert.status === 'RESOLVED') return alert;
    const now = new Date().toISOString();
    alert.status = 'ACKNOWLEDGED';
    alert.acknowledgedBy = actorName;
    alert.acknowledgedAt = now;
    alert.updatedAt = now;
    this.save();
    return alert;
  }

  public resolveAlert(alertId: string, actorName: string, resolutionNote?: string): AlertRecord | null {
    const alert = this.state.alerts.find((a) => a.id === alertId);
    if (!alert) return null;
    const now = new Date().toISOString();
    alert.status = 'RESOLVED';
    alert.resolvedBy = actorName;
    alert.resolvedAt = now;
    alert.resolutionNote = resolutionNote || 'Resolved by operator';
    alert.updatedAt = now;
    this.save();
    return alert;
  }

  public resetDemoData(): void {
    const keepOp = <T extends { mode: DataMode }>(arr: T[]) => arr.filter((x) => x.mode === 'operational');
    const demo = buildDemoDataset();
    this.state.incidents = [...keepOp(this.state.incidents), ...demo.incidents];
    this.state.incidentReports = [...keepOp(this.state.incidentReports), ...demo.incidentReports];
    this.state.reliefRequests = [...keepOp(this.state.reliefRequests), ...demo.reliefRequests];
    this.state.warehouses = [...keepOp(this.state.warehouses), ...demo.warehouses];
    this.state.inventoryCatalog = [...keepOp(this.state.inventoryCatalog), ...demo.inventoryCatalog];
    this.state.inventory = [...keepOp(this.state.inventory), ...demo.inventory];
    this.state.inventoryBatches = [...keepOp(this.state.inventoryBatches), ...demo.inventoryBatches];
    this.state.stockMovements = [...keepOp(this.state.stockMovements), ...demo.stockMovements];
    this.state.stockReservations = [...keepOp(this.state.stockReservations), ...demo.stockReservations];
    this.state.incomingSupplies = [...keepOp(this.state.incomingSupplies), ...demo.incomingSupplies];
    this.state.vehicles = [...keepOp(this.state.vehicles), ...demo.vehicles];
    this.state.drivers = [...keepOp(this.state.drivers), ...demo.drivers];
    this.state.routeHazards = [...keepOp(this.state.routeHazards), ...demo.routeHazards];
    this.state.allocations = [...keepOp(this.state.allocations), ...demo.allocations];
    this.state.dispatches = [...keepOp(this.state.dispatches), ...demo.dispatches];
    this.state.deliveryConfirmations = [...keepOp(this.state.deliveryConfirmations), ...demo.deliveryConfirmations];
    this.state.logisticsAdvisories = keepOp(this.state.logisticsAdvisories);
    this.state.riskAssessments = [...keepOp(this.state.riskAssessments), ...demo.riskAssessments];
    this.state.aiRiskAnalyses = keepOp(this.state.aiRiskAnalyses);
    this.state.alerts = [...keepOp(this.state.alerts), ...demo.alerts];
    this.state.predictions = [...keepOp(this.state.predictions), ...demo.predictions];
    this.state.notifications = [...keepOp(this.state.notifications), ...demo.notifications];
    this.state.aiCoordinationSessions = keepOp(this.state.aiCoordinationSessions);
    this.state.aiAgentTasks = keepOp(this.state.aiAgentTasks);
    this.state.aiAgentResults = keepOp(this.state.aiAgentResults);
    this.state.aiCoordinationEvents = keepOp(this.state.aiCoordinationEvents);
    this.state.aiEvidenceRecords = keepOp(this.state.aiEvidenceRecords);
    this.state.aiRecommendations = keepOp(this.state.aiRecommendations);
    this.state.aiResponsePlans = keepOp(this.state.aiResponsePlans);
    this.state.aiPlanActions = keepOp(this.state.aiPlanActions);
    this.state.aiApprovalRequests = keepOp(this.state.aiApprovalRequests);
    this.state.aiApprovalEvents = keepOp(this.state.aiApprovalEvents);
    this.state.aiConflicts = keepOp(this.state.aiConflicts);
    this.state.aiSessionMemory = keepOp(this.state.aiSessionMemory);
    this.state.aiSimulationSessions = keepOp(this.state.aiSimulationSessions);
    this.state.aiSimulationResults = keepOp(this.state.aiSimulationResults);
    this.state.aiTriggerEvents = keepOp(this.state.aiTriggerEvents);
    this.save();
  }

  public getOfflineIdempotency(actionId: string): OfflineIdempotencyRecord | undefined {
    return this.state.offlineIdempotency[actionId];
  }

  public recordOfflineIdempotency(record: OfflineIdempotencyRecord): void {
    this.state.offlineIdempotency[record.actionId] = record;
    const keys = Object.keys(this.state.offlineIdempotency);
    if (keys.length > 500) {
      keys
        .sort(
          (a, b) =>
            this.state.offlineIdempotency[a].processedAt.localeCompare(
              this.state.offlineIdempotency[b].processedAt
            )
        )
        .slice(0, keys.length - 500)
        .forEach((k) => {
          delete this.state.offlineIdempotency[k];
        });
    }
    this.save();
  }
}

export const store = new PersistentStore();
