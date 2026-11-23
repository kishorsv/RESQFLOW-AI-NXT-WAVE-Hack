import React, { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  Menu,
  Shield,
  X,
} from 'lucide-react';
import { BrandMark } from '../ui/BrandMark';
import { CinematicImage } from '../landing/CinematicImage';
import { CURATED_GALLERY_ITEMS } from '../landing/imageCatalog';
import {
  ClosingNetworkBackdrop,
  FragmentedToCoordinatedVisual,
  MultiAgentNetworkVisual,
} from '../landing/NetworkVisuals';
import { ScrollReveal } from '../landing/ScrollReveal';
import type { DataMode } from '../../shared/types';

interface LandingViewProps {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onEnterApp: (targetView?: string) => void;
  onOpenLogin: () => void;
  onSignInGoogle?: () => Promise<void> | void;
  isSignedIn?: boolean;
  mode: DataMode;
  connectionState: string;
  liveCounts: {
    incidents: number;
    warehouses: number;
    requests: number;
    dispatches: number;
  };
}

const PROBLEM_POINTS = [
  {
    index: '01.',
    title: 'Critical information is fragmented',
    detail: 'Field calls, hazard advisories, and community requests arrive across disconnected tools with no single source of truth.',
  },
  {
    index: '02.',
    title: 'Emergency conditions evolve rapidly',
    detail: 'Rising floodwaters, road washouts, and storm surges outpace static spreadsheets and manual status checks.',
  },
  {
    index: '03.',
    title: 'Relief resources are difficult to track',
    detail: 'Water, medical kits, shelter gear, and transport assets sit dispersed across regional hubs without unified visibility.',
  },
  {
    index: '04.',
    title: 'Supply shortages remain hidden',
    detail: 'Reserved stock, damaged lots, and expiring medical batches mask true availability until dispatch teams attempt to load.',
  },
  {
    index: '05.',
    title: 'Routes become unsafe without warning',
    detail: 'Blocked bridges, landslides, and flooded corridors turn routine deliveries into hazardous delays.',
  },
  {
    index: '06.',
    title: 'Multiple agencies struggle to coordinate',
    detail: 'Without shared evidence and human-approved plans, parallel responders risk duplicating effort while vulnerable sites wait.',
  },
];

const NAV_LINKS = [
  { href: '#home', label: 'Home' },
  { href: '#mission', label: 'Our Mission' },
  { href: '#intelligence', label: 'Intelligence' },
  { href: '#platform', label: 'Platform' },
  { href: '#impact', label: 'Impact' },
];

export const LandingView: React.FC<LandingViewProps> = ({
  onEnterApp,
  onOpenLogin,
  isSignedIn = false,
}) => {
  const [scrolled, setScrolled] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 28);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileNavOpen(false);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const handleSignIn = () => {
    if (isSignedIn) {
      onEnterApp('overview');
      return;
    }
    onOpenLogin();
  };

  return (
    <div className="min-h-screen bg-[#070B14] text-[#F7F9FF] selection:bg-[#7185FF]/30 selection:text-white overflow-x-clip">
      {/* =====================================================================
          FLOATING CINEMATIC TOP NAVIGATION
         ===================================================================== */}
      <header
        className={`fixed top-0 inset-x-0 z-50 h-[72px] transition-all duration-300 ${
          scrolled
            ? 'bg-[#070B14]/82 backdrop-blur-xl border-b border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.45)]'
            : 'bg-gradient-to-b from-[#070B14]/75 to-transparent border-b border-transparent'
        }`}
      >
        <div className="max-w-[1360px] h-full mx-auto px-5 sm:px-8 flex items-center justify-between gap-8">
          {/* Zone 1: Brand Wordmark */}
          <a
            href="#home"
            className="flex items-center gap-2.5 whitespace-nowrap shrink-0"
          >
            <BrandMark size={30} />
            <span className="font-[var(--font-display)] text-[17px] font-bold tracking-tight text-[#F7F9FF]">
              RESQFLOW AI
            </span>
          </a>

          {/* Zone 2: 5 Single-Line Navigation Links */}
          <nav
            aria-label="Homepage navigation"
            className="hidden lg:flex items-center gap-7 text-[13.5px] font-medium text-[#CBD5E1]"
          >
            {NAV_LINKS.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="py-1 whitespace-nowrap shrink-0 hover:text-white border-b border-transparent hover:border-[#7185FF] transition-colors"
              >
                {item.label}
              </a>
            ))}
          </nav>

          {/* Zone 3: Sign In + Launch Platform */}
          <div className="hidden md:flex items-center gap-4 shrink-0">
            <button
              type="button"
              onClick={handleSignIn}
              className="text-[13.5px] font-medium text-[#CBD5E1] hover:text-white transition-colors whitespace-nowrap px-2 py-1.5"
            >
              {isSignedIn ? 'Account' : 'Sign In'}
            </button>
            <button
              type="button"
              onClick={() => onEnterApp('overview')}
              className="inline-flex items-center gap-2 h-10 px-4.5 rounded-[10px] bg-[#7185FF] hover:bg-[#8294FF] text-white text-[13.5px] font-semibold transition-all duration-200 shadow-[0_0_24px_rgba(113,133,255,0.28)] whitespace-nowrap group"
            >
              <span>Launch Platform</span>
              <ArrowRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </button>
          </div>

          {/* Mobile Hamburger Trigger */}
          <button
            type="button"
            onClick={() => setMobileNavOpen((o) => !o)}
            className="lg:hidden inline-flex items-center justify-center w-10 h-10 rounded-[10px] border border-white/15 bg-[#0B1220]/70 text-[#F7F9FF]"
            aria-label={mobileNavOpen ? 'Close navigation menu' : 'Open navigation menu'}
          >
            {mobileNavOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>

        {/* Smooth Mobile Drawer */}
        {mobileNavOpen && (
          <div className="lg:hidden border-b border-white/10 bg-[#070B14]/95 backdrop-blur-xl px-5 py-6 space-y-5 rf-animate-in">
            <nav className="flex flex-col gap-3 text-sm font-medium text-[#CBD5E1]">
              {NAV_LINKS.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileNavOpen(false)}
                  className="py-2 border-b border-white/5 hover:text-white"
                >
                  {item.label}
                </a>
              ))}
            </nav>
            <div className="flex flex-col sm:flex-row gap-3 pt-1">
              <button
                type="button"
                onClick={() => {
                  setMobileNavOpen(false);
                  void handleSignIn();
                }}
                className="h-11 px-4 rounded-[10px] border border-white/15 bg-[#111A2A] text-sm font-medium text-[#F7F9FF]"
              >
                {isSignedIn ? 'Open Workspace' : 'Sign In'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMobileNavOpen(false);
                  onEnterApp('overview');
                }}
                className="h-11 px-5 rounded-[10px] bg-[#7185FF] hover:bg-[#8294FF] text-sm font-semibold text-white inline-flex items-center justify-center gap-2"
              >
                <span>Launch Platform</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </header>

      <main>
        {/* ===================================================================
            SECTION 1 — FULL-SCREEN CINEMATIC HERO (100svh)
           =================================================================== */}
        <section
          id="home"
          className="relative min-h-[100svh] flex flex-col justify-between pt-28 pb-10 sm:pb-12 overflow-hidden"
        >
          {/* Full-Bleed High-Resolution Disaster Response Backdrop */}
          <div className="absolute inset-0 z-0">
            <CinematicImage
              theme="hero"
              priority
              kenBurns
              scrim="hero"
              className="w-full h-full"
            />
            {/* Secondary directional reading scrim for crisp WCAG AA contrast */}
            <div
              className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#070B14]/90 via-[#070B14]/55 to-[#070B14]/35"
              aria-hidden="true"
            />
            {/* Ambient Indigo & Ice-Cyan Atmospheric Illumination */}
            <div
              className="pointer-events-none absolute -top-24 left-[12%] w-[560px] h-[560px] rounded-full rf-ambient-orb"
              style={{
                background:
                  'radial-gradient(circle, rgba(113,133,255,0.22) 0%, rgba(113,133,255,0) 68%)',
              }}
              aria-hidden="true"
            />
            <div
              className="pointer-events-none absolute bottom-[-80px] right-[8%] w-[520px] h-[520px] rounded-full rf-ambient-orb"
              style={{
                animationDelay: '4s',
                background:
                  'radial-gradient(circle, rgba(53,200,245,0.16) 0%, rgba(53,200,245,0) 70%)',
              }}
              aria-hidden="true"
            />
            {/* Subtle Coordinate Grid & Minimal Network Light Lines */}
            <div className="pointer-events-none absolute inset-0 rf-hero-grid opacity-35" aria-hidden="true" />
            <svg
              viewBox="0 0 1440 820"
              preserveAspectRatio="xMidYMid slice"
              className="pointer-events-none absolute inset-0 w-full h-full opacity-45"
              aria-hidden="true"
            >
              <path
                d="M 120 620 Q 540 420, 960 470 T 1380 260"
                fill="none"
                stroke="#35C8F5"
                strokeOpacity="0.4"
                strokeWidth="1.2"
                className="rf-route-dash"
              />
              <circle cx="960" cy="470" r="3.5" fill="#35C8F5" />
              <circle cx="1220" cy="342" r="3" fill="#7185FF" />
              <circle cx="1320" cy="288" r="3.5" fill="#FF5C70" />
            </svg>
          </div>

          {/* Center-Left Hero Editorial Content */}
          <div className="relative z-10 max-w-[1360px] w-full mx-auto px-5 sm:px-8 my-auto py-12 sm:py-16">
            <div className="max-w-4xl space-y-7 rf-animate-in">
              <p className="text-xs sm:text-[13px] font-semibold tracking-[0.2em] uppercase text-[#35C8F5]">
                Intelligence for a world in crisis
              </p>

              <h1 className="font-[var(--font-display)] text-[clamp(2.65rem,6vw,5.4rem)] font-bold leading-[1.03] tracking-[-0.035em] text-[#F7F9FF]">
                When every second matters,
                <br />
                <span className="bg-gradient-to-r from-[#F7F9FF] via-[#35C8F5] to-[#7185FF] bg-clip-text text-transparent">
                  intelligence
                </span>{' '}
                changes everything.
              </h1>

              <p className="text-[16px] sm:text-[18.5px] leading-[1.68] text-[#CBD5E1] max-w-[60ch]">
                In moments of crisis, fragmented information costs time. RESQFLOW AI connects emergency
                intelligence, environmental risks, relief resources, and logistics into one coordinated
                response network.
              </p>

              <div className="flex flex-wrap items-center gap-4 pt-2">
                <button
                  type="button"
                  onClick={() => onEnterApp('overview')}
                  className="inline-flex items-center gap-2.5 h-[52px] px-7 rounded-[12px] bg-[#7185FF] hover:bg-[#8294FF] text-white text-[15px] font-semibold transition-all duration-200 shadow-[0_8px_32px_rgba(113,133,255,0.36)] hover:shadow-[0_12px_38px_rgba(113,133,255,0.5)] group"
                >
                  <span>Explore the Platform</span>
                  <ArrowRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                </button>
                <a
                  href="#mission"
                  className="inline-flex items-center gap-2.5 h-[52px] px-6 rounded-[12px] border border-white/20 bg-[#0B1220]/55 hover:bg-[#111A2A]/85 hover:border-white/35 text-[#F7F9FF] text-[15px] font-medium backdrop-blur-md transition-all duration-200"
                >
                  <span>Discover Our Mission</span>
                  <ArrowDown className="w-4 h-4 text-[#35C8F5]" />
                </a>
              </div>
            </div>
          </div>

          {/* Bottom Hero Framing Bar: Scroll Indicator Left · Minimal Triad Right */}
          <div className="relative z-10 max-w-[1360px] w-full mx-auto px-5 sm:px-8 flex items-end justify-between gap-6">
            <a
              href="#mission"
              className="inline-flex items-center gap-3 text-xs tracking-[0.16em] uppercase text-[#A0AEC0] hover:text-white transition-colors"
            >
              <span className="relative w-[1.5px] h-10 bg-white/15 overflow-hidden rounded-full">
                <span className="absolute inset-x-0 top-0 h-5 bg-gradient-to-b from-transparent via-[#35C8F5] to-[#7185FF] rf-scroll-beam" />
              </span>
              <span>Scroll to explore</span>
            </a>

            <div className="hidden sm:flex flex-col items-end gap-1 text-right text-[11px] font-mono tracking-[0.16em] uppercase text-[#A0AEC0]">
              <span>Emergency Intelligence</span>
              <span>Resource Coordination</span>
              <span className="text-[#35C8F5]">AI-Powered Response</span>
            </div>
          </div>
        </section>

        {/* ===================================================================
            SECTION 2 — THE PROBLEM / CINEMATIC STORYTELLING
           =================================================================== */}
        <section
          id="mission"
          className="relative py-24 sm:py-32 bg-gradient-to-b from-[#070B14] via-[#0B1220] to-[#070B14] border-t border-white/10"
        >
          <div className="max-w-[1360px] mx-auto px-5 sm:px-8 grid lg:grid-cols-12 gap-12 lg:gap-16 items-start">
            {/* Left Editorial Storytelling Column */}
            <div className="lg:col-span-6 space-y-10">
              <ScrollReveal className="space-y-5">
                <p className="text-xs font-semibold tracking-[0.18em] uppercase text-[#FF5C70]">
                  The Reality On The Ground
                </p>
                <h2 className="font-[var(--font-display)] text-3xl sm:text-[46px] font-bold leading-[1.09] tracking-[-0.025em] text-[#F7F9FF]">
                  When disaster strikes, the challenge isn&apos;t just response.{' '}
                  <span className="text-[#A0AEC0]">It&apos;s coordination.</span>
                </h2>
                <p className="text-base sm:text-[17px] leading-[1.7] text-[#A0AEC0] max-w-[54ch]">
                  Emergency responders work relentlessly under extreme pressure. Yet critical hours are still
                  lost stitching together disconnected alerts, shifting weather risks, warehouse counts, and
                  road conditions.
                </p>
              </ScrollReveal>

              <div className="divide-y divide-white/10 border-t border-b border-white/10">
                {PROBLEM_POINTS.map((item, idx) => (
                  <ScrollReveal key={item.index} delayMs={idx * 45} className="py-5 grid sm:grid-cols-12 gap-2 sm:gap-5">
                    <div className="sm:col-span-2 font-mono text-xs font-semibold text-[#7185FF] pt-0.5 tabular-nums">
                      {item.index}
                    </div>
                    <div className="sm:col-span-10 space-y-1">
                      <h3 className="text-[16px] font-semibold text-[#F7F9FF]">{item.title}</h3>
                      <p className="text-sm leading-relaxed text-[#A0AEC0]">{item.detail}</p>
                    </div>
                  </ScrollReveal>
                ))}
              </div>
            </div>

            {/* Right Full-Height Documentary Photography Column */}
            <div className="lg:col-span-6 lg:sticky lg:top-28">
              <ScrollReveal direction="scale">
                <figure className="group relative rounded-2xl overflow-hidden border border-white/10 bg-[#111A2A] shadow-[0_24px_64px_rgba(0,0,0,0.5)]">
                  <CinematicImage
                    theme="mission"
                    hoverZoom
                    scrim="editorial"
                    className="aspect-[4/3] lg:aspect-[4/5] w-full"
                  />
                  <figcaption className="absolute inset-x-0 bottom-0 p-6 sm:p-8 flex flex-col gap-1.5">
                    <span className="text-[11px] font-mono uppercase tracking-[0.16em] text-[#35C8F5]">
                      Field Coordination Reality
                    </span>
                    <p className="text-base sm:text-lg font-medium text-[#F7F9FF] max-w-md leading-snug">
                      Every responder needs the same live picture of hazards, inventory, and open corridors.
                    </p>
                  </figcaption>
                </figure>
              </ScrollReveal>
            </div>
          </div>
        </section>

        {/* ===================================================================
            SECTION 3 — VISUAL TRANSITION
           =================================================================== */}
        <section className="py-24 sm:py-32 bg-[#070B14] border-t border-white/10">
          <div className="max-w-[1360px] mx-auto px-5 sm:px-8 space-y-12">
            <ScrollReveal className="max-w-3xl mx-auto text-center space-y-4">
              <p className="text-xs font-semibold tracking-[0.18em] uppercase text-[#35C8F5]">
                The Architectural Shift
              </p>
              <h2 className="font-[var(--font-display)] text-3xl sm:text-[48px] font-bold leading-[1.08] tracking-[-0.03em] text-[#F7F9FF]">
                From fragmented information to coordinated intelligence.
              </h2>
              <p className="text-base sm:text-[17px] text-[#A0AEC0] leading-relaxed">
                Unifying live incident intake, environmental telemetry, stock ledgers, and corridor hazards into
                a single operational network.
              </p>
            </ScrollReveal>

            <ScrollReveal delayMs={120}>
              <FragmentedToCoordinatedVisual />
            </ScrollReveal>
          </div>
        </section>

        {/* ===================================================================
            SECTION 4 — WHAT RESQFLOW AI DOES (5 VARIED EDITORIAL COMPOSITIONS)
           =================================================================== */}
        <section
          id="platform"
          className="py-24 sm:py-32 bg-[#0B1220] border-t border-white/10"
        >
          <div className="max-w-[1360px] mx-auto px-5 sm:px-8 space-y-24 sm:space-y-28">
            <ScrollReveal className="max-w-3xl space-y-4">
              <p className="text-xs font-semibold tracking-[0.18em] uppercase text-[#7185FF]">
                Platform Capabilities
              </p>
              <h2 className="font-[var(--font-display)] text-3xl sm:text-[50px] font-bold leading-[1.07] tracking-[-0.03em] text-[#F7F9FF]">
                One network.
                <br />
                Every response connected.
              </h2>
            </ScrollReveal>

            {/* 01 — Emergency Intelligence (Image Right) */}
            <div className="grid lg:grid-cols-12 gap-10 lg:gap-14 items-center">
              <ScrollReveal className="lg:col-span-5 space-y-5">
                <div className="font-mono text-xs font-semibold tracking-[0.16em] text-[#35C8F5]">
                  01 — EMERGENCY INTELLIGENCE
                </div>
                <h3 className="font-[var(--font-display)] text-2xl sm:text-[34px] font-bold leading-tight text-[#F7F9FF]">
                  Transform incident reports and evolving conditions into a structured operational picture.
                </h3>
                <p className="text-[15.5px] leading-[1.7] text-[#A0AEC0]">
                  Capture responder, agency, and public reports with coordinate validation, proximity duplicate
                  detection, severity lifecycle tracking, and formal commander verification.
                </p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#CBD5E1] pt-1">
                  <span>Spatial deduplication</span>
                  <span aria-hidden="true" className="text-white/25">·</span>
                  <span>Verification workflow</span>
                  <span aria-hidden="true" className="text-white/25">·</span>
                  <span>Live map tracking</span>
                </div>
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => onEnterApp('incidents')}
                    className="inline-flex items-center gap-2 text-sm font-semibold text-[#7185FF] hover:text-[#98A8FF] transition-colors group"
                  >
                    <span>Explore Incident Command</span>
                    <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
                  </button>
                </div>
              </ScrollReveal>
              <ScrollReveal delayMs={100} className="lg:col-span-7">
                <div className="group rounded-2xl overflow-hidden border border-white/10 bg-[#111A2A]">
                  <CinematicImage
                    theme="emergency_intelligence"
                    hoverZoom
                    scrim="subtle"
                    className="aspect-[16/10] w-full"
                  />
                </div>
              </ScrollReveal>
            </div>

            {/* 02 — Risk Intelligence (Image Left) */}
            <div className="grid lg:grid-cols-12 gap-10 lg:gap-14 items-center">
              <ScrollReveal delayMs={80} className="lg:col-span-7 order-2 lg:order-1">
                <div className="group rounded-2xl overflow-hidden border border-white/10 bg-[#111A2A]">
                  <CinematicImage
                    theme="risk_intelligence"
                    hoverZoom
                    scrim="subtle"
                    className="aspect-[16/10] w-full"
                  />
                </div>
              </ScrollReveal>
              <ScrollReveal className="lg:col-span-5 order-1 lg:order-2 space-y-5">
                <div className="font-mono text-xs font-semibold tracking-[0.16em] text-[#35C8F5]">
                  02 — RISK INTELLIGENCE
                </div>
                <h3 className="font-[var(--font-display)] text-2xl sm:text-[34px] font-bold leading-tight text-[#F7F9FF]">
                  Understand changing hazards, exposure, severity, and operational risk.
                </h3>
                <p className="text-[15.5px] leading-[1.7] text-[#A0AEC0]">
                  Combine live Open-Meteo environmental telemetry with deterministic flood, wind, heat, and
                  storm calculators—preserving immutable assessment history and transparent data completeness.
                </p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#CBD5E1] pt-1">
                  <span>Deterministic scoring</span>
                  <span aria-hidden="true" className="text-white/25">·</span>
                  <span>Live weather feeds</span>
                  <span aria-hidden="true" className="text-white/25">·</span>
                  <span>Risk change deltas</span>
                </div>
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => onEnterApp('risk')}
                    className="inline-flex items-center gap-2 text-sm font-semibold text-[#7185FF] hover:text-[#98A8FF] transition-colors group"
                  >
                    <span>Open Risk &amp; Weather Intel</span>
                    <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
                  </button>
                </div>
              </ScrollReveal>
            </div>

            {/* 03 — Resource Intelligence (Full-Width Dramatic Panoramic Feature) */}
            <ScrollReveal>
              <div className="group relative rounded-3xl overflow-hidden border border-white/12 bg-[#111A2A] min-h-[420px] sm:min-h-[480px] flex items-end">
                <div className="absolute inset-0">
                  <CinematicImage
                    theme="resource_intelligence"
                    hoverZoom
                    scrim="none"
                    className="w-full h-full"
                  />
                  <div
                    className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#070B14] via-[#070B14]/70 to-[#070B14]/25"
                    aria-hidden="true"
                  />
                </div>
                <div className="relative z-10 w-full p-7 sm:p-12 lg:p-14 grid lg:grid-cols-12 gap-8 items-end">
                  <div className="lg:col-span-7 space-y-4">
                    <div className="font-mono text-xs font-semibold tracking-[0.16em] text-[#35C8F5]">
                      03 — RESOURCE INTELLIGENCE
                    </div>
                    <h3 className="font-[var(--font-display)] text-2xl sm:text-[38px] font-bold leading-[1.1] text-[#F7F9FF]">
                      Know what resources are available, where they are located, and what communities need.
                    </h3>
                    <p className="text-[15.5px] leading-[1.7] text-[#CBD5E1] max-w-2xl">
                      Manage operational warehouses, atomic stock ledgers, batch expiry monitoring, and
                      concurrency-safe emergency reservations without negative stock or silent double allocation.
                    </p>
                  </div>
                  <div className="lg:col-span-5 flex flex-col lg:items-end gap-4">
                    <div className="flex flex-wrap lg:justify-end gap-x-4 gap-y-1 text-xs text-[#CBD5E1]">
                      <span>Atomic stock ledger</span>
                      <span aria-hidden="true" className="text-white/25">·</span>
                      <span>Expiry quarantine</span>
                      <span aria-hidden="true" className="text-white/25">·</span>
                      <span>Shortage alerts</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => onEnterApp('warehouses')}
                      className="inline-flex items-center gap-2 h-11 px-5 rounded-[10px] bg-white/10 hover:bg-white/16 border border-white/20 text-white text-sm font-semibold backdrop-blur-md transition-colors w-fit group/btn"
                    >
                      <span>Inspect Warehouses &amp; Inventory</span>
                      <ArrowRight className="w-4 h-4 transition-transform group-hover/btn:translate-x-0.5" />
                    </button>
                  </div>
                </div>
              </div>
            </ScrollReveal>

            {/* 04 — Smart Allocation (Image Right) */}
            <div className="grid lg:grid-cols-12 gap-10 lg:gap-14 items-center">
              <ScrollReveal className="lg:col-span-5 space-y-5">
                <div className="font-mono text-xs font-semibold tracking-[0.16em] text-[#35C8F5]">
                  04 — SMART ALLOCATION
                </div>
                <h3 className="font-[var(--font-display)] text-2xl sm:text-[34px] font-bold leading-tight text-[#F7F9FF]">
                  Support smarter resource allocation using urgency, availability, and demand.
                </h3>
                <p className="text-[15.5px] leading-[1.7] text-[#A0AEC0]">
                  Evaluate candidate warehouses across distance, stock freshness, operational readiness, and
                  fairness aging. Automatically split large requests across depots while surfacing exact unmet
                  shortages for human review.
                </p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#CBD5E1] pt-1">
                  <span>Multi-warehouse split</span>
                  <span aria-hidden="true" className="text-white/25">·</span>
                  <span>Fairness aging</span>
                  <span aria-hidden="true" className="text-white/25">·</span>
                  <span>Commander override</span>
                </div>
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => onEnterApp('allocations')}
                    className="inline-flex items-center gap-2 text-sm font-semibold text-[#7185FF] hover:text-[#98A8FF] transition-colors group"
                  >
                    <span>Open Allocation Engine</span>
                    <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
                  </button>
                </div>
              </ScrollReveal>
              <ScrollReveal delayMs={100} className="lg:col-span-7">
                <div className="group rounded-2xl overflow-hidden border border-white/10 bg-[#111A2A]">
                  <CinematicImage
                    theme="smart_allocation"
                    hoverZoom
                    scrim="subtle"
                    className="aspect-[16/10] w-full"
                  />
                </div>
              </ScrollReveal>
            </div>

            {/* 05 — Logistics Coordination (Image Left) */}
            <div className="grid lg:grid-cols-12 gap-10 lg:gap-14 items-center">
              <ScrollReveal delayMs={80} className="lg:col-span-7 order-2 lg:order-1">
                <div className="group rounded-2xl overflow-hidden border border-white/10 bg-[#111A2A]">
                  <CinematicImage
                    theme="logistics_coordination"
                    hoverZoom
                    scrim="subtle"
                    className="aspect-[16/10] w-full"
                  />
                </div>
              </ScrollReveal>
              <ScrollReveal className="lg:col-span-5 order-1 lg:order-2 space-y-5">
                <div className="font-mono text-xs font-semibold tracking-[0.16em] text-[#35C8F5]">
                  05 — LOGISTICS COORDINATION
                </div>
                <h3 className="font-[var(--font-display)] text-2xl sm:text-[34px] font-bold leading-tight text-[#F7F9FF]">
                  Connect resource planning to routing, dispatch, delivery, and response monitoring.
                </h3>
                <p className="text-[15.5px] leading-[1.7] text-[#A0AEC0]">
                  Audit road closures and flood hazards before vehicles depart, validate fleet capacity and
                  driver availability, enforce strict dispatch states, and reconcile delivered goods cleanly.
                </p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#CBD5E1] pt-1">
                  <span>Hazard-aware routing</span>
                  <span aria-hidden="true" className="text-white/25">·</span>
                  <span>Fleet readiness</span>
                  <span aria-hidden="true" className="text-white/25">·</span>
                  <span>Delivery reconciliation</span>
                </div>
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => onEnterApp('dispatches')}
                    className="inline-flex items-center gap-2 text-sm font-semibold text-[#7185FF] hover:text-[#98A8FF] transition-colors group"
                  >
                    <span>Open Logistics &amp; Dispatch</span>
                    <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
                  </button>
                </div>
              </ScrollReveal>
            </div>
          </div>
        </section>

        {/* ===================================================================
            SECTION 5 — MULTI-AGENT AI NETWORK
           =================================================================== */}
        <section
          id="intelligence"
          className="py-24 sm:py-32 bg-[#070B14] border-t border-white/10"
        >
          <div className="max-w-[1360px] mx-auto px-5 sm:px-8 space-y-12">
            <ScrollReveal className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
              <div className="max-w-2xl space-y-4">
                <p className="text-xs font-semibold tracking-[0.18em] uppercase text-[#7185FF]">
                  Multi-Agent AI Architecture
                </p>
                <h2 className="font-[var(--font-display)] text-3xl sm:text-[48px] font-bold leading-[1.08] tracking-[-0.03em] text-[#F7F9FF]">
                  Intelligence that works together.
                </h2>
                <p className="text-base sm:text-[17px] leading-[1.7] text-[#A0AEC0]">
                  RESQFLOW AI uses specialized intelligence workflows to analyze emergencies, environmental
                  conditions, resources, logistics, and human impact—helping produce coordinated response
                  recommendations that always remain under human review.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onEnterApp('ai-command')}
                className="inline-flex items-center gap-2 h-11 px-5 rounded-[10px] border border-[#7185FF]/45 bg-[#7185FF]/12 hover:bg-[#7185FF]/22 text-[#F7F9FF] text-sm font-semibold transition-colors whitespace-nowrap self-start lg:self-end group"
              >
                <span>Open AI Command Center</span>
                <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
              </button>
            </ScrollReveal>

            <ScrollReveal delayMs={100}>
              <MultiAgentNetworkVisual />
            </ScrollReveal>
          </div>
        </section>

        {/* ===================================================================
            SECTION 6 — IMMERSIVE CURATED IMAGE GALLERY
           =================================================================== */}
        <section className="py-24 sm:py-32 bg-[#0B1220] border-t border-white/10">
          <div className="max-w-[1360px] mx-auto px-5 sm:px-8 space-y-12">
            <ScrollReveal className="max-w-2xl space-y-3">
              <p className="text-xs font-semibold tracking-[0.18em] uppercase text-[#35C8F5]">
                Across Every Phase Of Response
              </p>
              <h2 className="font-[var(--font-display)] text-3xl sm:text-[42px] font-bold leading-[1.1] tracking-[-0.025em] text-[#F7F9FF]">
                Built for real environments, from orbital monitoring to last-mile delivery.
              </h2>
            </ScrollReveal>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-4 sm:gap-5">
              {CURATED_GALLERY_ITEMS.map((item, idx) => (
                <ScrollReveal
                  key={item.id}
                  delayMs={idx * 55}
                  className={item.colSpan}
                >
                  <figure className={`group relative rounded-2xl overflow-hidden border border-white/10 bg-[#111A2A] ${item.aspect}`}>
                    <CinematicImage
                      theme={item.theme}
                      objectPosition={item.objectPosition}
                      hoverZoom
                      scrim="editorial"
                      className="w-full h-full"
                    />
                    <figcaption className="absolute inset-x-0 bottom-0 p-5 sm:p-6 flex flex-col gap-1">
                      <span className="text-sm sm:text-base font-semibold text-[#F7F9FF]">
                        {item.title}
                      </span>
                      <span className="text-xs sm:text-[13px] text-[#CBD5E1]/90">
                        {item.subtitle}
                      </span>
                    </figcaption>
                  </figure>
                </ScrollReveal>
              ))}
            </div>
          </div>
        </section>

        {/* ===================================================================
            SECTION 7 — HUMAN-CENTERED IMPACT (FULL-WIDTH CINEMATIC)
           =================================================================== */}
        <section
          id="impact"
          className="relative min-h-[72svh] flex items-center py-24 sm:py-32 overflow-hidden border-t border-white/10"
        >
          <div className="absolute inset-0 z-0">
            <CinematicImage
              theme="impact"
              scrim="impact"
              className="w-full h-full"
            />
            <div
              className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#070B14] via-transparent to-[#070B14]/75"
              aria-hidden="true"
            />
          </div>

          <div className="relative z-10 max-w-[1360px] w-full mx-auto px-5 sm:px-8">
            <ScrollReveal className="max-w-2xl space-y-6">
              <p className="text-xs font-semibold tracking-[0.18em] uppercase text-[#35C8F5]">
                Human-Centered Purpose
              </p>
              <h2 className="font-[var(--font-display)] text-3xl sm:text-[54px] font-bold leading-[1.06] tracking-[-0.03em] text-[#F7F9FF]">
                Behind every incident
                <br />
                is a human life.
              </h2>
              <p className="text-base sm:text-[18.5px] leading-[1.7] text-[#E2E8F0]">
                Technology matters when it helps people make better decisions, coordinate resources faster,
                and reach communities when they need support most.
              </p>
              <p className="text-sm text-[#CBD5E1] leading-relaxed">
                RESQFLOW AI is engineered to clarify facts, respect responder judgment, and keep accountability
                with the human teams serving communities on the ground.
              </p>
            </ScrollReveal>
          </div>
        </section>

        {/* ===================================================================
            SECTION 8 — FINAL CINEMATIC CTA
           =================================================================== */}
        <section className="relative py-28 sm:py-36 bg-[#070B14] border-t border-white/10 overflow-hidden">
          <ClosingNetworkBackdrop />
          <div className="relative z-10 max-w-3xl mx-auto px-5 sm:px-8 text-center space-y-7">
            <ScrollReveal className="space-y-6">
              <div className="inline-flex items-center justify-center">
                <BrandMark size={46} />
              </div>
              <h2 className="font-[var(--font-display)] text-3xl sm:text-[52px] font-bold leading-[1.07] tracking-[-0.03em] text-[#F7F9FF]">
                Every minute matters.
                <br />
                Every decision should count.
              </h2>
              <p className="text-base sm:text-lg text-[#A0AEC0] max-w-xl mx-auto leading-relaxed">
                Connect intelligence. Coordinate resources. Strengthen emergency response.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-4 pt-2">
                <button
                  type="button"
                  onClick={() => onEnterApp('overview')}
                  className="inline-flex items-center gap-2.5 h-[52px] px-7 rounded-[12px] bg-[#7185FF] hover:bg-[#8294FF] text-white text-[15px] font-semibold transition-all duration-200 shadow-[0_8px_32px_rgba(113,133,255,0.36)] group"
                >
                  <span>Enter RESQFLOW AI</span>
                  <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
                </button>
                <a
                  href="#mission"
                  className="inline-flex items-center gap-2 h-[52px] px-6 rounded-[12px] border border-white/15 bg-[#111A2A]/80 hover:bg-[#19263A] text-[#F7F9FF] text-[15px] font-medium transition-colors"
                >
                  <span>Explore Our Mission</span>
                </a>
              </div>
            </ScrollReveal>
          </div>
        </section>
      </main>

      {/* =====================================================================
          SECTION 9 — PREMIUM FOOTER
         ===================================================================== */}
      <footer className="relative bg-[#070B14] pt-16 pb-12">
        {/* Subtle luminous indigo-to-cyan top hairline */}
        <div
          className="absolute top-0 inset-x-0 h-[1px] bg-gradient-to-r from-transparent via-[#7185FF]/60 to-transparent"
          aria-hidden="true"
        />

        <div className="max-w-[1360px] mx-auto px-5 sm:px-8 grid sm:grid-cols-2 lg:grid-cols-6 gap-10">
          <div className="sm:col-span-2 space-y-4">
            <div className="flex items-center gap-2.5">
              <BrandMark size={28} />
              <span className="font-[var(--font-display)] text-base font-bold text-[#F7F9FF]">
                RESQFLOW AI
              </span>
            </div>
            <p className="text-xs font-medium text-[#CBD5E1]">
              Autonomous Emergency Response &amp; Supply Chain Intelligence Network
            </p>
            <p className="text-xs leading-relaxed text-[#A0AEC0] max-w-xs">
              Predict risks. Coordinate resources. Deliver relief. Save lives.
            </p>
          </div>

          <div className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[#F7F9FF]">Platform</div>
            <div className="flex flex-col items-start gap-2.5 text-xs text-[#A0AEC0]">
              <button type="button" onClick={() => onEnterApp('overview')} className="hover:text-white transition-colors">
                Command Overview
              </button>
              <button type="button" onClick={() => onEnterApp('map')} className="hover:text-white transition-colors">
                Live Emergency Map
              </button>
              <button type="button" onClick={() => onEnterApp('incidents')} className="hover:text-white transition-colors">
                Incident Management
              </button>
              <button type="button" onClick={() => onEnterApp('warehouses')} className="hover:text-white transition-colors">
                Warehouses &amp; Inventory
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[#F7F9FF]">Intelligence</div>
            <div className="flex flex-col items-start gap-2.5 text-xs text-[#A0AEC0]">
              <button type="button" onClick={() => onEnterApp('ai-command')} className="hover:text-white transition-colors">
                AI Command Center
              </button>
              <button type="button" onClick={() => onEnterApp('risk')} className="hover:text-white transition-colors">
                Risk &amp; Weather Intel
              </button>
              <button type="button" onClick={() => onEnterApp('allocations')} className="hover:text-white transition-colors">
                Smart Allocation
              </button>
              <button type="button" onClick={() => onEnterApp('analytics')} className="hover:text-white transition-colors">
                Operational Analytics
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[#F7F9FF]">Mission</div>
            <div className="flex flex-col items-start gap-2.5 text-xs text-[#A0AEC0]">
              <a href="#mission" className="hover:text-white transition-colors">
                The Coordination Gap
              </a>
              <a href="#platform" className="hover:text-white transition-colors">
                Connected Response
              </a>
              <a href="#impact" className="hover:text-white transition-colors">
                Human-Centered Aid
              </a>
              <button type="button" onClick={() => onEnterApp('relief')} className="hover:text-white transition-colors">
                Relief Requests
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[#F7F9FF]">Technology</div>
            <div className="flex flex-col items-start gap-2.5 text-xs text-[#A0AEC0]">
              <button type="button" onClick={() => onEnterApp('dispatches')} className="hover:text-white transition-colors">
                Logistics &amp; Dispatch
              </button>
              <button type="button" onClick={() => onEnterApp('tactical-3d')} className="hover:text-white transition-colors">
                3D Tactical Twin
              </button>
              <button type="button" onClick={() => onEnterApp('workspace')} className="hover:text-white transition-colors">
                Workspace Integration
              </button>
              <button type="button" onClick={() => onEnterApp('admin')} className="hover:text-white transition-colors">
                System Health
              </button>
            </div>
          </div>
        </div>

        <div className="max-w-[1360px] mx-auto px-5 sm:px-8 mt-14 pt-6 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-[#A0AEC0]">
          <span>RESQFLOW AI · Emergency Response &amp; Supply Chain Intelligence</span>
          <span className="inline-flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5 text-[#7185FF]" />
            <span>Human-approved emergency coordination</span>
          </span>
        </div>
      </footer>
    </div>
  );
};
