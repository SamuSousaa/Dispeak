import {
  BANNER_SIZE,
  BIO_MAX_LENGTH,
  CUSTOM_STATUS_MAX_LENGTH,
  type Guild,
  type Self,
} from '@frequencia/shared';
import { useState, type FormEvent, type ReactNode } from 'react';
import { pictureUrl } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Field, FormError } from '../../components/Dialog';
import { PictureField } from '../../components/PictureField';
import { cx } from '../../lib/cx';
import { describeError } from '../../lib/http';
import { coverImage } from '../../lib/square-image';
import { profileApi } from '../auth/profile-api';
import { guildApi } from '../guilds/guild-api';
import { ProfileCard } from '../profile/ProfileCard';

/** Colours for the profile card; any other can be picked by hand. */
const ACCENTS = ['#ff5a4d', '#ff9f1c', '#ffd60a', '#7ae582', '#2ec4b6', '#4cc9f0', '#b388ff'];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-line">
      <h3 className="label border-b border-line bg-surface-2 px-4 py-2 text-fg">{title}</h3>
      <div className="flex flex-col gap-4 p-4">{children}</div>
    </section>
  );
}

/** Everything a person shows about themselves, edited next to a preview of the result. */
export function ProfileTab({ user, guild }: { user: Self; guild?: Guild }) {
  const member = guild?.members.find((entry) => entry.user.id === user.id);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [customStatus, setCustomStatus] = useState(user.customStatus ?? '');
  const [bio, setBio] = useState(user.bio ?? '');
  const [nickname, setNickname] = useState(member?.nickname ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await action();
      setSaved(true);
    } catch (failure) {
      setError(describeError(failure).toUpperCase());
    } finally {
      setBusy(false);
    }
  };

  const changed =
    displayName.trim() !== user.displayName ||
    customStatus.trim() !== (user.customStatus ?? '') ||
    bio.trim() !== (user.bio ?? '') ||
    nickname.trim() !== (member?.nickname ?? '');

  const save = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await profileApi.update({
        displayName: displayName.trim(),
        customStatus: customStatus.trim() || null,
        bio: bio.trim() || null,
      });
      if (guild && nickname.trim() !== (member?.nickname ?? '')) {
        await guildApi.updateMember(guild.id, user.id, { nickname: nickname.trim() || null });
      }
    });
  };

  return (
    <>
      <Section title="COMO OS OUTROS VEEM VOCÊ">
        <div className="border border-line-strong bg-surface-2">
          <ProfileCard
            user={{
              ...user,
              displayName: displayName.trim() || user.displayName,
              customStatus: customStatus.trim() || null,
              bio: bio.trim() || null,
            }}
            name={nickname.trim() || displayName.trim() || user.displayName}
            presence={user.presence === 'invisible' ? 'offline' : user.status}
          />
        </div>
      </Section>

      <Section title="IMAGENS">
        <PictureField
          subject="sua foto de perfil"
          name={user.displayName}
          picture={user.avatar}
          testId="avatar-input"
          onChange={profileApi.setAvatar}
          onRemove={profileApi.clearAvatar}
        />
        <PictureField
          subject="o banner do perfil"
          name={user.displayName}
          picture={user.banner}
          testId="banner-input"
          prepare={(file) => coverImage(file, BANNER_SIZE.width, BANNER_SIZE.height)}
          preview={
            <span
              className="block h-12 w-32 shrink-0 border border-line-strong bg-surface-2"
              style={{
                backgroundColor: user.accentColor ?? undefined,
                backgroundImage: user.banner ? `url(${pictureUrl(user.banner)})` : undefined,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
            />
          }
          hint="O banner é a faixa no topo do seu cartão. A imagem é cortada no centro, em formato largo."
          onChange={profileApi.setBanner}
          onRemove={profileApi.clearBanner}
        />
        <fieldset className="flex flex-col gap-1.5">
          <legend className="label mb-1.5 text-muted">COR DO CARTÃO</legend>
          <div className="flex flex-wrap items-center gap-1.5">
            {ACCENTS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`Cor ${color}`}
                aria-pressed={user.accentColor === color}
                disabled={busy}
                onClick={() => void run(() => profileApi.update({ accentColor: color }))}
                style={{ backgroundColor: color }}
                className={cx(
                  'pressable h-7 w-7 border-2',
                  user.accentColor === color
                    ? 'border-fg'
                    : 'border-transparent hover:border-muted',
                )}
              />
            ))}
            <label className="label flex h-7 cursor-pointer items-center gap-1.5 border border-line-strong px-2 text-muted transition-colors hover:border-accent hover:text-fg">
              OUTRA
              <input
                type="color"
                aria-label="Escolher outra cor"
                className="h-4 w-6 cursor-pointer border-0 bg-transparent p-0"
                value={user.accentColor ?? '#171717'}
                disabled={busy}
                onBlur={(event) => {
                  const color = event.target.value;
                  if (color !== user.accentColor) {
                    void run(() => profileApi.update({ accentColor: color }));
                  }
                }}
                onChange={() => undefined}
              />
            </label>
            {user.accentColor && (
              <Button
                disabled={busy}
                onClick={() => void run(() => profileApi.update({ accentColor: null }))}
              >
                SEM COR
              </Button>
            )}
          </div>
          <p className="text-xs text-muted">Aparece no topo do cartão quando não há banner.</p>
        </fieldset>
      </Section>

      <form onSubmit={save}>
        <Section title="SOBRE VOCÊ">
          <Field label="NOME DE EXIBIÇÃO">
            <input
              className="field"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={32}
              required
            />
          </Field>
          {guild && (
            <Field
              label={`APELIDO EM ${guild.name}`}
              hint="Só vale neste servidor. Vazio usa o nome de exibição."
            >
              <input
                className="field"
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                maxLength={32}
              />
            </Field>
          )}
          <Field
            label={`STATUS — ${customStatus.length}/${CUSTOM_STATUS_MAX_LENGTH}`}
            hint="Uma linha sobre o que você está fazendo. Pode ter emoji."
          >
            <input
              className="field"
              value={customStatus}
              onChange={(event) => setCustomStatus(event.target.value)}
              maxLength={CUSTOM_STATUS_MAX_LENGTH}
              placeholder="🎮 jogando até tarde"
            />
          </Field>
          <Field label={`SOBRE MIM — ${bio.length}/${BIO_MAX_LENGTH}`}>
            <textarea
              className="field"
              style={{ fontFamily: 'var(--font-body)' }}
              rows={4}
              value={bio}
              onChange={(event) => setBio(event.target.value)}
              maxLength={BIO_MAX_LENGTH}
            />
          </Field>
          <FormError message={error} />
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" disabled={busy || !changed}>
              SALVAR PERFIL
            </Button>
            {saved && !changed && (
              <span role="status" className="label text-muted">
                SALVO
              </span>
            )}
          </div>
        </Section>
      </form>
    </>
  );
}

/** Changing the password signs every session out, this one included. */
export function PasswordForm({ onChanged }: { onChanged: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await profileApi.changePassword(current, next);
      onChanged();
    } catch (failure) {
      setError(
        describeError(failure, 'Não foi possível trocar a senha.')
          .replace('Usuário ou senha incorretos.', 'A senha atual não confere.')
          .toUpperCase(),
      );
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
      <Field label="SENHA ATUAL">
        <input
          className="field"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          required
        />
      </Field>
      <Field label="NOVA SENHA" hint="Pelo menos 8 caracteres.">
        <input
          className="field"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          minLength={8}
          maxLength={128}
          required
        />
      </Field>
      <FormError message={error} />
      <p className="text-xs text-muted">
        Ao trocar, você sai da conta em todos os aparelhos e entra de novo com a senha nova.
      </p>
      <div>
        <Button type="submit" disabled={busy || !current || next.length < 8}>
          TROCAR SENHA
        </Button>
      </div>
    </form>
  );
}
