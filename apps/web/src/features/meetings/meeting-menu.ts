import type { MeetingState } from '@frequencia/shared';
import type { MouseEvent } from 'react';
import { contextMenu, openContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { attempt } from '../../components/Toast';
import { volumeMenuEntries } from '../voice/components/VolumeControl';
import { muteForEveryone, removeParticipant, useMeetingStore } from './meeting-store';

type Point = { x: number; y: number };

/**
 * What one person may do about another in a meeting. Anyone: that person's volume, for
 * themselves. The host, about anyone but themselves: their microphone for everyone, and
 * taking them out. Nobody has a say over the host.
 */
function entries(meeting: MeetingState, targetId: string, point: Point): MenuEntry[] {
  const target = meeting.participants.find((p) => p.id === targetId);
  const self = meeting.participants.find((p) => p.id === meeting.selfId);
  if (!target || target.id === meeting.selfId) return [];
  const list: MenuEntry[] = target.inCall ? volumeMenuEntries(target.id, target.name) : [];
  if (self?.host && !target.host) {
    if (list.length > 0) list.push({ type: 'separator' });
    list.push(
      {
        label: target.mutedByHost ? 'Devolver o microfone' : 'Mutar para todos',
        hint: target.mutedByHost ? 'MUTADO' : undefined,
        onSelect: () => void muteForEveryone(target.id, !target.mutedByHost),
      },
      {
        label: 'Remover da reunião',
        danger: true,
        onSelect: () =>
          openContextMenu(point, `REMOVER ${target.name}?`, [
            {
              label: 'Sim, remover',
              danger: true,
              onSelect: () => attempt(() => removeParticipant(target.id)),
            },
            { label: 'Cancelar', onSelect: () => undefined },
          ]),
      },
    );
  }
  return list;
}

/** Opens a person's menu at a point, if there is anything in it. */
export function openPersonMenu(targetId: string, point: Point): void {
  const { meeting } = useMeetingStore.getState();
  const target = meeting?.participants.find((p) => p.id === targetId);
  if (!meeting || !target) return;
  const list = entries(meeting, targetId, point);
  if (list.length > 0) openContextMenu(point, target.name, list);
}

/** Right click and long press on a person (a tile, a name in the list). */
export function personMenu(targetId: string) {
  const { meeting } = useMeetingStore.getState();
  const target = meeting?.participants.find((p) => p.id === targetId);
  if (!meeting || !target || targetId === meeting.selfId) return undefined;
  let last: Point = { x: 0, y: 0 };
  const handlers = contextMenu(target.name, () => {
    const current = useMeetingStore.getState().meeting;
    return current ? entries(current, targetId, last) : [];
  });
  return {
    ...handlers,
    onContextMenu: (event: MouseEvent) => {
      last = { x: event.clientX, y: event.clientY };
      handlers.onContextMenu(event);
    },
  };
}
