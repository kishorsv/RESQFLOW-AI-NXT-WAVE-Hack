import React, { useState } from 'react';
import { Shield } from 'lucide-react';
import { HOMEPAGE_IMAGE_CATALOG, type HomepageImageTheme } from './imageCatalog';

interface CinematicImageProps {
  theme: HomepageImageTheme;
  altOverride?: string;
  objectPosition?: string;
  priority?: boolean;
  hoverZoom?: boolean;
  kenBurns?: boolean;
  scrim?: 'none' | 'subtle' | 'editorial' | 'hero' | 'impact';
  className?: string;
  imgClassName?: string;
}

const SCRIM_CLASSES: Record<NonNullable<CinematicImageProps['scrim']>, string> = {
  none: '',
  subtle: 'bg-gradient-to-t from-[#070B14]/75 via-[#070B14]/20 to-transparent',
  editorial: 'bg-gradient-to-t from-[#070B14]/85 via-[#070B14]/28 to-[#070B14]/15',
  hero: 'bg-gradient-to-b from-[#070B14]/80 via-[#070B14]/56 to-[#070B14]',
  impact: 'bg-gradient-to-r from-[#070B14]/92 via-[#070B14]/74 to-[#070B14]/55',
};

/**
 * Reusable automatic section-themed photography component with smooth fade-in,
 * measured dark contrast scrims, lazy loading below the fold, and zero-broken-image fallback.
 */
export const CinematicImage: React.FC<CinematicImageProps> = ({
  theme,
  altOverride,
  objectPosition,
  priority = false,
  hoverZoom = false,
  kenBurns = false,
  scrim = 'subtle',
  className = '',
  imgClassName = '',
}) => {
  const asset = HOMEPAGE_IMAGE_CATALOG[theme];
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <div
      className={`relative overflow-hidden bg-[#0B1220] select-none ${className}`}
    >
      {/* Atmospheric loading shimmer */}
      {!loaded && !failed && (
        <div
          className="absolute inset-0 bg-gradient-to-br from-[#0B1220] via-[#111A2A] to-[#070B14] rf-skeleton"
          aria-hidden="true"
        />
      )}

      {/* Zero-Broken-Image Policy Fallback */}
      {failed ? (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center bg-gradient-to-br from-[#0B1220] via-[#111A2A] to-[#070B14]"
          role="img"
          aria-label={altOverride || asset.alt}
        >
          <div className="w-11 h-11 rounded-2xl border border-[#7185FF]/30 bg-[#7185FF]/10 flex items-center justify-center text-[#7185FF]">
            <Shield className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-[#F7F9FF]">{asset.caption}</div>
            <div className="text-[11px] text-[#A0AEC0]">{asset.category}</div>
          </div>
        </div>
      ) : (
        <img
          src={asset.src}
          alt={altOverride || asset.alt}
          referrerPolicy="no-referrer"
          loading={priority ? 'eager' : 'lazy'}
          decoding={priority ? 'sync' : 'async'}
          fetchPriority={priority ? 'high' : 'auto'}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          style={{ objectPosition: objectPosition || asset.objectPosition }}
          className={`w-full h-full object-cover transition-[opacity,transform] duration-700 ease-out ${
            loaded ? 'opacity-100' : 'opacity-0'
          } ${kenBurns ? 'rf-hero-kenburns' : ''} ${
            hoverZoom ? 'group-hover:scale-[1.04] transition-transform duration-700' : ''
          } ${imgClassName}`}
        />
      )}

      {/* Measured contrast scrim overlay */}
      {scrim !== 'none' && (
        <div className={`pointer-events-none absolute inset-0 ${SCRIM_CLASSES[scrim]}`} aria-hidden="true" />
      )}
    </div>
  );
};
