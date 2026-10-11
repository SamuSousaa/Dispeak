import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ globalShortcut: {}, ipcMain: {} }));
vi.mock('./config', () => ({ config: { appUrl: new URL('https://dispeaker.example') } }));

const { toAccelerator } = await import('./shortcuts');

describe('toAccelerator', () => {
  it('translates chords and function keys', () => {
    expect(toAccelerator('Ctrl+Shift+M')).toBe('Control+Shift+M');
    expect(toAccelerator('Alt+F9')).toBe('Alt+F9');
    expect(toAccelerator('F24')).toBe('F24');
    expect(toAccelerator('Ctrl+ArrowUp')).toBe('Control+Up');
    expect(toAccelerator('Ctrl+Space')).toBe('Control+Space');
  });

  it('refuses keys that would stop ordinary typing everywhere', () => {
    expect(toAccelerator('M')).toBeNull();
    expect(toAccelerator('Shift+M')).toBeNull();
    expect(toAccelerator('Space')).toBeNull();
    expect(toAccelerator('Enter')).toBeNull();
  });

  it('refuses keys it does not know', () => {
    expect(toAccelerator('Ctrl+Dead')).toBeNull();
    expect(toAccelerator('Ctrl++')).toBeNull();
    expect(toAccelerator('F25')).toBeNull();
  });
});
