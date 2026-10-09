import type { Guild, Invite } from '@frequencia/shared';
import { useState } from 'react';
import { Button } from '../../../components/Button';
import { Dialog, Field, FormError } from '../../../components/Dialog';
import { describeError } from '../../../lib/http';
import { guildApi, inviteLink } from '../guild-api';

const EXPIRY_OPTIONS = [
  { label: '30 MINUTOS', seconds: 30 * 60 },
  { label: '1 DIA', seconds: 24 * 60 * 60 },
  { label: '7 DIAS', seconds: 7 * 24 * 60 * 60 },
  { label: 'NUNCA', seconds: 0 },
];
const USES_OPTIONS = [
  { label: 'SEM LIMITE', uses: 0 },
  { label: '1 USO', uses: 1 },
  { label: '5 USOS', uses: 5 },
  { label: '25 USOS', uses: 25 },
];

/** Generates an invite link with an optional expiry and use limit. */
export function InviteDialog({ guild, onClose }: { guild: Guild; onClose: () => void }) {
  const [expiry, setExpiry] = useState(7 * 24 * 60 * 60);
  const [uses, setUses] = useState(0);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setInvite(
        await guildApi.createInvite(guild.id, {
          expiresInSeconds: expiry || null,
          maxUses: uses || null,
        }),
      );
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(inviteLink(invite.code));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Dialog title="Convidar pessoas" eyebrow={guild.name} onClose={onClose}>
      <div className="flex flex-col gap-4 p-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="EXPIRA EM">
            <select
              className="field"
              value={expiry}
              onChange={(event) => setExpiry(Number(event.target.value))}
            >
              {EXPIRY_OPTIONS.map((option) => (
                <option key={option.seconds} value={option.seconds}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="LIMITE DE USOS">
            <select
              className="field"
              value={uses}
              onChange={(event) => setUses(Number(event.target.value))}
            >
              {USES_OPTIONS.map((option) => (
                <option key={option.uses} value={option.uses}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <FormError message={error} />
        <Button variant={invite ? 'default' : 'primary'} onClick={generate} disabled={busy}>
          {invite ? 'GERAR OUTRO' : 'GERAR CONVITE'}
        </Button>
        {invite && (
          <div className="flex flex-col gap-2 border-t border-line pt-4">
            <span className="label text-muted">LINK DO CONVITE</span>
            <div className="flex gap-2">
              <input
                className="field"
                readOnly
                value={inviteLink(invite.code)}
                aria-label="Link do convite"
                data-testid="invite-link"
                onFocus={(event) => event.target.select()}
              />
              <Button variant="primary" onClick={copy}>
                {copied ? 'COPIADO' : 'COPIAR'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
