import type { TriggerKind } from '../types.js';
import { TRIGGER_LABELS } from '../vocabulary.js';

interface TriggerBadgeProps {
  trigger: TriggerKind;
  replayed?: boolean | undefined;
}

const clsMap: Record<TriggerKind, string> = {
  'on-demand': 'pill-trigger-ondemand',
  scheduled: 'pill-trigger-scheduled',
  replay: 'pill-trigger-replay',
};

export function TriggerBadge({ trigger, replayed }: TriggerBadgeProps) {
  const label = replayed === true ? 'Replay' : TRIGGER_LABELS[trigger];
  const cls = replayed === true ? clsMap.replay : clsMap[trigger];
  return <span className={`pill ${cls}`}>{label}</span>;
}
