import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Compass,
  Eye,
  Layers,
  ShieldAlert,
  Truck,
  Warehouse as WarehouseIcon,
  X,
} from 'lucide-react';
import {
  Tactical3DSceneController,
  type Tactical3DLayerVisibility,
  type Tactical3DSelection,
} from '../../lib/tactical3d/scene';
import type { DataMode, Dispatch, Incident, Warehouse } from '../../shared/types';

interface Tactical3DTwinViewProps {
  mode: DataMode;
  incidents: Incident[];
  warehouses: Warehouse[];
  dispatches: Dispatch[];
  onOpenIncidents: () => void;
}

export const Tactical3DTwinView: React.FC<Tactical3DTwinViewProps> = ({
  mode,
  incidents,
  warehouses,
  dispatches,
  onOpenIncidents,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<Tactical3DSceneController | null>(null);

  const [dockOpen, setDockOpen] = useState(true);
  const [selection, setSelection] = useState<Tactical3DSelection | null>(null);
  const [layers, setLayers] = useState<Tactical3DLayerVisibility>({
    incidents: true,
    warehouses: true,
    dispatches: true,
    routes: true,
    water: true,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ctrl = new Tactical3DSceneController(el, {
      onSelect: (sel) => setSelection(sel),
    });
    controllerRef.current = ctrl;
    ctrl.syncData({ incidents, warehouses, dispatches });
    ctrl.setLayers(layers);

    return () => {
      ctrl.dispose();
      controllerRef.current = null;
    };
    // Mount WebGL context once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    controllerRef.current?.syncData({ incidents, warehouses, dispatches });
  }, [incidents, warehouses, dispatches, mode]);

  useEffect(() => {
    controllerRef.current?.setLayers(layers);
  }, [layers]);

  const selectedEntity = useMemo(() => {
    if (!selection) return null;
    if (selection.kind === 'incident') {
      const item = incidents.find((i) => i.id === selection.id);
      return item ? { kind: 'incident' as const, item } : null;
    }
    if (selection.kind === 'warehouse') {
      const item = warehouses.find((w) => w.id === selection.id);
      return item ? { kind: 'warehouse' as const, item } : null;
    }
    const item = dispatches.find((d) => d.id === selection.id);
    return item ? { kind: 'dispatch' as const, item } : null;
  }, [selection, incidents, warehouses, dispatches]);

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">
            3D Tactical Emergency Terrain &amp; Risk Twin
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Interactive WebGL basin visualization plotting live incident risk towers, supply depots, and 6x6 relief convoys. Click any 3D asset to inspect.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs font-mono text-slate-500 tabular-nums">
          <span>{incidents.length} Risk Towers</span>
          <span>·</span>
          <span>{warehouses.length} Depots</span>
          <span>·</span>
          <span>{dispatches.length} Convoys</span>
        </div>
      </div>

      {/* Full-bleed WebGL Viewport (zero backdrop-filter over canvas) */}
      <div className="relative rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden bg-[#0b1220] h-[640px]">
        <div ref={containerRef} className="w-full h-full cursor-grab active:cursor-grabbing" />

        {/* Selected Entity Tactical Card (solid surface, zero backdrop-filter) */}
        {selectedEntity && (
          <div className="absolute top-4 right-4 w-80 rounded-xl border border-slate-700 bg-[#0d1628] text-slate-100 p-4 shadow-2xl space-y-2.5 z-10">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 text-[11px] font-mono uppercase text-cyan-400">
                {selectedEntity.kind === 'incident' && <ShieldAlert className="w-3.5 h-3.5 text-red-400" />}
                {selectedEntity.kind === 'warehouse' && <WarehouseIcon className="w-3.5 h-3.5 text-emerald-400" />}
                {selectedEntity.kind === 'dispatch' && <Truck className="w-3.5 h-3.5 text-cyan-400" />}
                <span>{selectedEntity.kind}</span>
              </div>
              <button
                type="button"
                onClick={() => setSelection(null)}
                className="text-slate-400 hover:text-white"
                aria-label="Close inspector"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {selectedEntity.kind === 'incident' && (
              <>
                <div className="text-sm font-semibold leading-snug">{selectedEntity.item.title}</div>
                <div className="grid grid-cols-2 gap-2 text-xs font-mono tabular-nums">
                  <div className="p-2 rounded-lg bg-[#131f36] border border-slate-800">
                    <div className="text-[10px] text-slate-400">RISK SCORE</div>
                    <div className="text-sm font-bold text-cyan-400">
                      {selectedEntity.item.riskScore !== null ? `${selectedEntity.item.riskScore}/100` : 'Unscored'}
                    </div>
                  </div>
                  <div className="p-2 rounded-lg bg-[#131f36] border border-slate-800">
                    <div className="text-[10px] text-slate-400">SEVERITY</div>
                    <div className="text-sm font-bold uppercase text-orange-400">
                      {selectedEntity.item.severity}
                    </div>
                  </div>
                </div>
                <div className="text-xs text-slate-300">
                  {selectedEntity.item.peopleAffected.toLocaleString()} affected ·{' '}
                  {selectedEntity.item.vulnerablePopulation.toLocaleString()} vulnerable ·{' '}
                  {selectedEntity.item.status.toUpperCase()}
                </div>
                <div className="text-[11px] font-mono text-slate-400">
                  {selectedEntity.item.address} ({selectedEntity.item.lat.toFixed(4)}, {selectedEntity.item.lng.toFixed(4)})
                </div>
                <button
                  type="button"
                  onClick={onOpenIncidents}
                  className="w-full py-1.5 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium"
                >
                  Open Incident Command Workspace
                </button>
              </>
            )}

            {selectedEntity.kind === 'warehouse' && (
              <>
                <div className="text-sm font-semibold">{selectedEntity.item.name}</div>
                <div className="text-xs text-slate-300">
                  Status: <strong className="uppercase text-emerald-400">{selectedEntity.item.status}</strong> · Access:{' '}
                  {selectedEntity.item.accessibility}
                </div>
                <div className="text-xs font-mono text-slate-400 tabular-nums">
                  Capacity: {selectedEntity.item.usedUnits.toLocaleString()} /{' '}
                  {selectedEntity.item.capacityUnits.toLocaleString()} units
                </div>
              </>
            )}

            {selectedEntity.kind === 'dispatch' && (
              <>
                <div className="text-sm font-semibold">{selectedEntity.item.vehicleCallsign}</div>
                <div className="text-xs text-slate-300">
                  Destination: {selectedEntity.item.destinationName}
                </div>
                <div className="text-xs font-mono text-cyan-400">
                  {selectedEntity.item.status.toUpperCase()} · {selectedEntity.item.gpsLabel}
                </div>
              </>
            )}
          </div>
        )}

        {/* Collapsible Bottom Tactical Control Dock (solid surface, zero backdrop-filter) */}
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 w-[min(94%,860px)] z-10">
          <div className="rounded-xl border border-slate-700 bg-[#0d1628] text-slate-100 shadow-2xl overflow-hidden">
            <button
              type="button"
              onClick={() => setDockOpen((v) => !v)}
              className="w-full px-4 py-2 flex items-center justify-between text-xs font-mono text-slate-300 hover:bg-[#131f36]"
            >
              <span className="flex items-center gap-2">
                <Compass className="w-3.5 h-3.5 text-cyan-400" />
                3D TACTICAL CONTROLS · CAMERA PRESETS &amp; LAYER MATRIX
              </span>
              {dockOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
            </button>

            {dockOpen && (
              <div className="px-4 py-3 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-mono text-slate-400 mr-1 flex items-center gap-1">
                    <Eye className="w-3 h-3" /> Camera:
                  </span>
                  {(
                    [
                      ['overview', 'Basin Overview'],
                      ['basin', 'Floodplain'],
                      ['command', 'Command Tower'],
                      ['aerial', 'Top-Down'],
                    ] as const
                  ).map(([preset, label]) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => controllerRef.current?.setCameraPreset(preset)}
                      className="px-2.5 py-1 rounded-md border border-slate-700 bg-[#131f36] hover:border-cyan-500 text-slate-200"
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-mono text-slate-400 mr-1 flex items-center gap-1">
                    <Layers className="w-3 h-3" /> Layers:
                  </span>
                  {(
                    [
                      ['incidents', 'Risk Towers'],
                      ['warehouses', 'Depots'],
                      ['dispatches', 'Vehicles'],
                      ['routes', 'Routes'],
                      ['water', 'Flood Water'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setLayers((prev) => ({ ...prev, [key]: !prev[key] }))}
                      className={`px-2.5 py-1 rounded-md border ${
                        layers[key]
                          ? 'border-cyan-500 bg-cyan-500/20 text-cyan-200'
                          : 'border-slate-700 bg-[#0b1220] text-slate-500'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {incidents.length > 0 && (
                  <div className="w-full pt-2 border-t border-slate-800 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-mono text-slate-400 mr-1">Focus Incident:</span>
                    {incidents.slice(0, 4).map((inc) => (
                      <button
                        key={inc.id}
                        type="button"
                        onClick={() => {
                          controllerRef.current?.focusCoordinates(inc.lat, inc.lng);
                          setSelection({ kind: 'incident', id: inc.id });
                        }}
                        className="px-2 py-0.5 rounded border border-slate-700 bg-[#131f36] hover:border-cyan-400 text-[11px] text-slate-200 truncate max-w-[200px]"
                      >
                        {inc.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
