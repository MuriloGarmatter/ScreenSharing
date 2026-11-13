# telao-ps5

Receptor de Reprodução Remota do PS5 usado pelo Telão. Fala com o console pela
libchiaki do [chiaki-ng](https://github.com/streetpea/chiaki-ng) (v1.10.1) e entrega ao
Telão o vídeo H.264 ainda comprimido e o som em PCM. O contrato com o Telão está em
[`PROTOCOL.md`](PROTOCOL.md).

Licença: **AGPL-3.0** (ver [`LICENSE`](LICENSE) e [`NOTICE`](NOTICE)).

## Como é compilado

O GitHub Actions (`.github/workflows/build-ps5-helper.yml`) compila no Windows com
MSYS2/MinGW64 a cada mudança nesta pasta e publica o artefato `telao-ps5-win-x64`, com a
pasta `telao-ps5/` (o `telao-ps5.exe`, as DLLs, `LICENSE` e `NOTICE`).

## Compilar no seu computador (Windows + MSYS2)

1. Instale o [MSYS2](https://www.msys2.org/) e abra o terminal **MSYS2 MINGW64**.
2. Instale as dependências:
   ```sh
   pacman -S --needed git mingw-w64-x86_64-{gcc,cmake,ninja,pkgconf,openssl,opus,json-c,miniupnpc,libevent,protobuf,python,python-protobuf}
   ```
3. Na pasta do Telão, baixe o chiaki-ng v1.10.1 com os submódulos que a libchiaki usa:
   ```sh
   cd native/ps5
   git clone --branch v1.10.1 https://github.com/streetpea/chiaki-ng.git
   git -C chiaki-ng submodule update --init --depth 1 \
     third-party/nanopb third-party/jerasure third-party/gf-complete third-party/curl
   ```
   (a pasta `chiaki-ng/` é ignorada pelo git do Telão)
4. Compile:
   ```sh
   cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5
   cmake --build build --target telao-ps5
   ```
5. Monte a pasta com as DLLs:
   ```sh
   mkdir -p dist/telao-ps5
   cp build/telao-ps5.exe LICENSE NOTICE dist/telao-ps5/
   ldd dist/telao-ps5/telao-ps5.exe | grep -i /mingw64/ | awk '{print $3}' | xargs -I{} cp {} dist/telao-ps5/
   ```

Teste rápido: `dist/telao-ps5/telao-ps5.exe discover` deve imprimir uma linha JSON como
`{"ok":true,"consoles":[...]}`. Use `--verbose` para ver todos os logs da libchiaki no stderr.

## Também compila no Linux

Serve para conferir o código sem Windows (por exemplo num contêiner `ubuntu:24.04`):

```sh
apt install build-essential cmake ninja-build pkg-config libssl-dev libjson-c-dev \
  libminiupnpc-dev libevent-dev libopus-dev protobuf-compiler python3-protobuf
cmake -S native/ps5 -B build-ps5 -G Ninja -DCHIAKI_NG_DIR=/caminho/do/chiaki-ng
cmake --build build-ps5 --target telao-ps5
```
