import React from 'react';

/**
 * Section 3: Animated SVG transformation from scattered data points
 * -> connected intelligence -> coordinated response.
 */
export const FragmentedToCoordinatedVisual: React.FC = () => (
  <div className="relative w-full overflow-hidden rounded-2xl border border-white/10 bg-[#0B1220] p-6 sm:p-10">
    <svg
      viewBox="0 0 960 280"
      className="w-full h-auto"
      role="img"
      aria-label="Diagram illustrating transformation from scattered data points to connected intelligence and coordinated emergency response"
    >
      <defs>
        <linearGradient id="tr-line-grad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#A0AEC0" stopOpacity="0.28" />
          <stop offset="50%" stopColor="#35C8F5" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#7185FF" stopOpacity="1" />
        </linearGradient>
        <radialGradient id="tr-core-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#7185FF" stopOpacity="0.34" />
          <stop offset="100%" stopColor="#0B1220" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Subtle architectural background grid */}
      <g stroke="rgba(148,163,184,0.07)" strokeWidth="1">
        {[120, 240, 360, 480, 600, 720, 840].map((x) => (
          <line key={x} x1={x} y1="16" x2={x} y2="236" />
        ))}
        {[70, 140, 210].map((y) => (
          <line key={y} x1="24" y1={y} x2="936" y2={y} />
        ))}
      </g>

      {/* Central intelligence radial light */}
      <circle cx="480" cy="126" r="108" fill="url(#tr-core-glow)" />

      {/* Stage 1: Scattered disconnected data points (left) */}
      <g>
        {[
          { x: 74, y: 66, c: '#FF5C70' },
          { x: 132, y: 112, c: '#A0AEC0' },
          { x: 88, y: 174, c: '#FFB547' },
          { x: 186, y: 68, c: '#35C8F5' },
          { x: 172, y: 186, c: '#A0AEC0' },
          { x: 238, y: 130, c: '#7185FF' },
        ].map((pt, idx) => (
          <g key={idx}>
            <line
              x1={pt.x}
              y1={pt.y}
              x2="480"
              y2="126"
              stroke="url(#tr-line-grad)"
              strokeOpacity="0.35"
              strokeWidth="1.2"
              className="rf-route-dash"
            />
            <circle cx={pt.x} cy={pt.y} r="4.5" fill={pt.c} fillOpacity="0.9" />
          </g>
        ))}
      </g>

      {/* Stage 2: Connected Intelligence Core (center) */}
      <g transform="translate(480, 126)">
        <circle r="44" fill="rgba(113,133,255,0.1)" stroke="#7185FF" strokeOpacity="0.45" strokeWidth="1.2" />
        <circle r="28" fill="#111A2A" stroke="#35C8F5" strokeWidth="1.8" />
        <circle r="28" fill="none" stroke="#35C8F5" strokeWidth="1" className="rf-node-ring" />
        <circle r="6" fill="#F7F9FF" />
      </g>

      {/* Stage 3: Coordinated Response Paths (right) */}
      <g>
        {[
          { x: 760, y: 66, label: 'VERIFIED PLAN', c: '#35C8F5' },
          { x: 838, y: 126, label: 'SAFE DISPATCH', c: '#7185FF' },
          { x: 760, y: 186, label: 'AID DELIVERED', c: '#35D6A0' },
        ].map((target) => (
          <g key={target.label}>
            <path
              d={`M 508 126 C 600 126, 650 ${target.y}, ${target.x} ${target.y}`}
              fill="none"
              stroke={target.c}
              strokeOpacity="0.72"
              strokeWidth="1.8"
              className="rf-route-dash"
            />
            <circle cx={target.x} cy={target.y} r="7" fill="#111A2A" stroke={target.c} strokeWidth="2" />
            <circle cx={target.x} cy={target.y} r="2.8" fill={target.c} />
            <text
              x={target.x + 16}
              y={target.y + 4}
              fill="#E2E8F0"
              fontSize="10.5"
              fontFamily="JetBrains Mono, monospace"
            >
              {target.label}
            </text>
          </g>
        ))}
      </g>

      {/* Bottom Stage Captions */}
      <text x="150" y="258" textAnchor="middle" fill="#A0AEC0" fontSize="11" fontFamily="JetBrains Mono, monospace">
        01. SCATTERED DATA POINTS
      </text>
      <text x="480" y="258" textAnchor="middle" fill="#35C8F5" fontSize="11" fontFamily="JetBrains Mono, monospace">
        02. CONNECTED INTELLIGENCE
      </text>
      <text x="804" y="258" textAnchor="middle" fill="#7185FF" fontSize="11" fontFamily="JetBrains Mono, monospace">
        03. COORDINATED RESPONSE
      </text>
    </svg>
  </div>
);

/**
 * Section 5: Architectural Multi-Agent AI Network Visualization.
 * Clearly presented as an explanatory workflow diagram (zero fabricated live activity).
 */
export const MultiAgentNetworkVisual: React.FC = () => {
  const agents = [
    { y: 58, name: 'Emergency Intelligence Agent', sub: 'Incidents & verification' },
    { y: 122, name: 'Environmental Agent', sub: 'Weather & hazard telemetry' },
    { y: 186, name: 'Resource Agent', sub: 'Stock ledger & shortages' },
    { y: 250, name: 'Logistics Agent', sub: 'Routes, fleet & dispatch' },
    { y: 314, name: 'Human Impact Agent', sub: 'Vulnerability & equity' },
  ];

  const pipeline = [
    { y: 92, label: 'Evidence', sub: 'Verified vs. calculated' },
    { y: 156, label: 'Response Plan', sub: 'Conflict-checked actions' },
    { y: 220, label: 'Human Review', sub: 'Mandatory commander gate' },
    { y: 284, label: 'Action', sub: 'Controlled execution' },
  ];

  return (
    <div className="relative rounded-2xl border border-white/10 bg-[#0B1220] p-5 sm:p-8 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-5 mb-4 border-b border-white/10 text-xs">
        <span className="font-medium text-[#F7F9FF]">Multi-Agent Coordination Architecture</span>
        <span className="font-mono text-[#A0AEC0]">Architectural Illustration · Read-Only Specialist Agents</span>
      </div>

      <svg
        viewBox="0 0 980 374"
        className="w-full h-auto"
        role="img"
        aria-label="Multi-agent architecture connecting five specialist agents to the AI Coordination Engine, then through Evidence, Response Plan, Human Review, and Action"
      >
        <defs>
          <radialGradient id="ma-center-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#7185FF" stopOpacity="0.32" />
            <stop offset="65%" stopColor="#35C8F5" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#0B1220" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Ambient central indigo aura */}
        <circle cx="496" cy="186" r="130" fill="url(#ma-center-glow)" />

        {/* Left Specialist Agents -> Central Orchestrator */}
        {agents.map((ag) => (
          <g key={ag.name}>
            <path
              d={`M 278 ${ag.y} C 350 ${ag.y}, 372 186, 424 186`}
              fill="none"
              stroke="#7185FF"
              strokeOpacity="0.55"
              strokeWidth="1.6"
              className="rf-route-dash"
            />
            <rect
              x="16"
              y={ag.y - 22}
              width="262"
              height="44"
              rx="11"
              fill="#111A2A"
              stroke="rgba(148,163,184,0.22)"
              strokeWidth="1"
            />
            <circle cx="34" cy={ag.y} r="3.5" fill="#35C8F5" />
            <text x="48" y={ag.y - 3} fill="#F7F9FF" fontSize="12" fontWeight="600" fontFamily="DM Sans, sans-serif">
              {ag.name}
            </text>
            <text x="48" y={ag.y + 12} fill="#A0AEC0" fontSize="10.5" fontFamily="DM Sans, sans-serif">
              {ag.sub}
            </text>
          </g>
        ))}

        {/* Central AI Coordination Engine */}
        <g transform="translate(496, 186)">
          <circle r="72" fill="#111A2A" stroke="#7185FF" strokeOpacity="0.7" strokeWidth="1.75" />
          <circle r="58" fill="none" stroke="#35C8F5" strokeOpacity="0.35" strokeWidth="1" strokeDasharray="4 4" />
          <text
            y="-10"
            textAnchor="middle"
            fill="#35C8F5"
            fontSize="10"
            fontFamily="JetBrains Mono, monospace"
            fontWeight="600"
          >
            ORCHESTRATOR
          </text>
          <text
            y="8"
            textAnchor="middle"
            fill="#F7F9FF"
            fontSize="13.5"
            fontWeight="700"
            fontFamily="Manrope, sans-serif"
          >
            AI Coordination
          </text>
          <text
            y="25"
            textAnchor="middle"
            fill="#F7F9FF"
            fontSize="13.5"
            fontWeight="700"
            fontFamily="Manrope, sans-serif"
          >
            Engine
          </text>
        </g>

        {/* Central Engine -> Right Decision Governance Pipeline */}
        <path
          d="M 568 186 C 636 186, 650 92, 718 92"
          fill="none"
          stroke="#35C8F5"
          strokeOpacity="0.75"
          strokeWidth="1.8"
          className="rf-route-dash"
        />

        {pipeline.map((step, idx) => (
          <g key={step.label}>
            {idx < pipeline.length - 1 && (
              <line
                x1="840"
                y1={step.y + 22}
                x2="840"
                y2={pipeline[idx + 1].y - 22}
                stroke={idx === 2 ? '#35D6A0' : '#7185FF'}
                strokeWidth="1.6"
                strokeOpacity="0.7"
              />
            )}
            <rect
              x="718"
              y={step.y - 22}
              width="244"
              height="44"
              rx="11"
              fill={idx === 2 ? 'rgba(113,133,255,0.16)' : '#111A2A'}
              stroke={idx === 2 ? 'rgba(113,133,255,0.65)' : idx === 3 ? 'rgba(53,214,160,0.48)' : 'rgba(148,163,184,0.22)'}
              strokeWidth="1.2"
            />
            <text
              x="736"
              y={step.y - 3}
              fill={idx === 3 ? '#35D6A0' : '#F7F9FF'}
              fontSize="12.5"
              fontWeight="600"
              fontFamily="DM Sans, sans-serif"
            >
              {`${idx + 1}. ${step.label}`}
            </text>
            <text x="736" y={step.y + 12} fill="#A0AEC0" fontSize="10.5" fontFamily="DM Sans, sans-serif">
              {step.sub}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
};

/**
 * Section 8: Subtle animated world-network arcs for the closing CTA.
 */
export const ClosingNetworkBackdrop: React.FC = () => (
  <svg
    viewBox="0 0 1200 420"
    preserveAspectRatio="xMidYMid slice"
    className="pointer-events-none absolute inset-0 w-full h-full opacity-55"
    aria-hidden="true"
  >
    <defs>
      <radialGradient id="close-glow" cx="50%" cy="50%" r="55%">
        <stop offset="0%" stopColor="#7185FF" stopOpacity="0.22" />
        <stop offset="60%" stopColor="#35C8F5" stopOpacity="0.06" />
        <stop offset="100%" stopColor="#070B14" stopOpacity="0" />
      </radialGradient>
    </defs>
    <rect width="1200" height="420" fill="url(#close-glow)" />
    <ellipse cx="600" cy="240" rx="510" ry="150" fill="none" stroke="rgba(113,133,255,0.16)" strokeWidth="1" />
    <ellipse cx="600" cy="240" rx="360" ry="105" fill="none" stroke="rgba(53,200,245,0.16)" strokeWidth="1" />
    <path
      d="M 140 280 Q 420 90, 600 185 T 1060 155"
      fill="none"
      stroke="#35C8F5"
      strokeOpacity="0.35"
      strokeWidth="1.4"
      className="rf-route-dash"
    />
    <path
      d="M 210 140 Q 520 330, 820 190 T 1090 275"
      fill="none"
      stroke="#7185FF"
      strokeOpacity="0.32"
      strokeWidth="1.4"
      className="rf-route-dash"
    />
    <circle cx="290" cy="184" r="3.5" fill="#35C8F5" />
    <circle cx="600" cy="185" r="4.5" fill="#7185FF" />
    <circle cx="910" cy="176" r="3.5" fill="#35D6A0" />
  </svg>
);
