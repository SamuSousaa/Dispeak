import type { PickerBridge, PickerSource } from './protocol';

declare global {
  interface Window {
    picker: PickerBridge;
  }
}

const TABS: Array<{ kind: PickerSource['kind']; label: string }> = [
  { kind: 'game', label: 'JOGOS' },
  { kind: 'window', label: 'JANELAS' },
  { kind: 'screen', label: 'TELAS' },
];

const tabs = document.querySelector<HTMLElement>('#tabs');
const grid = document.querySelector<HTMLElement>('#grid');
const cancel = document.querySelector<HTMLButtonElement>('#cancel');

function render(sources: PickerSource[], active: PickerSource['kind']): void {
  if (!tabs || !grid) return;
  tabs.replaceChildren(
    // The games tab only when there is a game.
    ...TABS.filter(({ kind }) => kind !== 'game' || sources.some((s) => s.kind === 'game')).map(
      ({ kind, label }) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tab';
        button.setAttribute('aria-pressed', String(kind === active));
        const count = sources.filter((source) => source.kind === kind).length;
        button.textContent = `${label} (${count})`;
        button.addEventListener('click', () => render(sources, kind));
        return button;
      },
    ),
  );

  const shown = sources.filter((source) => source.kind === active);
  if (shown.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'NADA PARA TRANSMITIR AQUI';
    grid.replaceChildren(empty);
    return;
  }
  grid.replaceChildren(
    ...shown.map((source) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'source';
      button.dataset.sourceId = source.id;
      const image = document.createElement('img');
      image.src = source.thumbnail;
      image.alt = '';
      const name = document.createElement('span');
      name.textContent = source.name;
      button.append(image, name);
      button.addEventListener('click', () => window.picker.choose(source.id));
      return button;
    }),
  );
}

cancel?.addEventListener('click', () => window.picker.choose(null));
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.picker.choose(null);
});

void window.picker.sources().then((sources) => {
  // A game first, then windows; whole screens come last.
  const first = (['game', 'window'] as const).find((kind) =>
    sources.some((source) => source.kind === kind),
  );
  render(sources, first ?? 'screen');
});
