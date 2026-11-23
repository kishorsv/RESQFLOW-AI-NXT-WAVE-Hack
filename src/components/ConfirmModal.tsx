import React, { useEffect } from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  open,
  title,
  description,
  confirmLabel = 'Confirm Action',
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, loading, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#080D18]/75 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      onClick={() => !loading && onCancel()}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-[var(--rf-border-strong)] bg-[var(--rf-surface-elevated)] shadow-[var(--rf-shadow-elevated)] overflow-hidden rf-animate-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--rf-border-default)]">
          <div className="flex items-center gap-2.5">
            <AlertTriangle
              className={`w-5 h-5 ${
                danger ? 'text-[#E5465D] dark:text-[#FF5C70]' : 'text-[#B97716] dark:text-[#FFB547]'
              }`}
            />
            <h3 id="confirm-modal-title" className="text-base font-semibold text-[var(--rf-text-primary)]">
              {title}
            </h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="w-8 h-8 inline-flex items-center justify-center rounded-lg text-[var(--rf-text-muted)] hover:text-[var(--rf-text-primary)] hover:bg-[var(--rf-surface-hover)] transition-colors"
            aria-label="Close confirmation dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-6 py-5 text-sm text-[var(--rf-text-secondary)] leading-relaxed whitespace-pre-line">
          {description}
        </div>
        <div className="flex items-center justify-end gap-2.5 px-6 py-4 bg-[var(--rf-bg-secondary)] border-t border-[var(--rf-border-default)]">
          <button
            type="button"
            disabled={loading}
            onClick={onCancel}
            className="rf-btn-secondary min-h-[38px] text-[13.5px]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={onConfirm}
            className={`${danger ? 'rf-btn-danger' : 'rf-btn-primary'} min-h-[38px] text-[13.5px]`}
          >
            {loading ? 'Executing...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
