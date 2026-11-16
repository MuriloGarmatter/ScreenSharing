# telao-ps5.exe: protocolo com o Telão

O `telao-ps5.exe` é o receptor de Remote Play do Telão. Ele fala com o PS5 usando a
biblioteca do [chiaki-ng](https://github.com/streetpea/chiaki-ng) (AGPL-3.0) e entrega
ao Telão o vídeo **ainda comprimido** (H.264) e o som **já decodificado** (PCM). O Telão
decodifica o vídeo na placa de vídeo (WebCodecs) e transmite como uma tela comum.

Este programa (pasta `native/ps5`) é distribuído sob a **AGPL-3.0** (ver `LICENSE`).
O Telão conversa com ele só por linha de comando e pipes, como faz com o `telao-audio.exe`.

## Modos

Todos os argumentos são `--nome valor`. Chaves são hexadecimais minúsculas.
Os modos de uma resposta só imprimem **uma linha JSON** no stdout e saem
(código 0 em sucesso, 1 em falha; em falha, a linha é `{"ok":false,"error":"mensagem em português"}`).
Logs de diagnóstico vão para o **stderr** (o Telão grava num arquivo de log).

### `discover [--timeout 2000]`
Procura consoles na rede local (broadcast UDP) e responde:
```json
{"ok":true,"consoles":[{"host":"192.168.0.10","name":"PS5-123","id":"<host-id>","state":"ready","ps5":true}]}
```
`state`: `"ready"` (ligado) ou `"standby"` (modo de repouso). Pode usar `--host IP` para
perguntar a um endereço específico em vez de broadcast.

### `register --host IP --account-id BASE64 --pin 12345678 [--broadcast]`
Pareia com o console (Configurações → Sistema → Reprodução Remota → Vincular dispositivo).
`--account-id` é o ID da conta PSN em base64 (8 bytes), o mesmo que o chiaki-ng usa.
```json
{"ok":true,"name":"PS5-123","id":"<host-id>","mac":"<server mac hex>","registKey":"<hex>","rpKey":"<hex>"}
```

### `wake --host IP --regist-key HEX`
Acorda o console do modo de repouso. `{"ok":true}`.

### `stream --host IP --regist-key HEX --rp-key HEX [--resolution 720p|1080p] [--fps 30|60] [--bitrate KBPS]`
Conecta e fica transmitindo **até o stdin fechar** (o Telão fecha o stdin para parar)
ou a sessão cair. Padrões: `1080p`, `60`, bitrate do preset do chiaki-ng. Codec: sempre H.264.

O stdout vira binário, em pacotes:

```
[tipo u8][id u32 LE][tamanho u32 LE][dados: tamanho bytes]
```

| tipo | id | dados |
|---|---|---|
| 1 | 0 | Som: PCM 16 bits com sinal, little-endian, estéreo intercalado, 48 kHz |
| 2 | 0 | Evento: JSON em UTF-8 (ver abaixo) |
| 3 | nº do quadro | Vídeo: um quadro (access unit) H.264 em Annex-B (com start codes `00 00 00 01`). O primeiro quadro enviado é sempre um keyframe com SPS/PPS. |

Os tipos 1 e 2 são idênticos aos do `telao-audio.exe`.

Eventos (tipo 2):
- `{"event":"connecting"}`
- `{"event":"connected","width":1920,"height":1080,"fps":60,"codec":"h264"}`
- `{"event":"warning","message":"..."}`
- `{"event":"quit","reason":"<código do chiaki>","message":"mensagem em português","detail":"texto do PS5"}`, e em seguida o programa sai.
  `detail` só vem quando o próprio console mandou um motivo ao desconectar (em inglês); serve para diagnóstico.
  `STREAM_CONNECTION_REMOTE_DISCONNECTED` no meio da transmissão quase sempre é o usuário pareado entrando no console pelo controle:
  o PS5 só aceita cada usuário num lugar (controle ou Reprodução Remota).
- `{"event":"error","fatal":true,"message":"..."}`

Comandos pelo stdin (uma linha de texto cada):
- `idr`: o decodificador do Telão perdeu a sequência; pede um keyframe novo ao console.

Código de saída do `stream`: 0 se parou porque o stdin fechou, diferente de 0 se a sessão caiu.
