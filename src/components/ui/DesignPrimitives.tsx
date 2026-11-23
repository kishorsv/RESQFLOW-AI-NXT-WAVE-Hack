import React from 'react';
import type { LucideIcon } from 'lucide-react';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  kicker?: string;
  actions?: React.ReactNode;
}

export const PageHeader: React.FC<PageHeaderProps> = ({ title, subtitle, kicker, actions }) => (
  <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-1">
    <div className="space-y-1 min-w-0">
      {kicker && (
        <div className="text-xs font-medium tracking-wide text-[#5869E8] dark:text-[#7C8BFF]">
          {kicker}
        </div>
      )}
      <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-[var(--rf-text-primary)] leading-tight">
        {title}
      </h1>
      {subtitle && (
        <p className="text-sm text-[var(--rf-text-muted)] max-w-2xl leading-relaxed">{subtitle}</p>
      )}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2.5 shrink-0">{actions}</div>}
  </div>
);

interface MetricCardProps {
  label: string;
  value: string | number;
  context: string;
  icon: LucideIcon;
  tone?: 'brand' | 'cyan' | 'success' | 'warning' | 'danger' | 'neutral';
  onClick?: () => void;
}

const TONE_ICON_STYLES: Record<NonNullable<MetricCardProps['tone']>, string> = {
  brand: 'bg-[#5869E8]/10 text-[#5869E8] dark:bg-[#6D7CFF]/15 dark:text-[#8190FF]',
  cyan: 'bg-[#089FCB]/10 text-[#089FCB] dark:bg-[#35C8F5]/14 dark:text-[#35C8F5]',
  success: 'bg-[#15966C]/10 text-[#15966C] dark:bg-[#35D6A0]/14 dark:text-[#35D6A0]',
  warning: 'bg-[#B97716]/10 text-[#B97716] dark:bg-[#FFB547]/14 dark:text-[#FFB547]',
  danger: 'bg-[#E5465D]/10 text-[#E5465D] dark:bg-[#FF5C70]/14 dark:text-[#FF5C70]',
  neutral: 'bg-slate-500/10 text-slate-600 dark:text-slate-300',
};

export const MetricCard: React.FC<MetricCardProps> = ({
  label,
  value,
  context,
  icon: Icon,
  tone = 'brand',
  onClick,
}) => {
  const Component = onClick ? 'button' : 'div';
  return (
    <Component
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`rf-card ${
        onClick ? 'rf-card-interactive text-left cursor-pointer' : ''
      } p-5 flex flex-col justify-between gap-3 w-full`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium text-[var(--rf-text-muted)] truncate">{label}</span>
        <span
          className={`w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0 ${TONE_ICON_STYLES[tone]}`}
        >
          <Icon className="w-4 h-4" />
        </span>
      </div>
      <div>
        <div className="text-[28px] font-bold tracking-tight text-[var(--rf-text-primary)] tabular-nums leading-none">
          {value}
        </div>
        <div className="mt-2 text-xs text-[var(--rf-text-muted)] tabular-nums truncate">{context}</div>
      </div>
    </Component>
  );
};

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
}) => (
  <div className="py-10 px-6 text-center flex flex-col items-center justify-center gap-3">
    <div className="w-11 h-11 rounded-2xl bg-[var(--rf-surface-raised)] border border-[var(--rf-border-default)] flex items-center justify-center text-[var(--rf-text-muted)]">
      <Icon className="w-5 h-5" />
    </div>
    <div className="space-y-1 max-w-md">
      <div className="text-sm font-semibold text-[var(--rf-text-primary)]">{title}</div>
      <p className="text-xs text-[var(--rf-text-muted)] leading-relaxed">{description}</p>
    </div>
    {actionLabel && onAction && (
      <button type="button" onClick={onAction} className="rf-btn-secondary mt-1 text-xs min-h-[36px]">
        {actionLabel}
      </button>
    )}
  </div>
);

export const DashboardSkeleton: React.FC = () => (
  <div className="space-y-6" aria-busy="true" aria-label="Loading operational data">
    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="rf-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="rf-skeleton h-3.5 w-24" />
            <div className="rf-skeleton h-8 w-8 rounded-[10px]" />
          </div>
          <div className="rf-skeleton h-7 w-16" />
          <div className="rf-skeleton h-3 w-32" />
        </div>
      ))}
    </div>
    <div className="grid lg:grid-cols-3 gap-5">
      <div className="lg:col-span-2 rf-card p-6 h-80 flex flex-col justify-between">
        <div className="space-y-2">
          <div className="rf-skeleton h-4 w-56" />
          <div className="rf-skeleton h-3 w-80" />
        </div>
        <div className="rf-skeleton h-52 w-full" />
      </div>
      <div className="rf-card p-6 h-80 space-y-3">
        <div className="rf-skeleton h-4 w-36" />
        <div className="rf-skeleton h-14 w-full" />
        <div className="rf-skeleton h-14 w-full" />
        <div className="rf-skeleton h-14 w-full" />
      </div>
    </div>
  </div>
);
