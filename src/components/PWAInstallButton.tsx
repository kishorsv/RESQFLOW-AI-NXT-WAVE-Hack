import { useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export function PWAInstallButton() {
  const { canInstall, isIOS, promptInstall } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (!canInstall) return null;

  const handleClick = async () => {
    if (isIOS) {
      setShowIOSGuide(true);
    } else {
      await promptInstall();
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className="rf-btn-primary min-h-[36px] h-9 px-3 text-xs shrink-0"
        title="Install RESQFLOW AI as a standalone offline-ready app"
      >
        <Download className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Install App</span>
      </button>

      {showIOSGuide && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#080D18]/75 backdrop-blur-xs p-4"
          onClick={() => setShowIOSGuide(false)}
        >
          <div
            className="bg-[var(--rf-surface-elevated)] border border-[var(--rf-border-strong)] rounded-2xl max-w-sm w-full p-6 shadow-[var(--rf-shadow-elevated)] space-y-3.5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-[var(--rf-text-primary)]">Install RESQFLOW AI</h3>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="text-[var(--rf-text-muted)] hover:text-[var(--rf-text-primary)]"
                aria-label="Close install guide"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-[var(--rf-text-secondary)] leading-relaxed">
              Add RESQFLOW AI to your Home Screen for full-screen command access and persistent offline queueing:
            </p>
            <ol className="space-y-2 text-xs text-[var(--rf-text-primary)] list-decimal list-inside">
              <li className="flex items-center gap-1.5">
                Tap the <Share className="w-3.5 h-3.5 inline text-[#5869E8] dark:text-[#35C8F5]" />{' '}
                <strong>Share</strong> button in Safari.
              </li>
              <li>
                Scroll down and tap <strong>Add to Home Screen</strong>.
              </li>
              <li>
                Tap <strong>Add</strong> in the top-right corner.
              </li>
            </ol>
          </div>
        </div>
      )}
    </>
  );
}
