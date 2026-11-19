import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export function Button({
  variant = 'default',
  icon,
  children,
  className = '',
  ...rest
}: { variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'metal'; icon?: IconName } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`btn btn-${variant} ${className}`} {...rest}>
      {icon && <Icon name={icon} size={14} />}
      {children && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ icon, label, active, size = 15, className = '', ...rest }: { icon: IconName; label: string; active?: boolean; size?: number } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`icon-btn ${active ? 'is-active' : ''} ${className}`} aria-label={label} title={label} aria-pressed={active} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
}

export function SectionHeader({ title, children, count }: { title: string; children?: ReactNode; count?: number | string }) {
  return (
    <div className="section-header">
      <span className="section-title">{title}</span>
      {count !== undefined && <span className="section-count">{count}</span>}
      <span className="flex-1" />
      {children}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && (
        <div className="empty-icon">
          <Icon name={icon} size={20} />
        </div>
      )}
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

/** A label marking where a value came from, so real and derived data are never confused. */
export function Provenance({ kind }: { kind: 'live' | 'transcript' | 'requested' | 'git' | 'cli' | 'unavailable' | 'local' }) {
  const label = {
    live: 'LIVE',
    transcript: 'TRANSCRIPT',
    requested: 'REQUESTED',
    git: 'GIT',
    cli: 'CLI',
    unavailable: 'N/A',
    local: 'LOCAL',
  }[kind];
  return <span className={`prov prov-${kind}`}>{label}</span>;
}

/** Drag handle that reports pixel deltas. */
export function Resizer({ axis, onDelta, onEnd, label }: { axis: 'x' | 'y'; onDelta: (d: number) => void; onEnd?: () => void; label: string }) {
  const start = useRef<number | null>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (start.current === null) return;
      const pos = axis === 'x' ? e.clientX : e.clientY;
      onDelta(pos - start.current);
      start.current = pos;
    };
    const up = () => {
      if (start.current === null) return;
      start.current = null;
      document.body.classList.remove('is-resizing', 'is-resizing-x', 'is-resizing-y');
      onEnd?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [axis, onDelta, onEnd]);
  return (
    <div
      className={`resizer resizer-${axis}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      tabIndex={0}
      onPointerDown={(e) => {
        start.current = axis === 'x' ? e.clientX : e.clientY;
        document.body.classList.add('is-resizing', `is-resizing-${axis}`);
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 10;
        if ((axis === 'x' && e.key === 'ArrowLeft') || (axis === 'y' && e.key === 'ArrowUp')) onDelta(-step);
        else if ((axis === 'x' && e.key === 'ArrowRight') || (axis === 'y' && e.key === 'ArrowDown')) onDelta(step);
        else return;
        e.preventDefault();
        onEnd?.();
      }}
    />
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, ariaLabel }: { tabs: { id: T; label: string; badge?: ReactNode }[]; value: T; onChange: (v: T) => void; ariaLabel: string }) {
  return (
    <div className="seg-tabs" role="tablist" aria-label={ariaLabel}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          className={`seg-tab ${value === t.id ? 'is-active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.badge}
        </button>
      ))}
    </div>
  );
}

export function KV({ k, children, mono }: { k: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="kv">
      <div className="kv-k">{k}</div>
      <div className={`kv-v ${mono ? 'mono' : ''}`}>{children}</div>
    </div>
  );
}
