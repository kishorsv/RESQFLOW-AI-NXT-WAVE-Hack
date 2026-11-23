import heroAerialFlood from '../../assets/images/hero_aerial_flood_response_1795282044573.jpg';
import missionRescueCoord from '../../assets/images/mission_rescue_coordination_1795282043372.jpg';
import intelSatelliteCmd from '../../assets/images/intel_satellite_command_1795282043638.jpg';
import resourceReliefWarehouse from '../../assets/images/resource_relief_warehouse_1795282043775.jpg';
import logisticsReliefConvoy from '../../assets/images/logistics_relief_convoy_1795282042177.jpg';
import impactHumanitarianAid from '../../assets/images/impact_humanitarian_aid_1795282041819.jpg';

export type HomepageImageTheme =
  | 'hero'
  | 'mission'
  | 'emergency_intelligence'
  | 'risk_intelligence'
  | 'resource_intelligence'
  | 'smart_allocation'
  | 'logistics_coordination'
  | 'impact';

export interface CuratedImageAsset {
  id: HomepageImageTheme;
  src: string;
  alt: string;
  caption: string;
  category: string;
  objectPosition: string;
  keywords: string[];
}

/**
 * Deterministic section-themed photography catalog for RESQFLOW AI.
 * Bundled locally via Vite for instant, reliable, zero-404 delivery across all networks.
 */
export const HOMEPAGE_IMAGE_CATALOG: Record<HomepageImageTheme, CuratedImageAsset> = {
  hero: {
    id: 'hero',
    src: heroAerialFlood,
    alt: 'Aerial twilight view of emergency response vehicles moving along an elevated highway corridor above floodwaters',
    caption: 'Flood Corridor Response',
    category: 'Aerial Response',
    objectPosition: 'center 52%',
    keywords: ['disaster response', 'aerial flood', 'emergency rescue', 'crisis response'],
  },
  mission: {
    id: 'mission',
    src: missionRescueCoord,
    alt: 'Emergency response coordinators reviewing illuminated terrain maps beside a mobile command vehicle in the rain',
    caption: 'Field Command Coordination',
    category: 'Mission Coordination',
    objectPosition: 'center 35%',
    keywords: ['humanitarian response', 'rescue workers', 'emergency relief', 'aid operations'],
  },
  emergency_intelligence: {
    id: 'emergency_intelligence',
    src: missionRescueCoord,
    alt: 'Emergency field teams structuring incoming incident intelligence beside mobile command unit',
    caption: 'Structured Incident Intake',
    category: 'Emergency Intelligence',
    objectPosition: '62% 38%',
    keywords: ['emergency scene', 'command center', 'incident intelligence'],
  },
  risk_intelligence: {
    id: 'risk_intelligence',
    src: intelSatelliteCmd,
    alt: 'Orbital satellite view of a coastal storm system moving over an illuminated shoreline at night',
    caption: 'Orbital Weather & Hazard Telemetry',
    category: 'Earth Observation',
    objectPosition: 'center center',
    keywords: ['satellite imagery', 'earth observation', 'environmental monitoring', 'risk visualization'],
  },
  resource_intelligence: {
    id: 'resource_intelligence',
    src: resourceReliefWarehouse,
    alt: 'High-capacity humanitarian relief warehouse with organized pallets of water, medical supplies, and shelter gear',
    caption: 'Regional Relief Warehouse Operations',
    category: 'Supply Infrastructure',
    objectPosition: 'center 58%',
    keywords: ['relief supplies', 'warehouses', 'humanitarian logistics', 'inventory'],
  },
  smart_allocation: {
    id: 'smart_allocation',
    src: heroAerialFlood,
    alt: 'Elevated flood relief highway connecting regional supply depots to affected coastal neighborhoods',
    caption: 'Multi-Hub Corridor Matching',
    category: 'Resource Allocation',
    objectPosition: '70% 60%',
    keywords: ['connected warehouses', 'resource flow', 'network allocation'],
  },
  logistics_coordination: {
    id: 'logistics_coordination',
    src: logisticsReliefConvoy,
    alt: 'Convoy of heavy humanitarian relief trucks crossing a coastal bridge through twilight mist',
    caption: 'Heavy Relief Convoy Dispatch',
    category: 'Logistics & Transport',
    objectPosition: 'center 58%',
    keywords: ['relief truck', 'transportation', 'emergency trucks', 'route dispatch'],
  },
  impact: {
    id: 'impact',
    src: impactHumanitarianAid,
    alt: 'Humanitarian relief volunteers handing clean water and care packages to families at dawn',
    caption: 'Community Relief Distribution',
    category: 'Humanitarian Recovery',
    objectPosition: 'center 36%',
    keywords: ['communities receiving relief', 'rescue volunteers', 'disaster recovery'],
  },
};

export interface GalleryItem {
  id: string;
  theme: HomepageImageTheme;
  title: string;
  subtitle: string;
  colSpan: string;
  aspect: string;
  objectPosition?: string;
}

export const CURATED_GALLERY_ITEMS: GalleryItem[] = [
  {
    id: 'gallery-flood',
    theme: 'hero',
    title: 'Flood Corridor Access',
    subtitle: 'Aerial visibility across inundated transit arteries',
    colSpan: 'md:col-span-7',
    aspect: 'aspect-[16/10]',
    objectPosition: 'center 56%',
  },
  {
    id: 'gallery-command',
    theme: 'mission',
    title: 'Field Coordination',
    subtitle: 'Multi-agency briefings aligned on one operational map',
    colSpan: 'md:col-span-5',
    aspect: 'aspect-[16/10] md:aspect-auto md:h-full',
    objectPosition: '58% 34%',
  },
  {
    id: 'gallery-satellite',
    theme: 'risk_intelligence',
    title: 'Earth Observation & Risk',
    subtitle: 'Storm track and coastal exposure telemetry',
    colSpan: 'md:col-span-4',
    aspect: 'aspect-[4/3]',
  },
  {
    id: 'gallery-warehouse',
    theme: 'resource_intelligence',
    title: 'Warehouse Operations',
    subtitle: 'Verified stock across water, medical, and shelter hubs',
    colSpan: 'md:col-span-4',
    aspect: 'aspect-[4/3]',
  },
  {
    id: 'gallery-logistics',
    theme: 'logistics_coordination',
    title: 'Convoy Transportation',
    subtitle: 'Hazard-aware dispatch across mountainous and coastal routes',
    colSpan: 'md:col-span-4',
    aspect: 'aspect-[4/3]',
  },
  {
    id: 'gallery-recovery',
    theme: 'impact',
    title: 'Community Relief & Recovery',
    subtitle: 'Delivering verified aid directly to sheltered families',
    colSpan: 'md:col-span-12',
    aspect: 'aspect-[16/8] sm:aspect-[21/8]',
    objectPosition: 'center 34%',
  },
];
