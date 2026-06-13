import type { Severity, RunStatus, Surface, FixStatus } from '../types.js';
import { SEVERITY_LABELS, SEVERITY_TECH, SURFACE_LABELS, RUN_STATUS_LABELS, FIX_STATUS_LABELS } from '../vocabulary.js';

// Severity chip: shows operator label + technical sub-label
interface SeverityChipProps {
  severity: Severity;
  showTech?: boolean;
}

export function SeverityChip({ severity, showTech = true }: SeverityChipProps) {
  const label = SEVERITY_LABELS[severity];
  const tech = SEVERITY_TECH[severity];
  return (
    <span className={`pill pill-${severity}`} title={tech}>
      {label}
      {showTech && (
        <span style={{ fontWeight: 400, opacity: 0.75, fontSize: '10px', marginLeft: '3px' }}>
          {tech}
        </span>
      )}
    </span>
  );
}

// Run status chip
interface RunStatusChipProps {
  status: RunStatus | 'unknown';
}

export function RunStatusChip({ status }: RunStatusChipProps) {
  if (status === 'unknown') {
    return <span className="pill pill-unknown">Unknown</span>;
  }
  const label = RUN_STATUS_LABELS[status];
  const cls = status === 'success' ? 'pill-success' : status === 'partial' ? 'pill-partial' : 'pill-failed';
  return <span className={`pill ${cls}`}>{label}</span>;
}

// Surface chip: In the code / On the live test site
interface SurfaceChipProps {
  kind: Surface;
}

export function SurfaceChip({ kind }: SurfaceChipProps) {
  return (
    <span className={`pill pill-${kind}`}>
      {SURFACE_LABELS[kind]}
    </span>
  );
}

// Fix status chip (6-state pipeline)
interface FixStatusChipProps {
  status: FixStatus;
}

export function FixStatusChip({ status }: FixStatusChipProps) {
  const label = FIX_STATUS_LABELS[status];
  const clsMap: Record<FixStatus, string> = {
    requested: 'pill-fix-requested',
    'in-progress': 'pill-fix-inprogress',
    'awaiting-review': 'pill-fix-awaiting',
    'merged-awaiting-verification': 'pill',
    'verified-fixed': 'pill-fix-verified',
    reopened: 'pill-fix-reopened',
  };
  return <span className={`pill ${clsMap[status]}`}>{label}</span>;
}

// Severity dot indicator
interface SevDotProps {
  severity: Severity;
}

export function SevDot({ severity }: SevDotProps) {
  return <span className={`sev-dot sev-dot-${severity}`} aria-hidden="true" />;
}
