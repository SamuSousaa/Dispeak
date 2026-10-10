import { describe, expect, it } from 'vitest';
import {
  actionForBinding,
  assignKeybind,
  bindingFromEvent,
  DEFAULT_KEYBINDS,
  firesWhileTyping,
} from './keybinds';

const press = (
  key: string,
  modifiers: Partial<Record<'ctrl' | 'shift' | 'alt' | 'meta', true>> = {},
) =>
  bindingFromEvent({
    key,
    ctrlKey: Boolean(modifiers.ctrl),
    shiftKey: Boolean(modifiers.shift),
    altKey: Boolean(modifiers.alt),
    metaKey: Boolean(modifiers.meta),
  });

describe('keybinds', () => {
  it('names a key press, with modifiers in a fixed order', () => {
    expect(press('m')).toBe('M');
    expect(press('M', { shift: true, ctrl: true })).toBe('Ctrl+Shift+M');
    expect(press('F9', { alt: true })).toBe('Alt+F9');
    expect(press(' ')).toBe('Space');
  });

  it('ignores modifier-only presses and the meta key', () => {
    expect(press('Shift', { shift: true })).toBeNull();
    expect(press('Control', { ctrl: true })).toBeNull();
    expect(press('m', { meta: true })).toBeNull();
  });

  it('only lets non-text bindings fire while typing', () => {
    expect(firesWhileTyping('M')).toBe(false);
    expect(firesWhileTyping('Shift+M')).toBe(false);
    expect(firesWhileTyping('Ctrl+Shift+M')).toBe(true);
    expect(firesWhileTyping('F9')).toBe(true);
    expect(firesWhileTyping('F')).toBe(false);
  });

  it('moves a binding instead of sharing it between two actions', () => {
    const next = assignKeybind(DEFAULT_KEYBINDS, 'leave', 'M');
    expect(next.leave).toBe('M');
    expect(next.mute).toBeNull();
    expect(actionForBinding(next, 'M')).toBe('leave');
    expect(DEFAULT_KEYBINDS.mute).toBe('M');
  });

  it('clears a binding', () => {
    const next = assignKeybind(DEFAULT_KEYBINDS, 'deafen', null);
    expect(next.deafen).toBeNull();
    expect(actionForBinding(next, 'D')).toBeNull();
  });
});
