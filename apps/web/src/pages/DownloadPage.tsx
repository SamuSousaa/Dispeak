import { APP_NAME } from '@frequencia/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { desktop } from '../features/desktop/desktop';
import { fetchDesktopRelease, INSTALLER_URL } from '../features/desktop/release';

const DATE = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long' });

const STEPS = [
  'Abra o arquivo baixado.',
  'Se o Windows mostrar “O Windows protegeu o computador”, clique em “Mais informações” e depois em “Executar assim mesmo”. O aviso aparece porque o instalador não tem certificado pago.',
  'O app abre sozinho. Entre com a mesma conta do navegador.',
];

const REASONS: Array<[string, string]> = [
  ['TRANSMISSÃO DE JOGO', 'Mais quadros por segundo com o jogo em tela cheia por cima.'],
  ['ATALHOS GLOBAIS', 'Mutar e ensurdecer sem sair do jogo.'],
  ['MESMA CONTA', 'É o Dispeaker do navegador, numa janela própria.'],
  ['SEMPRE ATUAL', 'Baixa as versões novas sozinho.'],
];

/** Public page with the installer of the newest desktop app. */
export function DownloadPage() {
  const { data: release } = useQuery({
    queryKey: ['desktop-release'],
    queryFn: fetchDesktopRelease,
    staleTime: 60_000,
  });

  return (
    <main className="grid-bg flex min-h-dvh items-center justify-center p-4">
      <section className="w-full max-w-lg border border-line bg-surface">
        <header className="border-b border-line px-4 py-5">
          <p className="label text-muted">APP PARA WINDOWS</p>
          <h1 className="display mt-1 text-2xl text-fg">{APP_NAME}</h1>
        </header>

        <div className="flex flex-col gap-3 border-b border-line p-4">
          <a
            href={INSTALLER_URL}
            download
            data-testid="download-installer"
            className="label-lg pressable flex h-11 items-center justify-center gap-1 border border-accent bg-accent text-on-accent transition-colors hover:bg-transparent hover:text-accent"
          >
            <span aria-hidden="true">[</span>
            <span>BAIXAR PARA WINDOWS</span>
            <span aria-hidden="true">]</span>
          </a>
          <p className="label text-muted" data-testid="download-version">
            {release
              ? `VERSÃO ${release.version}${release.releasedAt ? ` · ${DATE.format(release.releasedAt).toUpperCase()}` : ''} · WINDOWS 10 E 11, 64 BITS`
              : 'WINDOWS 10 E 11, 64 BITS'}
          </p>
          {desktop && release && desktop.version === release.version && (
            <p className="text-sm text-fg">Você já está usando esta versão.</p>
          )}
        </div>

        <dl className="grid gap-px border-b border-line bg-line sm:grid-cols-2">
          {REASONS.map(([title, text]) => (
            <div key={title} className="bg-surface p-4">
              <dt className="label text-fg">{title}</dt>
              <dd className="mt-1 text-sm text-muted">{text}</dd>
            </div>
          ))}
        </dl>

        <div className="flex flex-col gap-3 p-4">
          <p className="label text-muted">COMO INSTALAR</p>
          <ol className="flex flex-col gap-2">
            {STEPS.map((step, index) => (
              <li key={step} className="flex gap-3 text-sm text-fg">
                <span className="label shrink-0 text-muted">
                  {String(index + 1).padStart(2, '0')}.
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <Link
            to="/app"
            className="label self-start text-fg underline underline-offset-4 transition-colors hover:text-accent"
          >
            USAR NO NAVEGADOR
          </Link>
        </div>
      </section>
    </main>
  );
}
