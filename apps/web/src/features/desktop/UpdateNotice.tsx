import { useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { desktop } from './desktop';

/**
 * Desktop app only: says that a new version is downloaded and offers to restart into it. It
 * installs by itself the next time the app closes, so ignoring this is fine.
 */
export function UpdateNotice() {
  const [version, setVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    // An app installed before updates existed has neither call: it simply never shows this.
    void desktop.getUpdate?.().then(
      (update) => {
        if (!cancelled && update.version) setVersion(update.version);
      },
      () => undefined,
    );
    const stop = desktop.onUpdateReady?.((ready) => {
      setVersion(ready);
      setDismissed(false);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  if (!desktop || !version || dismissed) return null;
  return (
    <aside
      role="status"
      data-testid="update-notice"
      className="fixed right-3 bottom-3 z-40 flex max-w-xs flex-col gap-2 border border-accent bg-surface p-3"
    >
      <p className="label text-fg">VERSÃO {version} PRONTA</p>
      <p className="text-xs text-muted">
        Ela entra sozinha quando você fechar o app. Reiniciar agora derruba a chamada por alguns
        segundos.
      </p>
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => void desktop?.installUpdate()}>
          REINICIAR AGORA
        </Button>
        <Button onClick={() => setDismissed(true)}>DEPOIS</Button>
      </div>
    </aside>
  );
}
