import { useState } from 'react';
import { create } from 'zustand';
import { Button } from './Button';
import { Dialog } from './Dialog';

interface LinkState {
  open: { title: string; explanation: string; link: string } | null;
}

const useLinkStore = create<LinkState>(() => ({ open: null }));

/** Shows a link for the user to copy and pass along, with a line saying what it is for. */
export function showLink(title: string, explanation: string, link: string): void {
  useLinkStore.setState({ open: { title, explanation, link } });
}

/** Mount once, near the root. */
export function LinkDialogHost() {
  const open = useLinkStore((state) => state.open);
  const [copied, setCopied] = useState(false);
  if (!open) return null;
  const close = () => {
    setCopied(false);
    useLinkStore.setState({ open: null });
  };
  return (
    <Dialog title={open.title} eyebrow="LINK" onClose={close}>
      <div className="flex flex-col gap-3 p-4" data-testid="link-dialog">
        <p className="text-sm text-muted">{open.explanation}</p>
        <input
          className="field"
          readOnly
          value={open.link}
          aria-label="Link"
          onFocus={(event) => event.target.select()}
        />
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            onClick={() => {
              void navigator.clipboard?.writeText(open.link).then(() => setCopied(true));
            }}
          >
            COPIAR LINK
          </Button>
          {copied && (
            <span role="status" className="label text-muted">
              COPIADO
            </span>
          )}
        </div>
      </div>
    </Dialog>
  );
}
