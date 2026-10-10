export const KEYBIND_ACTIONS = ['mute', 'deafen', 'fullscreen', 'share', 'leave'] as const;
export type KeybindAction = (typeof KEYBIND_ACTIONS)[number];

/** A binding is a string such as `M` or `Ctrl+Shift+M`; `null` means "no shortcut". */
export type Keybinds = Record<KeybindAction, string | null>;

export const DEFAULT_KEYBINDS: Keybinds = {
  mute: 'M',
  deafen: 'D',
  fullscreen: 'F',
  share: null,
  leave: null,
};

export const KEYBIND_LABELS: Record<KeybindAction, string> = {
  mute: 'Mutar / desmutar',
  deafen: 'Ensurdecer',
  fullscreen: 'Assistir transmissão em tela cheia',
  share: 'Iniciar / parar minha transmissão',
  leave: 'Desligar a chamada',
};

const IGNORED_KEYS = new Set([
  'Control',
  'Shift',
  'Alt',
  'AltGraph',
  'Meta',
  'OS',
  'Dead',
  'Process',
  'Unidentified',
  'CapsLock',
]);

type KeyEventLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>;

/** The binding a key press stands for, or `null` when it is only a modifier. */
export function bindingFromEvent(event: KeyEventLike): string | null {
  if (event.metaKey || IGNORED_KEYS.has(event.key)) return null;
  const key =
    event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const parts = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', key];
  return parts.filter(Boolean).join('+');
}

/** Bindings that also produce text are ignored while the user is typing in a field. */
export function firesWhileTyping(binding: string): boolean {
  return (
    binding.startsWith('Ctrl+') || binding.startsWith('Alt+') || /(^|\+)F\d{1,2}$/.test(binding)
  );
}

/** Assigns a binding to an action, taking it away from any other action that had it. */
export function assignKeybind(
  keybinds: Keybinds,
  action: KeybindAction,
  binding: string | null,
): Keybinds {
  const next = { ...keybinds };
  if (binding !== null) {
    for (const other of KEYBIND_ACTIONS) {
      if (next[other] === binding) next[other] = null;
    }
  }
  next[action] = binding;
  return next;
}

export function actionForBinding(keybinds: Keybinds, binding: string): KeybindAction | null {
  return KEYBIND_ACTIONS.find((action) => keybinds[action] === binding) ?? null;
}
