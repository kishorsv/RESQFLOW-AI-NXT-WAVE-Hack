import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Dispatch, Incident, Warehouse } from '../../shared/types';

export interface Tactical3DSelection {
  kind: 'incident' | 'warehouse' | 'dispatch';
  id: string;
}

export interface Tactical3DCallbacks {
  onSelect: (selection: Tactical3DSelection | null) => void;
  onRendererInfo?: (info: { softwareGl: boolean; renderer: string }) => void;
}

export interface Tactical3DLayerVisibility {
  incidents: boolean;
  warehouses: boolean;
  dispatches: boolean;
  routes: boolean;
  water: boolean;
}

const BAND_COLORS: Record<string, number> = {
  Critical: 0xef4444,
  High: 0xf97316,
  Elevated: 0xf59e0b,
  Guarded: 0x06b6d4,
  Low: 0x10b981,
};

function severityFallbackColor(sev: string): number {
  if (sev === 'critical') return 0xef4444;
  if (sev === 'high') return 0xf97316;
  if (sev === 'medium') return 0xf59e0b;
  return 0x10b981;
}

// Deterministic terrain elevation function for coastal basin & inland ridge
function terrainElevation(x: number, z: number): number {
  // River channel meandering gently along x ~ sin(z * 0.08) * 6
  const riverCenter = Math.sin(z * 0.085) * 6.5 - 2;
  const distFromRiver = Math.abs(x - riverCenter);
  const riverCarve = Math.exp(-(distFromRiver * distFromRiver) / 22) * -1.45;

  // Coastal slope rising slightly to the west (-x) and low coastal plain to the east (+x)
  const coastalSlope = Math.max(0, (-x + 14) * 0.09);

  // Rolling hills inland
  const hills =
    Math.sin(x * 0.11 + 0.5) * Math.cos(z * 0.09) * 1.35 +
    Math.sin(x * 0.22 - z * 0.17) * 0.45;

  return Math.max(-1.4, coastalSlope + hills + riverCarve);
}

// Composite 3-12 part procedural 3D models (NO raw primitive stand-ins)
function buildCommandTower(): THREE.Group {
  const g = new THREE.Group();
  const concreteMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.78, metalness: 0.12 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.35, metalness: 0.72 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x38bdf8,
    roughness: 0.15,
    metalness: 0.3,
    emissive: 0x0369a1,
    emissiveIntensity: 0.4,
  });

  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 2.0, 0.5, 8), concreteMat);
  plinth.position.y = 0.25;
  plinth.castShadow = true;
  plinth.receiveShadow = true;
  g.add(plinth);

  const shaft = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.6, 1.4), concreteMat);
  shaft.position.y = 1.8;
  shaft.castShadow = true;
  g.add(shaft);

  const obsDeck = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.25, 0.85, 8), glassMat);
  obsDeck.position.y = 3.5;
  obsDeck.castShadow = true;
  g.add(obsDeck);

  const roof = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.55, 0.2, 8), steelMat);
  roof.position.y = 4.02;
  roof.castShadow = true;
  g.add(roof);

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 1.8, 6), steelMat);
  mast.position.y = 4.95;
  g.add(mast);

  const radarDish = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.28, 0.14), steelMat);
  radarDish.position.y = 5.5;
  radarDish.name = 'radar-spinner';
  g.add(radarDish);

  return g;
}

function buildWarehouseDepot(): THREE.Group {
  const g = new THREE.Group();
  const padMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.85, metalness: 0.1 });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x0f766e, roughness: 0.55, metalness: 0.25 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.45, metalness: 0.45 });
  const bayMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.6, metalness: 0.4 });
  const accentMat = new THREE.MeshStandardMaterial({
    color: 0x10b981,
    emissive: 0x059669,
    emissiveIntensity: 0.55,
    roughness: 0.25,
  });

  const pad = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.22, 2.5), padMat);
  pad.position.y = 0.11;
  pad.receiveShadow = true;
  g.add(pad);

  const body = new THREE.Mesh(new THREE.BoxGeometry(2.8, 1.25, 1.85), wallMat);
  body.position.y = 0.84;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  const roof = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.18, 2.05), roofMat);
  roof.position.y = 1.54;
  roof.castShadow = true;
  g.add(roof);

  // Three loading bay doors
  for (let i = -1; i <= 1; i++) {
    const bay = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.72, 0.08), bayMat);
    bay.position.set(i * 0.82, 0.58, 0.94);
    g.add(bay);
  }

  // Rooftop status beacon
  const beaconPole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.75, 6), roofMat);
  beaconPole.position.set(1.0, 1.98, -0.5);
  g.add(beaconPole);

  const beaconOrb = new THREE.Mesh(new THREE.OctahedronGeometry(0.24, 0), accentMat);
  beaconOrb.position.set(1.0, 2.48, -0.5);
  g.add(beaconOrb);

  return g;
}

function buildRescueTruck(): THREE.Group {
  const g = new THREE.Group();
  const chassisMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.7, metalness: 0.4 });
  const cabMat = new THREE.MeshStandardMaterial({ color: 0x0284c7, roughness: 0.35, metalness: 0.45 });
  const cargoMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.45, metalness: 0.2 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.15, metalness: 0.5 });
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.9, metalness: 0.1 });
  const lightbarMat = new THREE.MeshStandardMaterial({
    color: 0x22d3ee,
    emissive: 0x06b6d4,
    emissiveIntensity: 0.9,
  });

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.24, 0.85), chassisMat);
  chassis.position.y = 0.34;
  chassis.castShadow = true;
  g.add(chassis);

  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.65, 0.82), cabMat);
  cab.position.set(0.58, 0.76, 0);
  cab.castShadow = true;
  g.add(cab);

  const windshield = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.72), glassMat);
  windshield.position.set(0.92, 0.85, 0);
  g.add(windshield);

  const cargo = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.78, 0.88), cargoMat);
  cargo.position.set(-0.36, 0.84, 0);
  cargo.castShadow = true;
  g.add(cargo);

  const lightbar = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.6), lightbarMat);
  lightbar.position.set(0.6, 1.15, 0);
  g.add(lightbar);

  const wheelGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.16, 10);
  wheelGeo.rotateX(Math.PI / 2);
  const wheelXs = [-0.65, -0.1, 0.62];
  for (const wx of wheelXs) {
    for (const wz of [-0.46, 0.46]) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.position.set(wx, 0.24, wz);
      wheel.castShadow = true;
      g.add(wheel);
    }
  }

  return g;
}

function buildIncidentRiskBeacon(incident: Incident): THREE.Group {
  const g = new THREE.Group();
  const riskVal = incident.riskScore ?? (incident.severity === 'critical' ? 88 : incident.severity === 'high' ? 68 : 44);
  const colorHex = incident.riskBand
    ? BAND_COLORS[incident.riskBand] || severityFallbackColor(incident.severity)
    : severityFallbackColor(incident.severity);

  const height = 1.6 + (riskVal / 100) * 3.2;

  const baseMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.75, metalness: 0.25 });
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.4, metalness: 0.65 });
  const glowMat = new THREE.MeshStandardMaterial({
    color: colorHex,
    emissive: colorHex,
    emissiveIntensity: 0.65,
    roughness: 0.22,
    metalness: 0.15,
  });

  const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.28, 0.28, 6), baseMat);
  pad.position.y = 0.14;
  pad.castShadow = true;
  pad.receiveShadow = true;
  g.add(pad);

  const perimeterRing = new THREE.Mesh(new THREE.TorusGeometry(1.45, 0.07, 8, 24), glowMat);
  perimeterRing.rotation.x = Math.PI / 2;
  perimeterRing.position.y = 0.22;
  g.add(perimeterRing);

  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.26, height, 6), mastMat);
  column.position.y = 0.28 + height / 2;
  column.castShadow = true;
  g.add(column);

  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.24, 6), glowMat);
  collar.position.y = 0.28 + height * 0.68;
  g.add(collar);

  const head = new THREE.Mesh(new THREE.OctahedronGeometry(0.56, 0), glowMat);
  head.position.y = 0.28 + height + 0.55;
  head.name = 'beacon-head';
  head.castShadow = true;
  g.add(head);

  return g;
}

export class Tactical3DSceneController {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private pmrem: THREE.PMREMGenerator;
  private envRenderTarget: THREE.WebGLRenderTarget;
  private resizeObserver: ResizeObserver;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  private entitiesGroup = new THREE.Group();
  private incidentsGroup = new THREE.Group();
  private warehousesGroup = new THREE.Group();
  private dispatchesGroup = new THREE.Group();
  private routesGroup = new THREE.Group();
  private waterMesh: THREE.Mesh;
  private commandTower: THREE.Group;

  private pickables: { object: THREE.Object3D; selection: Tactical3DSelection }[] = [];
  private callbacks: Tactical3DCallbacks;
  private softwareGl = false;
  private disposed = false;
  private rafId: number | null = null;
  private timerId: number | null = null;
  private timer = new THREE.Timer();

  private boundsCenter = { lat: 12.92, lng: 80.12 };
  private boundsSpan = 0.42;

  constructor(container: HTMLElement, callbacks: Tactical3DCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    if (typeof document !== 'undefined') {
      this.timer.connect(document);
    }

    const width = Math.max(300, container.clientWidth);
    const height = Math.max(300, container.clientHeight);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const rendererStr = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '';
    this.softwareGl = /SwiftShader|llvmpipe|Software|Mesa/i.test(rendererStr);
    this.callbacks.onRendererInfo?.({ softwareGl: this.softwareGl, renderer: rendererStr || 'WebGL' });

    this.renderer.setPixelRatio(this.softwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = !this.softwareGl;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    const bgHex = 0x0b1220;
    this.scene.background = new THREE.Color(bgHex);
    this.scene.fog = new THREE.FogExp2(bgHex, 0.0115);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    const roomEnvironment = new RoomEnvironment();
    this.envRenderTarget = this.pmrem.fromScene(roomEnvironment, 0.04);
    roomEnvironment.dispose();
    this.scene.environment = this.envRenderTarget.texture;
    this.scene.environmentIntensity = 0.62;

    this.camera = new THREE.PerspectiveCamera(44, width / height, 0.5, 220);
    this.camera.position.set(28, 22, 30);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.maxPolarAngle = Math.PI * 0.465;
    this.controls.minDistance = 10;
    this.controls.maxDistance = 85;
    this.controls.target.set(0, 1.5, 0);

    // Three-point outdoor lighting setup
    const hemi = new THREE.HemisphereLight(0x93c5fd, 0x1e293b, 0.65);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff1d6, 2.1);
    sun.position.set(28, 42, 22);
    if (!this.softwareGl) {
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.near = 5;
      sun.shadow.camera.far = 110;
      sun.shadow.camera.left = -38;
      sun.shadow.camera.right = 38;
      sun.shadow.camera.top = 38;
      sun.shadow.camera.bottom = -38;
      sun.shadow.radius = 2;
      sun.shadow.bias = -0.0005;
      sun.shadow.normalBias = 0.02;
    }
    this.scene.add(sun);

    const rim = new THREE.DirectionalLight(0x38bdf8, 0.55);
    rim.position.set(-26, 18, -24);
    this.scene.add(rim);

    // Build procedural coastal basin terrain
    const terrainGeo = new THREE.PlaneGeometry(66, 66, 72, 72);
    terrainGeo.rotateX(-Math.PI / 2);
    const pos = terrainGeo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const cLow = new THREE.Color(0x162438);
    const cPlain = new THREE.Color(0x1f3642);
    const cHill = new THREE.Color(0x334b52);
    const cRidge = new THREE.Color(0x475c61);
    const tmpColor = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = terrainElevation(x, z);
      pos.setY(i, y);

      if (y < -0.35) {
        tmpColor.copy(cLow);
      } else if (y < 1.1) {
        tmpColor.copy(cPlain).lerp(cHill, (y + 0.35) / 1.45);
      } else {
        tmpColor.copy(cHill).lerp(cRidge, Math.min(1, (y - 1.1) / 3.2));
      }
      colors[i * 3] = tmpColor.r;
      colors[i * 3 + 1] = tmpColor.g;
      colors[i * 3 + 2] = tmpColor.b;
    }
    terrainGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    terrainGeo.computeVertexNormals();

    const terrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.88,
      metalness: 0.06,
    });
    const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
    terrainMesh.receiveShadow = true;
    this.scene.add(terrainMesh);

    // Subtle tactical grid overlay on terrain floor
    const grid = new THREE.GridHelper(66, 22, 0x1e3a5f, 0x17253b);
    grid.position.y = -1.35;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.25;
    this.scene.add(grid);

    // Coastal flood water plane
    const waterGeo = new THREE.PlaneGeometry(66, 66);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x0c4a6e,
      roughness: 0.16,
      metalness: 0.38,
      transparent: true,
      opacity: 0.72,
    });
    this.waterMesh = new THREE.Mesh(waterGeo, waterMat);
    this.waterMesh.position.y = -0.38;
    this.waterMesh.receiveShadow = true;
    this.scene.add(this.waterMesh);

    // Central Emergency Operations Command Tower on elevated inland bluff
    this.commandTower = buildCommandTower();
    const cmdX = -15;
    const cmdZ = -12;
    this.commandTower.position.set(cmdX, terrainElevation(cmdX, cmdZ), cmdZ);
    this.scene.add(this.commandTower);

    this.entitiesGroup.add(this.incidentsGroup, this.warehousesGroup, this.dispatchesGroup, this.routesGroup);
    this.scene.add(this.entitiesGroup);

    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    this.scheduleNextFrame();
  }

  private geoToWorld(lat: number, lng: number): { x: number; y: number; z: number } {
    const scale = 44 / Math.max(0.15, this.boundsSpan);
    const x = THREE.MathUtils.clamp((lng - this.boundsCenter.lng) * scale, -24, 24);
    const z = THREE.MathUtils.clamp(-(lat - this.boundsCenter.lat) * scale, -24, 24);
    const y = Math.max(-0.25, terrainElevation(x, z));
    return { x, y, z };
  }

  public syncData(data: { incidents: Incident[]; warehouses: Warehouse[]; dispatches: Dispatch[] }) {
    const clearGroup = (grp: THREE.Group) => {
      while (grp.children.length > 0) {
        const child = grp.children[0];
        grp.remove(child);
        child.traverse((obj) => {
          if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
            obj.geometry?.dispose();
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach((m) => m?.dispose());
          }
        });
      }
    };

    clearGroup(this.incidentsGroup);
    clearGroup(this.warehousesGroup);
    clearGroup(this.dispatchesGroup);
    clearGroup(this.routesGroup);
    this.pickables = [];

    // Compute geographic center & span across active entities
    const coords: { lat: number; lng: number }[] = [];
    for (const i of data.incidents) {
      if (Number.isFinite(i.lat) && Number.isFinite(i.lng)) coords.push({ lat: i.lat, lng: i.lng });
    }
    for (const w of data.warehouses) {
      if (Number.isFinite(w.lat) && Number.isFinite(w.lng)) coords.push({ lat: w.lat, lng: w.lng });
    }
    if (coords.length > 0) {
      const lats = coords.map((c) => c.lat);
      const lngs = coords.map((c) => c.lng);
      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);
      const minLng = Math.min(...lngs);
      const maxLng = Math.max(...lngs);
      this.boundsCenter = { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
      this.boundsSpan = Math.max(0.28, maxLat - minLat + 0.14, maxLng - minLng + 0.14);
    }

    // Plot incidents as multi-part Risk Beacon Towers
    for (const inc of data.incidents) {
      if (!Number.isFinite(inc.lat) || !Number.isFinite(inc.lng)) continue;
      const pos = this.geoToWorld(inc.lat, inc.lng);
      const beacon = buildIncidentRiskBeacon(inc);
      beacon.position.set(pos.x, pos.y, pos.z);
      this.incidentsGroup.add(beacon);
      this.pickables.push({ object: beacon, selection: { kind: 'incident', id: inc.id } });
    }

    // Plot warehouses as composite Supply Depots
    for (const wh of data.warehouses) {
      if (!Number.isFinite(wh.lat) || !Number.isFinite(wh.lng)) continue;
      const pos = this.geoToWorld(wh.lat, wh.lng);
      const depot = buildWarehouseDepot();
      depot.position.set(pos.x, pos.y, pos.z);
      this.warehousesGroup.add(depot);
      this.pickables.push({ object: depot, selection: { kind: 'warehouse', id: wh.id } });
    }

    // Plot active dispatches as 6x6 Rescue Trucks + elevated tactical route arcs
    for (const dsp of data.dispatches) {
      if (dsp.currentLat !== null && dsp.currentLng !== null) {
        const pos = this.geoToWorld(dsp.currentLat, dsp.currentLng);
        const truck = buildRescueTruck();
        truck.position.set(pos.x, pos.y, pos.z);
        this.dispatchesGroup.add(truck);
        this.pickables.push({ object: truck, selection: { kind: 'dispatch', id: dsp.id } });
      }

      if (dsp.route?.geometry && dsp.route.geometry.length >= 2) {
        const pts = dsp.route.geometry.map((pt) => {
          const w = this.geoToWorld(pt.lat, pt.lng);
          return new THREE.Vector3(w.x, w.y + 0.65, w.z);
        });
        const curve = new THREE.CatmullRomCurve3(pts);
        const tubeGeo = new THREE.TubeGeometry(curve, Math.max(12, pts.length * 4), 0.12, 6, false);
        const tubeMat = new THREE.MeshStandardMaterial({
          color: 0x06b6d4,
          emissive: 0x0891b2,
          emissiveIntensity: 0.6,
          roughness: 0.3,
        });
        const tube = new THREE.Mesh(tubeGeo, tubeMat);
        this.routesGroup.add(tube);
      }
    }
  }

  public setLayers(vis: Tactical3DLayerVisibility) {
    this.incidentsGroup.visible = vis.incidents;
    this.warehousesGroup.visible = vis.warehouses;
    this.dispatchesGroup.visible = vis.dispatches;
    this.routesGroup.visible = vis.routes;
    this.waterMesh.visible = vis.water;
  }

  public setCameraPreset(preset: 'overview' | 'aerial' | 'basin' | 'command') {
    if (preset === 'overview') {
      this.camera.position.set(28, 22, 30);
      this.controls.target.set(0, 1.5, 0);
    } else if (preset === 'aerial') {
      this.camera.position.set(0, 48, 8);
      this.controls.target.set(0, 0, 0);
    } else if (preset === 'basin') {
      this.camera.position.set(20, 10, 16);
      this.controls.target.set(-2, 0.5, 0);
    } else if (preset === 'command') {
      this.camera.position.set(-5, 11, -2);
      this.controls.target.set(-15, 3, -12);
    }
    this.controls.update();
  }

  public focusCoordinates(lat: number, lng: number) {
    const pos = this.geoToWorld(lat, lng);
    this.controls.target.set(pos.x, pos.y + 1.5, pos.z);
    this.camera.position.set(pos.x + 11, pos.y + 10, pos.z + 12);
    this.controls.update();
  }

  private handlePointerDown = (event: PointerEvent) => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const meshes = this.pickables.map((p) => p.object);
    const hits = this.raycaster.intersectObjects(meshes, true);
    if (hits.length === 0) return;

    let hitObj: THREE.Object3D | null = hits[0].object;
    while (hitObj) {
      const found = this.pickables.find((p) => p.object === hitObj);
      if (found) {
        this.callbacks.onSelect(found.selection);
        return;
      }
      hitObj = hitObj.parent;
    }
  };

  private handleResize() {
    if (this.disposed) return;
    const w = Math.max(300, this.container.clientWidth);
    const h = Math.max(300, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private renderFrame = () => {
    if (this.disposed) return;
    this.timer.update();
    const elapsed = this.timer.getElapsed();

    // Gentle non-distracting mechanical motion (radar rotation & beacon head spin)
    const radar = this.commandTower.getObjectByName('radar-spinner');
    if (radar) radar.rotation.y = elapsed * 0.9;

    this.incidentsGroup.children.forEach((group, idx) => {
      const head = group.getObjectByName('beacon-head');
      if (head) {
        head.rotation.y = elapsed * 0.8 + idx;
      }
    });

    this.waterMesh.position.y = -0.38 + Math.sin(elapsed * 0.7) * 0.04;

    this.controls.update();
    this.renderer.render(this.scene, this.camera);

    this.scheduleNextFrame();
  };

  private scheduleNextFrame() {
    if (this.disposed) return;
    if (this.softwareGl) {
      this.renderer.getContext().finish();
      this.timerId = window.setTimeout(() => this.renderFrame(), 100);
    } else {
      this.rafId = window.requestAnimationFrame(this.renderFrame);
    }
  }

  public dispose() {
    this.disposed = true;
    if (this.rafId !== null) window.cancelAnimationFrame(this.rafId);
    if (this.timerId !== null) window.clearTimeout(this.timerId);
    this.timer.dispose();
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.controls.dispose();
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        obj.geometry?.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => m?.dispose());
      }
    });
    this.scene.environment = null;
    this.envRenderTarget.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
