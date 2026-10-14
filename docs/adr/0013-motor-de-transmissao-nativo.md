# 0013 — Motor de transmissão nativo em Rust

- Status: aceita
- Data: 2026-10-14

## Contexto

A transmissão de tela é o motivo de usar o Dispeaker, e cada amigo tinha um problema diferente.
A telemetria (commit `4bffbd8`) mediu, no PC do dono (RX 7800 XT, Cyberpunk 2077 em tela cheia,
1080p60):

|                       | Captura do navegador         | Captura nativa (ffmpeg) |
| --------------------- | ---------------------------- | ----------------------- |
| Capturados            | 45–52 fps                    | não informa             |
| Compressão por quadro | 16 ms (o limite para 60 fps) | não informa             |
| Chegando ao servidor  | 40–53 fps                    | 60 fps estáveis         |

A captura nativa com ffmpeg resolve os quadros nesta máquina, mas tem limites que não dá para
corrigir por fora do ffmpeg:

- na AMD só funciona em AV1 (o H.264 da placa recusa a superfície capturada), e espectadores com
  placa antiga não decodificam AV1 no hardware;
- NVIDIA e Intel usam caminhos diferentes, nunca testados;
- ignora o RTCP do servidor: não reenvia pacote perdido, não manda quadro-chave quando pedem
  (só um por segundo) e não se adapta à rede;
- não informa nada sobre captura e compressão;
- recebe a chave SRTP pela linha de comando.

## Decisão

Um programa próprio, `dispeaker-capture` (Rust, `apps/desktop/native/capture`), substitui o
ffmpeg dentro do app de desktop. O Electron continua sendo a janela; a API, o site e o servidor
de mídia continuam em TypeScript.

1. **Captura**: Desktop Duplication (DXGI) do monitor escolhido, a mesma que deu 60 fps.
2. **Conversão** BGRA → NV12 na placa, com o `ID3D11VideoProcessor`.
3. **Compressão H.264** pelo Media Foundation: o mesmo caminho em AMD, NVIDIA e Intel, e o
   compressor em software do Windows quando não houver um na placa. H.264 é o que qualquer
   espectador decodifica.
4. **Envio**: RTP/SRTP para o mesmo ingest do servidor de mídia, que passa a anunciar NACK e PLI.
   O motor guarda os últimos pacotes para reenviar, gera quadro-chave quando o servidor pede e
   ajusta o bitrate pela perda informada nos relatórios do servidor.
5. **Telemetria**: o motor escreve seus números (capturados, tempo de compressão, enviados) em
   JSON na saída padrão; o app os repassa à página, que os manda como os do navegador.
6. A chave SRTP chega pela entrada padrão.

Se o motor não existir ou não iniciar, o app volta para o ffmpeg e, depois, para a captura do
navegador, como hoje.

## Consequências

- O instalador ganha um executável pequeno; o ffmpeg fica até o motor provar que o substitui.
- O build do app passa a precisar de Rust (toolchain `x86_64-pc-windows-gnu`, sem Visual Studio).
- Injetar código no jogo (como o "game capture" do OBS) está fora: anticheats como o Vanguard
  podem banir quem transmite.
