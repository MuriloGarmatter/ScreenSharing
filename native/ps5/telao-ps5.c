// telao-ps5: receptor de Reprodução Remota do PS5 para o Telão.
//
// Usa a biblioteca do chiaki-ng (libchiaki, AGPL-3.0) para falar com o console e
// entrega ao Telão o vídeo ainda comprimido (H.264, Annex-B) e o som já decodificado
// (PCM 16 bits, estéreo, 48 kHz). O contrato completo está em PROTOCOL.md.
//
// Modos:
//   discover [--timeout MS] [--host IP]
//   register --host IP --account-id BASE64 --pin 12345678 [--broadcast]
//   wake     --host IP --regist-key HEX
//   stream   --host IP --regist-key HEX --rp-key HEX [--resolution 720p|1080p]
//            [--fps 30|60] [--bitrate KBPS]
// Em qualquer modo, --verbose liga todos os logs da libchiaki no stderr.
//
// Saída do "stream" (stdout), pacotes binários: [tipo u8][id u32 LE][tamanho u32 LE][dados]
//   tipo 1 = som PCM, tipo 2 = evento JSON, tipo 3 = um quadro H.264 (id = nº do quadro)
//
// Este arquivo é distribuído sob a AGPL-3.0 (ver LICENSE nesta pasta).

#include <chiaki/common.h>
#include <chiaki/log.h>
#include <chiaki/thread.h>
#include <chiaki/time.h>
#include <chiaki/base64.h>
#include <chiaki/discovery.h>
#include <chiaki/regist.h>
#include <chiaki/session.h>
#include <chiaki/opusdecoder.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdarg.h>
#include <ctype.h>
#include <errno.h>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#else
#include <unistd.h>
#include <signal.h>
#include <time.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <net/if.h>
#include <ifaddrs.h>
#endif

#if !CHIAKI_LIB_ENABLE_OPUS
#error "O telao-ps5 precisa da libchiaki com Opus (CHIAKI_LIB_ENABLE_OPUS=ON)"
#endif

#define PKT_AUDIO 1
#define PKT_EVENT 2
#define PKT_VIDEO 3

// Enquanto espera um keyframe, pede outro ao console com esta frequência
// (o pedido ou o próprio keyframe podem se perder na rede).
#define IDR_RETRY_MS 1000

// ---------------- Utilidades ----------------

static void sleep_ms(unsigned ms)
{
#ifdef _WIN32
	Sleep(ms);
#else
	struct timespec ts;
	ts.tv_sec = ms / 1000;
	ts.tv_nsec = (long)(ms % 1000) * 1000000L;
	while(nanosleep(&ts, &ts) != 0 && errno == EINTR) {}
#endif
}

// Texto dinâmico simples, para montar JSON.
typedef struct
{
	char *buf;
	size_t len;
	size_t cap;
} Str;

static void str_reserve(Str *s, size_t extra)
{
	if(s->len + extra + 1 <= s->cap)
		return;
	size_t cap = s->cap ? s->cap : 256;
	while(cap < s->len + extra + 1)
		cap *= 2;
	char *nb = realloc(s->buf, cap);
	if(!nb)
	{
		fprintf(stderr, "[telao-ps5] sem memória\n");
		exit(1);
	}
	s->buf = nb;
	s->cap = cap;
}

static void str_add(Str *s, const char *text)
{
	size_t n = strlen(text);
	str_reserve(s, n);
	memcpy(s->buf + s->len, text, n + 1);
	s->len += n;
}

static void str_addf(Str *s, const char *fmt, ...)
{
	va_list ap;
	va_start(ap, fmt);
	char tmp[512];
	int n = vsnprintf(tmp, sizeof(tmp), fmt, ap);
	va_end(ap);
	if(n < 0)
		return;
	if((size_t)n < sizeof(tmp))
	{
		str_add(s, tmp);
		return;
	}
	str_reserve(s, (size_t)n);
	va_start(ap, fmt);
	vsnprintf(s->buf + s->len, (size_t)n + 1, fmt, ap);
	va_end(ap);
	s->len += (size_t)n;
}

// Acrescenta "texto" como string JSON (com aspas e escapes).
static void str_add_json(Str *s, const char *text)
{
	str_add(s, "\"");
	if(text)
	{
		for(const unsigned char *p = (const unsigned char *)text; *p; p++)
		{
			switch(*p)
			{
				case '"': str_add(s, "\\\""); break;
				case '\\': str_add(s, "\\\\"); break;
				case '\n': str_add(s, "\\n"); break;
				case '\r': str_add(s, "\\r"); break;
				case '\t': str_add(s, "\\t"); break;
				default:
					if(*p < 0x20)
						str_addf(s, "\\u%04x", (unsigned)*p);
					else
					{
						char c[2] = { (char)*p, 0 };
						str_add(s, c);
					}
					break;
			}
		}
	}
	str_add(s, "\"");
}

static void str_free(Str *s)
{
	free(s->buf);
	s->buf = NULL;
	s->len = s->cap = 0;
}

static int hex_val(char c)
{
	if(c >= '0' && c <= '9') return c - '0';
	if(c >= 'a' && c <= 'f') return c - 'a' + 10;
	if(c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}

// Decodifica hexadecimal. Falha se tiver caractere inválido, tamanho ímpar
// ou mais bytes do que cabem em "out".
static bool hex_decode(const char *hex, uint8_t *out, size_t out_max, size_t *out_len)
{
	size_t n = strlen(hex);
	if(n % 2 != 0 || n / 2 > out_max)
		return false;
	for(size_t i = 0; i < n / 2; i++)
	{
		int hi = hex_val(hex[2 * i]);
		int lo = hex_val(hex[2 * i + 1]);
		if(hi < 0 || lo < 0)
			return false;
		out[i] = (uint8_t)((hi << 4) | lo);
	}
	*out_len = n / 2;
	return true;
}

static void hex_encode(const uint8_t *in, size_t len, char *out, bool upper)
{
	const char *digits = upper ? "0123456789ABCDEF" : "0123456789abcdef";
	for(size_t i = 0; i < len; i++)
	{
		out[2 * i] = digits[in[i] >> 4];
		out[2 * i + 1] = digits[in[i] & 0xf];
	}
	out[2 * len] = '\0';
}

// ---------------- Log (stderr) ----------------

static ChiakiLog g_log;
static ChiakiMutex g_log_mutex;

// O que o log da libchiaki contou de útil para explicar uma falha ao usuário.
// A libchiaki não expõe esses detalhes pela API, então são lidos das mensagens.
static volatile uint32_t g_app_reason; // "Reported Application Reason: 0x..."
static volatile bool g_regist_search_refused;
static volatile bool g_regist_no_response;

static void log_cb(ChiakiLogLevel level, const char *msg, void *user)
{
	(void)user;
	const char *tag = "Reported Application Reason: ";
	const char *p = strstr(msg, tag);
	if(p)
		g_app_reason = (uint32_t)strtoul(p + strlen(tag), NULL, 16);
	if(strstr(msg, "refused the registration search"))
		g_regist_search_refused = true;
	if(strstr(msg, "timed out waiting for search response") || strstr(msg, "eventually failed to connect"))
		g_regist_no_response = true;

	chiaki_mutex_lock(&g_log_mutex);
	fprintf(stderr, "[telao-ps5] [%c] %s\n", chiaki_log_level_char(level), msg);
	fflush(stderr);
	chiaki_mutex_unlock(&g_log_mutex);
}

// ---------------- Saída ----------------

static ChiakiMutex g_out_mutex;
static volatile bool g_out_broken; // o Telão fechou o stdout

static bool out_write(const void *data, size_t size)
{
	if(!size)
		return true;
	return fwrite(data, 1, size, stdout) == size;
}

// Escreve um pacote inteiro (cabeçalho + duas partes de dados) de uma vez só,
// protegido pelo mutex, e esvazia o buffer. A segunda parte pode ser vazia.
static void out_packet2(uint8_t type, uint32_t id, const void *a, size_t a_size, const void *b, size_t b_size)
{
	uint32_t size = (uint32_t)(a_size + b_size);
	uint8_t header[9];
	header[0] = type;
	for(int i = 0; i < 4; i++)
	{
		header[1 + i] = (uint8_t)(id >> (8 * i));
		header[5 + i] = (uint8_t)(size >> (8 * i));
	}
	chiaki_mutex_lock(&g_out_mutex);
	if(!g_out_broken)
	{
		bool ok = out_write(header, sizeof(header)) && out_write(a, a_size) && out_write(b, b_size);
		if(fflush(stdout) != 0)
			ok = false;
		if(!ok)
			g_out_broken = true;
	}
	chiaki_mutex_unlock(&g_out_mutex);
}

static void out_packet(uint8_t type, uint32_t id, const void *data, size_t size)
{
	out_packet2(type, id, data, size, NULL, 0);
}

static void emit_event_str(Str *json)
{
	out_packet(PKT_EVENT, 0, json->buf, json->len);
}

static void emit_simple_event(const char *name)
{
	Str s = { 0 };
	str_add(&s, "{\"event\":");
	str_add_json(&s, name);
	str_add(&s, "}");
	emit_event_str(&s);
	str_free(&s);
}

static void emit_message_event(const char *name, const char *message, bool fatal)
{
	Str s = { 0 };
	str_add(&s, "{\"event\":");
	str_add_json(&s, name);
	if(fatal)
		str_add(&s, ",\"fatal\":true");
	str_add(&s, ",\"message\":");
	str_add_json(&s, message);
	str_add(&s, "}");
	emit_event_str(&s);
	str_free(&s);
}

// Resposta de uma linha dos modos discover/register/wake.
static int reply_line(Str *json, int code)
{
	str_add(json, "\n");
	fwrite(json->buf, 1, json->len, stdout);
	fflush(stdout);
	str_free(json);
	return code;
}

static int reply_error(const char *message)
{
	Str s = { 0 };
	str_add(&s, "{\"ok\":false,\"error\":");
	str_add_json(&s, message);
	str_add(&s, "}");
	return reply_line(&s, 1);
}

// ---------------- Argumentos ----------------

typedef struct
{
	const char *host;
	const char *timeout;
	const char *account_id;
	const char *pin;
	const char *regist_key;
	const char *rp_key;
	const char *resolution;
	const char *fps;
	const char *bitrate;
	bool broadcast;
	bool verbose;
} Args;

// Lê "--nome valor" e as opções sem valor (--broadcast, --verbose).
// Em caso de erro devolve a mensagem (em português).
static const char *parse_args(int argc, char **argv, Args *args, char *err_buf, size_t err_size)
{
	memset(args, 0, sizeof(*args));
	for(int i = 2; i < argc; i++)
	{
		const char *name = argv[i];
		if(strcmp(name, "--verbose") == 0) { args->verbose = true; continue; }
		if(strcmp(name, "--broadcast") == 0) { args->broadcast = true; continue; }
		const char **slot = NULL;
		if(strcmp(name, "--host") == 0) slot = &args->host;
		else if(strcmp(name, "--timeout") == 0) slot = &args->timeout;
		else if(strcmp(name, "--account-id") == 0) slot = &args->account_id;
		else if(strcmp(name, "--pin") == 0) slot = &args->pin;
		else if(strcmp(name, "--regist-key") == 0) slot = &args->regist_key;
		else if(strcmp(name, "--rp-key") == 0) slot = &args->rp_key;
		else if(strcmp(name, "--resolution") == 0) slot = &args->resolution;
		else if(strcmp(name, "--fps") == 0) slot = &args->fps;
		else if(strcmp(name, "--bitrate") == 0) slot = &args->bitrate;
		if(!slot)
		{
			snprintf(err_buf, err_size, "Opção desconhecida: %s", name);
			return err_buf;
		}
		if(i + 1 >= argc)
		{
			snprintf(err_buf, err_size, "Falta o valor da opção %s", name);
			return err_buf;
		}
		*slot = argv[++i];
	}
	return NULL;
}

static bool parse_uint(const char *text, unsigned long *out)
{
	if(!text || !*text)
		return false;
	for(const char *p = text; *p; p++)
		if(!isdigit((unsigned char)*p))
			return false;
	errno = 0;
	*out = strtoul(text, NULL, 10);
	return errno == 0;
}

// A regist key chega como hexadecimal dos bytes que o console mandou no
// pareamento (texto ASCII, ex.: "1a2b3c4d"), sem os zeros de preenchimento.
static bool parse_regist_key(const char *hex, char out[CHIAKI_SESSION_AUTH_SIZE])
{
	memset(out, 0, CHIAKI_SESSION_AUTH_SIZE);
	size_t len = 0;
	return hex && hex_decode(hex, (uint8_t *)out, CHIAKI_SESSION_AUTH_SIZE, &len) && len > 0;
}

// ---------------- discover ----------------

#define DISCOVER_HOSTS_MAX 32

typedef struct
{
	char *host;
	char *name;
	char *id;
	ChiakiDiscoveryHostState state;
	bool ps5;
} FoundConsole;

typedef struct
{
	ChiakiMutex mutex;
	FoundConsole consoles[DISCOVER_HOSTS_MAX];
	size_t count;
} DiscoverCtx;

static char *dup_or_empty(const char *s)
{
	char *r = strdup(s ? s : "");
	if(!r)
		exit(1);
	return r;
}

static void discover_cb(ChiakiDiscoveryHost *host, void *user)
{
	DiscoverCtx *ctx = user;
	// As strings de "host" só valem durante este callback: copia tudo.
	const char *key = host->host_id ? host->host_id : host->host_addr;
	if(!key)
		return;
	chiaki_mutex_lock(&ctx->mutex);
	FoundConsole *c = NULL;
	for(size_t i = 0; i < ctx->count; i++)
	{
		const char *other = ctx->consoles[i].id[0] ? ctx->consoles[i].id : ctx->consoles[i].host;
		if(strcmp(other, key) == 0)
		{
			c = &ctx->consoles[i];
			free(c->host);
			free(c->name);
			free(c->id);
			break;
		}
	}
	if(!c && ctx->count < DISCOVER_HOSTS_MAX)
		c = &ctx->consoles[ctx->count++];
	if(c)
	{
		c->host = dup_or_empty(host->host_addr);
		c->name = dup_or_empty(host->host_name);
		c->id = dup_or_empty(host->host_id);
		c->state = host->state;
		c->ps5 = chiaki_discovery_host_is_ps5(host);
		CHIAKI_LOGI(&g_log, "Console encontrado: %s (%s) em %s, %s", c->name, c->id, c->host,
				chiaki_discovery_host_state_string(c->state));
	}
	chiaki_mutex_unlock(&ctx->mutex);
}

// Endereços de broadcast de cada placa de rede (além de 255.255.255.255).
// No Windows o 255.255.255.255 só sai por uma das placas; por isso o chiaki-ng
// também manda para o broadcast de cada rede local, e aqui fazemos o mesmo.
static size_t list_broadcast_addrs(uint32_t *out, size_t max)
{
	size_t count = 0;
#ifdef _WIN32
	ULONG size = 0;
	if(GetAdaptersInfo(NULL, &size) != ERROR_BUFFER_OVERFLOW || !size)
		return 0;
	IP_ADAPTER_INFO *info = malloc(size);
	if(!info)
		return 0;
	if(GetAdaptersInfo(info, &size) == NO_ERROR)
	{
		for(IP_ADAPTER_INFO *a = info; a; a = a->Next)
		{
			if(a->Type != IF_TYPE_IEEE80211 && a->Type != MIB_IF_TYPE_ETHERNET)
				continue;
			for(IP_ADDR_STRING *s = &a->IpAddressList; s; s = s->Next)
			{
				if(!s->IpAddress.String[0] || strcmp(s->IpAddress.String, "0.0.0.0") == 0)
					continue;
				struct in_addr addr, mask;
				if(inet_pton(AF_INET, s->IpAddress.String, &addr) != 1 || inet_pton(AF_INET, s->IpMask.String, &mask) != 1)
					continue;
				uint32_t bcast = addr.s_addr | ~mask.s_addr;
				bool dup = false;
				for(size_t i = 0; i < count; i++)
					dup = dup || out[i] == bcast;
				if(!dup && count < max)
					out[count++] = bcast;
			}
		}
	}
	free(info);
#else
	struct ifaddrs *addrs;
	if(getifaddrs(&addrs) != 0)
		return 0;
	for(struct ifaddrs *a = addrs; a; a = a->ifa_next)
	{
		if(!a->ifa_addr || a->ifa_addr->sa_family != AF_INET)
			continue;
		if((a->ifa_flags & (IFF_UP | IFF_LOOPBACK | IFF_BROADCAST)) != (IFF_UP | IFF_BROADCAST) || !a->ifa_broadaddr)
			continue;
		uint32_t bcast = ((struct sockaddr_in *)a->ifa_broadaddr)->sin_addr.s_addr;
		bool dup = false;
		for(size_t i = 0; i < count; i++)
			dup = dup || out[i] == bcast;
		if(!dup && count < max)
			out[count++] = bcast;
	}
	freeifaddrs(addrs);
#endif
	return count;
}

// Resolve um endereço IPv4/IPv6 (ou nome) para mandar a busca.
static bool resolve_host(const char *host, struct sockaddr_storage *out, size_t *out_len)
{
	struct addrinfo hints, *res = NULL;
	memset(&hints, 0, sizeof(hints));
	hints.ai_socktype = SOCK_DGRAM;
	hints.ai_family = strchr(host, ':') ? AF_INET6 : AF_INET;
	if(getaddrinfo(host, NULL, &hints, &res) != 0 || !res)
		return false;
	bool ok = false;
	for(struct addrinfo *ai = res; ai; ai = ai->ai_next)
	{
		if((ai->ai_family == AF_INET || ai->ai_family == AF_INET6) && ai->ai_addrlen <= sizeof(*out))
		{
			memset(out, 0, sizeof(*out));
			memcpy(out, ai->ai_addr, ai->ai_addrlen);
			*out_len = ai->ai_addrlen;
			ok = true;
			break;
		}
	}
	freeaddrinfo(res);
	return ok;
}

static void set_port(struct sockaddr_storage *addr, uint16_t port)
{
	if(addr->ss_family == AF_INET6)
		((struct sockaddr_in6 *)addr)->sin6_port = htons(port);
	else
		((struct sockaddr_in *)addr)->sin_port = htons(port);
}

static void discover_send(ChiakiDiscovery *discovery, struct sockaddr_storage *addr, size_t addr_len)
{
	ChiakiDiscoveryPacket packet;
	memset(&packet, 0, sizeof(packet));
	packet.cmd = CHIAKI_DISCOVERY_CMD_SRCH;

	// PS5 primeiro; PS4 também responde, e aparece com "ps5":false.
	packet.protocol_version = CHIAKI_DISCOVERY_PROTOCOL_VERSION_PS5;
	set_port(addr, CHIAKI_DISCOVERY_PORT_PS5);
	chiaki_discovery_send(discovery, &packet, (struct sockaddr *)addr, addr_len);

	packet.protocol_version = CHIAKI_DISCOVERY_PROTOCOL_VERSION_PS4;
	set_port(addr, CHIAKI_DISCOVERY_PORT_PS4);
	chiaki_discovery_send(discovery, &packet, (struct sockaddr *)addr, addr_len);
}

static int cmd_discover(Args *args)
{
	unsigned long timeout_ms = 2000;
	if(args->timeout && !parse_uint(args->timeout, &timeout_ms))
		return reply_error("Valor inválido para --timeout (use milissegundos).");
	if(timeout_ms < 200)
		timeout_ms = 200;
	if(timeout_ms > 60000)
		timeout_ms = 60000;

	// Para onde mandar a busca: o --host, ou broadcast.
	struct sockaddr_storage targets[17];
	size_t target_lens[17];
	size_t targets_count = 0;
	if(args->host)
	{
		if(!resolve_host(args->host, &targets[0], &target_lens[0]))
			return reply_error("Endereço do console inválido.");
		targets_count = 1;
	}
	else
	{
		struct sockaddr_in *all = (struct sockaddr_in *)&targets[0];
		memset(&targets[0], 0, sizeof(targets[0]));
		all->sin_family = AF_INET;
		all->sin_addr.s_addr = htonl(INADDR_BROADCAST);
		target_lens[0] = sizeof(struct sockaddr_in);
		targets_count = 1;

		uint32_t bcasts[16];
		size_t n = list_broadcast_addrs(bcasts, 16);
		for(size_t i = 0; i < n; i++)
		{
			struct sockaddr_in *a = (struct sockaddr_in *)&targets[targets_count];
			memset(&targets[targets_count], 0, sizeof(targets[0]));
			a->sin_family = AF_INET;
			a->sin_addr.s_addr = bcasts[i];
			target_lens[targets_count] = sizeof(struct sockaddr_in);
			targets_count++;
		}
	}

	DiscoverCtx ctx;
	memset(&ctx, 0, sizeof(ctx));
	chiaki_mutex_init(&ctx.mutex, false);

	ChiakiDiscovery discovery;
	ChiakiErrorCode err = chiaki_discovery_init(&discovery, &g_log, (sa_family_t)targets[0].ss_family);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		chiaki_mutex_fini(&ctx.mutex);
		return reply_error("Não foi possível abrir a rede para procurar consoles.");
	}

	ChiakiDiscoveryThread thread;
	err = chiaki_discovery_thread_start(&thread, &discovery, discover_cb, &ctx);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		chiaki_discovery_fini(&discovery);
		chiaki_mutex_fini(&ctx.mutex);
		return reply_error("Não foi possível iniciar a busca de consoles.");
	}

	// Manda a busca algumas vezes (UDP pode perder pacotes) até acabar o tempo.
	// Com --host, para assim que o console responder.
	uint64_t start = chiaki_time_now_monotonic_ms();
	uint64_t next_send = start;
	while(true)
	{
		uint64_t now = chiaki_time_now_monotonic_ms();
		if(now - start >= timeout_ms)
			break;
		if(args->host)
		{
			chiaki_mutex_lock(&ctx.mutex);
			bool found = ctx.count > 0;
			chiaki_mutex_unlock(&ctx.mutex);
			if(found)
				break;
		}
		if(now >= next_send)
		{
			for(size_t i = 0; i < targets_count; i++)
				discover_send(&discovery, &targets[i], target_lens[i]);
			next_send = now + 500;
		}
		sleep_ms(50);
	}

	chiaki_discovery_thread_stop(&thread);
	chiaki_discovery_fini(&discovery);

	Str s = { 0 };
	str_add(&s, "{\"ok\":true,\"consoles\":[");
	for(size_t i = 0; i < ctx.count; i++)
	{
		FoundConsole *c = &ctx.consoles[i];
		if(i)
			str_add(&s, ",");
		str_add(&s, "{\"host\":");
		str_add_json(&s, c->host);
		str_add(&s, ",\"name\":");
		str_add_json(&s, c->name);
		str_add(&s, ",\"id\":");
		str_add_json(&s, c->id);
		// Estado desconhecido é tratado como repouso: o Telão vai oferecer acordar.
		str_add(&s, ",\"state\":");
		str_add_json(&s, c->state == CHIAKI_DISCOVERY_HOST_STATE_READY ? "ready" : "standby");
		str_add(&s, c->ps5 ? ",\"ps5\":true}" : ",\"ps5\":false}");
		free(c->host);
		free(c->name);
		free(c->id);
	}
	str_add(&s, "]}");
	chiaki_mutex_fini(&ctx.mutex);
	return reply_line(&s, 0);
}

// ---------------- register ----------------

typedef struct
{
	ChiakiMutex mutex;
	ChiakiCond cond;
	bool done;
	bool success;
	ChiakiRegisteredHost host;
} RegistCtx;

static void regist_cb(ChiakiRegistEvent *event, void *user)
{
	RegistCtx *ctx = user;
	chiaki_mutex_lock(&ctx->mutex);
	if(event->type == CHIAKI_REGIST_EVENT_TYPE_FINISHED_SUCCESS && event->registered_host)
	{
		ctx->host = *event->registered_host; // só vale durante o callback
		ctx->success = true;
	}
	ctx->done = true;
	chiaki_cond_signal(&ctx->cond);
	chiaki_mutex_unlock(&ctx->mutex);
}

static bool regist_done_pred(void *user)
{
	return ((RegistCtx *)user)->done;
}

static int cmd_register(Args *args)
{
	if(!args->host)
		return reply_error("Informe o endereço do console (--host).");
	if(!args->account_id)
		return reply_error("Informe o ID da conta PSN (--account-id).");
	if(!args->pin)
		return reply_error("Informe o PIN de 8 dígitos mostrado no console (--pin).");

	unsigned long pin = 0;
	if(strlen(args->pin) != 8 || !parse_uint(args->pin, &pin))
		return reply_error("O PIN precisa ter 8 dígitos.");

	uint8_t account_id[CHIAKI_PSN_ACCOUNT_ID_SIZE + 8];
	size_t account_id_len = sizeof(account_id);
	if(chiaki_base64_decode(args->account_id, strlen(args->account_id), account_id, &account_id_len) != CHIAKI_ERR_SUCCESS
			|| account_id_len != CHIAKI_PSN_ACCOUNT_ID_SIZE)
		return reply_error("ID da conta PSN inválido: precisa ser base64 de 8 bytes.");

	ChiakiRegistInfo info;
	memset(&info, 0, sizeof(info));
	info.target = CHIAKI_TARGET_PS5_1;
	info.host = args->host;
	info.broadcast = args->broadcast;
	info.psn_online_id = NULL;
	memcpy(info.psn_account_id, account_id, CHIAKI_PSN_ACCOUNT_ID_SIZE);
	info.pin = (uint32_t)pin;
	info.console_pin = 0;
	info.holepunch_info = NULL;
	info.rudp = NULL;

	RegistCtx ctx;
	memset(&ctx, 0, sizeof(ctx));
	chiaki_mutex_init(&ctx.mutex, false);
	chiaki_cond_init(&ctx.cond);

	ChiakiRegist regist;
	ChiakiErrorCode err = chiaki_regist_start(&regist, &g_log, &info, regist_cb, &ctx);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		chiaki_cond_fini(&ctx.cond);
		chiaki_mutex_fini(&ctx.mutex);
		return reply_error("Não foi possível iniciar o pareamento.");
	}

	// A libchiaki tem seus próprios limites de tempo; este é só uma garantia.
	chiaki_mutex_lock(&ctx.mutex);
	err = chiaki_cond_timedwait_pred(&ctx.cond, &ctx.mutex, 60000, regist_done_pred, &ctx);
	chiaki_mutex_unlock(&ctx.mutex);
	if(err == CHIAKI_ERR_TIMEOUT)
		chiaki_regist_stop(&regist);
	chiaki_regist_fini(&regist);
	chiaki_cond_fini(&ctx.cond);
	chiaki_mutex_fini(&ctx.mutex);

	if(!ctx.success)
	{
		if(g_regist_search_refused)
			return reply_error("O console recusou o pareamento. Deixe aberta no PS5 a tela Configurações → Sistema → Reprodução Remota → Vincular dispositivo, com o código à mostra, e tente de novo.");
		if(g_app_reason == CHIAKI_RP_APPLICATION_REASON_REGIST_FAILED)
			return reply_error("O console não aceitou o PIN. Confira os 8 dígitos (o código muda a cada vez que a tela é aberta e expira em alguns minutos).");
		if(g_app_reason == CHIAKI_RP_APPLICATION_REASON_INVALID_PSN_ID)
			return reply_error("O console não aceitou o ID da conta PSN. Use o ID da mesma conta que está no PS5.");
		if(g_regist_no_response || err == CHIAKI_ERR_TIMEOUT)
			return reply_error("O console não respondeu. Confira o endereço, se ele está ligado na mesma rede e se a tela Vincular dispositivo está aberta.");
		return reply_error("O pareamento falhou. Confira o PIN, o ID da conta PSN e se a tela Vincular dispositivo está aberta no PS5.");
	}

	// rp_regist_key: texto ASCII preenchido com zeros; mandamos só a parte útil.
	size_t regist_key_len = 0;
	while(regist_key_len < sizeof(ctx.host.rp_regist_key) && ctx.host.rp_regist_key[regist_key_len])
		regist_key_len++;
	char regist_key_hex[2 * sizeof(ctx.host.rp_regist_key) + 1];
	hex_encode((const uint8_t *)ctx.host.rp_regist_key, regist_key_len, regist_key_hex, false);
	char rp_key_hex[2 * sizeof(ctx.host.rp_key) + 1];
	hex_encode(ctx.host.rp_key, sizeof(ctx.host.rp_key), rp_key_hex, false);
	char mac_hex[2 * sizeof(ctx.host.server_mac) + 1];
	hex_encode(ctx.host.server_mac, sizeof(ctx.host.server_mac), mac_hex, false);
	// No PS5 o host-id da busca é o MAC em hexadecimal maiúsculo.
	char id_hex[2 * sizeof(ctx.host.server_mac) + 1];
	hex_encode(ctx.host.server_mac, sizeof(ctx.host.server_mac), id_hex, true);

	char nickname[sizeof(ctx.host.server_nickname) + 1];
	memcpy(nickname, ctx.host.server_nickname, sizeof(ctx.host.server_nickname));
	nickname[sizeof(ctx.host.server_nickname)] = '\0';

	Str s = { 0 };
	str_add(&s, "{\"ok\":true,\"name\":");
	str_add_json(&s, nickname);
	str_add(&s, ",\"id\":");
	str_add_json(&s, id_hex);
	str_add(&s, ",\"mac\":");
	str_add_json(&s, mac_hex);
	str_add(&s, ",\"registKey\":");
	str_add_json(&s, regist_key_hex);
	str_add(&s, ",\"rpKey\":");
	str_add_json(&s, rp_key_hex);
	str_add(&s, "}");
	return reply_line(&s, 0);
}

// ---------------- wake ----------------

static int cmd_wake(Args *args)
{
	if(!args->host)
		return reply_error("Informe o endereço do console (--host).");
	char regist_key[CHIAKI_SESSION_AUTH_SIZE];
	if(!parse_regist_key(args->regist_key, regist_key))
		return reply_error("Chave de pareamento (--regist-key) inválida.");

	// A credencial do "acordar" é a regist key (texto hexadecimal) lida como número.
	char key_text[CHIAKI_SESSION_AUTH_SIZE + 1];
	memcpy(key_text, regist_key, CHIAKI_SESSION_AUTH_SIZE);
	key_text[CHIAKI_SESSION_AUTH_SIZE] = '\0';
	size_t key_len = strlen(key_text);
	if(key_len == 0 || key_len > 8)
		return reply_error("Chave de pareamento (--regist-key) inválida.");
	for(size_t i = 0; i < key_len; i++)
		if(hex_val(key_text[i]) < 0)
			return reply_error("Chave de pareamento (--regist-key) inválida.");
	uint64_t credential = (uint64_t)strtoull(key_text, NULL, 16);

	// UDP pode se perder: manda três vezes (acordar duas vezes não faz mal).
	ChiakiErrorCode err = CHIAKI_ERR_UNKNOWN;
	bool any_ok = false;
	for(int i = 0; i < 3; i++)
	{
		err = chiaki_discovery_wakeup(&g_log, NULL, args->host, credential, true);
		if(err == CHIAKI_ERR_SUCCESS)
			any_ok = true;
		if(i < 2)
			sleep_ms(150);
	}
	if(!any_ok)
		return reply_error("Não foi possível mandar o sinal para acordar o console. Confira o endereço.");

	Str s = { 0 };
	str_add(&s, "{\"ok\":true}");
	return reply_line(&s, 0);
}

// ---------------- stream ----------------

typedef enum
{
	STOP_NONE = 0,
	STOP_STDIN,       // o Telão fechou o stdin: saída normal
	STOP_OUTPUT,      // o Telão fechou o stdout
	STOP_QUIT,        // a sessão terminou sozinha
	STOP_LOGIN_PIN    // o console pediu a senha de login
} StopReason;

typedef struct
{
	ChiakiSession session;
	ChiakiOpusDecoder opus;
	ChiakiConnectVideoProfile profile;

	// Sinalização para a thread principal.
	ChiakiMutex state_mutex;
	ChiakiCond state_cond;
	StopReason stop_reason;
	bool quit_received;

	// Vídeo (só a thread de vídeo da libchiaki mexe nestes campos,
	// exceto idr_requested, que vem da thread do stdin).
	uint8_t *header;          // SPS/PPS mais recente, em Annex-B
	size_t header_size;
	bool waiting_keyframe;    // descarta quadros até chegar um IDR
	uint64_t idr_request_ms;
	uint32_t frame_id;
	uint64_t frames_dropped;
	volatile bool idr_requested; // comando "idr" do Telão

	// Som.
	uint32_t audio_channels;
	uint32_t audio_rate;
	int16_t *audio_buf;
	size_t audio_buf_samples;
} StreamCtx;

static void stream_request_stop(StreamCtx *ctx, StopReason reason)
{
	chiaki_mutex_lock(&ctx->state_mutex);
	if(ctx->stop_reason == STOP_NONE)
		ctx->stop_reason = reason;
	chiaki_cond_signal(&ctx->state_cond);
	chiaki_mutex_unlock(&ctx->state_mutex);
}

static bool stream_should_wake(void *user)
{
	StreamCtx *ctx = user;
	return ctx->stop_reason != STOP_NONE || ctx->quit_received;
}

static const char *quit_reason_code(ChiakiQuitReason reason)
{
	switch(reason)
	{
		case CHIAKI_QUIT_REASON_NONE: return "NONE";
		case CHIAKI_QUIT_REASON_STOPPED: return "STOPPED";
		case CHIAKI_QUIT_REASON_SESSION_REQUEST_UNKNOWN: return "SESSION_REQUEST_UNKNOWN";
		case CHIAKI_QUIT_REASON_SESSION_REQUEST_CONNECTION_REFUSED: return "SESSION_REQUEST_CONNECTION_REFUSED";
		case CHIAKI_QUIT_REASON_SESSION_REQUEST_RP_IN_USE: return "SESSION_REQUEST_RP_IN_USE";
		case CHIAKI_QUIT_REASON_SESSION_REQUEST_RP_CRASH: return "SESSION_REQUEST_RP_CRASH";
		case CHIAKI_QUIT_REASON_SESSION_REQUEST_RP_VERSION_MISMATCH: return "SESSION_REQUEST_RP_VERSION_MISMATCH";
		case CHIAKI_QUIT_REASON_CTRL_UNKNOWN: return "CTRL_UNKNOWN";
		case CHIAKI_QUIT_REASON_CTRL_CONNECT_FAILED: return "CTRL_CONNECT_FAILED";
		case CHIAKI_QUIT_REASON_CTRL_CONNECTION_REFUSED: return "CTRL_CONNECTION_REFUSED";
		case CHIAKI_QUIT_REASON_STREAM_CONNECTION_UNKNOWN: return "STREAM_CONNECTION_UNKNOWN";
		case CHIAKI_QUIT_REASON_STREAM_CONNECTION_REMOTE_DISCONNECTED: return "STREAM_CONNECTION_REMOTE_DISCONNECTED";
		case CHIAKI_QUIT_REASON_STREAM_CONNECTION_REMOTE_SHUTDOWN: return "STREAM_CONNECTION_REMOTE_SHUTDOWN";
		case CHIAKI_QUIT_REASON_PSN_REGIST_FAILED: return "PSN_REGIST_FAILED";
	}
	return "UNKNOWN";
}

#define LOGIN_PIN_MESSAGE "O PS5 pediu a senha de login do usuário, e o Telão ainda não sabe digitá-la. " \
	"Desative a senha de login no PS5 (Configurações → Usuários e contas → Configurações de login → Senha de login do PS5) e tente de novo."

static const char *quit_reason_message(ChiakiQuitReason reason)
{
	switch(reason)
	{
		case CHIAKI_QUIT_REASON_STOPPED:
			return "Transmissão encerrada.";
		case CHIAKI_QUIT_REASON_SESSION_REQUEST_RP_IN_USE:
			return "A Reprodução Remota do PS5 já está em uso por outro aparelho. Feche a outra sessão e tente de novo.";
		case CHIAKI_QUIT_REASON_SESSION_REQUEST_RP_CRASH:
			return "A Reprodução Remota travou no PS5. Reinicie o console e tente de novo.";
		case CHIAKI_QUIT_REASON_SESSION_REQUEST_RP_VERSION_MISMATCH:
			return "A versão da Reprodução Remota do PS5 não é compatível. Atualize o software do console.";
		case CHIAKI_QUIT_REASON_SESSION_REQUEST_CONNECTION_REFUSED:
			return "O PS5 recusou a conexão. Verifique se a Reprodução Remota está ativada (Configurações → Sistema → Reprodução Remota → Ativar Reprodução Remota).";
		case CHIAKI_QUIT_REASON_SESSION_REQUEST_UNKNOWN:
			if(g_app_reason == CHIAKI_RP_APPLICATION_REASON_REGIST_FAILED || g_app_reason == CHIAKI_RP_APPLICATION_REASON_INVALID_PSN_ID)
				return "O PS5 não aceitou as chaves de pareamento (o Telão pode ter sido desvinculado do console). Pareie o console de novo.";
			return "O PS5 não aceitou a conexão. Confira se ele está ligado, na mesma rede, com a Reprodução Remota ativada e pareado com o Telão.";
		case CHIAKI_QUIT_REASON_CTRL_CONNECT_FAILED:
			return "Não foi possível conectar ao PS5. Confira se ele está ligado e na mesma rede.";
		case CHIAKI_QUIT_REASON_CTRL_CONNECTION_REFUSED:
			return "O PS5 recusou a conexão. Verifique se a Reprodução Remota está ativada e se o Telão continua pareado.";
		case CHIAKI_QUIT_REASON_CTRL_UNKNOWN:
			return "A conexão com o PS5 falhou. Se continuar acontecendo, pareie o console de novo.";
		case CHIAKI_QUIT_REASON_STREAM_CONNECTION_REMOTE_DISCONNECTED:
			return "O PS5 encerrou a transmissão.";
		case CHIAKI_QUIT_REASON_STREAM_CONNECTION_REMOTE_SHUTDOWN:
			return "O PS5 foi desligado ou entrou em modo de repouso.";
		case CHIAKI_QUIT_REASON_STREAM_CONNECTION_UNKNOWN:
			return "A conexão com o PS5 caiu.";
		case CHIAKI_QUIT_REASON_PSN_REGIST_FAILED:
			return "O pareamento pela PSN falhou.";
		case CHIAKI_QUIT_REASON_NONE:
		default:
			return "A transmissão do PS5 terminou por um motivo desconhecido.";
	}
}

static void event_cb(ChiakiEvent *event, void *user)
{
	StreamCtx *ctx = user;
	switch(event->type)
	{
		case CHIAKI_EVENT_CONNECTED:
		{
			CHIAKI_LOGI(&g_log, "Conectado ao PS5");
			Str s = { 0 };
			str_addf(&s, "{\"event\":\"connected\",\"width\":%u,\"height\":%u,\"fps\":%u,\"codec\":\"h264\"}",
					ctx->profile.width, ctx->profile.height, ctx->profile.max_fps);
			emit_event_str(&s);
			str_free(&s);
			break;
		}
		case CHIAKI_EVENT_LOGIN_PIN_REQUEST:
			CHIAKI_LOGW(&g_log, "O console pediu a senha de login (não suportado)");
			emit_message_event("error", LOGIN_PIN_MESSAGE, true);
			stream_request_stop(ctx, STOP_LOGIN_PIN);
			break;
		case CHIAKI_EVENT_NICKNAME_RECEIVED:
			CHIAKI_LOGI(&g_log, "Nome do console: %.*s", (int)sizeof(event->server_nickname), event->server_nickname);
			break;
		case CHIAKI_EVENT_QUIT:
		{
			const char *code = quit_reason_code(event->quit.reason);
			const char *message = quit_reason_message(event->quit.reason);
			chiaki_mutex_lock(&ctx->state_mutex);
			StopReason stop_reason = ctx->stop_reason;
			chiaki_mutex_unlock(&ctx->state_mutex);
			if(stop_reason == STOP_LOGIN_PIN)
			{
				code = "LOGIN_PIN_REQUEST";
				message = LOGIN_PIN_MESSAGE;
			}
			CHIAKI_LOGI(&g_log, "Sessão terminou: %s (%s)%s%s", code, chiaki_quit_reason_string(event->quit.reason),
					event->quit.reason_str ? ": " : "", event->quit.reason_str ? event->quit.reason_str : "");
			Str s = { 0 };
			str_add(&s, "{\"event\":\"quit\",\"reason\":");
			str_add_json(&s, code);
			str_add(&s, ",\"message\":");
			str_add_json(&s, message);
			str_add(&s, "}");
			emit_event_str(&s);
			str_free(&s);
			chiaki_mutex_lock(&ctx->state_mutex);
			ctx->quit_received = true;
			if(ctx->stop_reason == STOP_NONE)
				ctx->stop_reason = STOP_QUIT;
			chiaki_cond_signal(&ctx->state_cond);
			chiaki_mutex_unlock(&ctx->state_mutex);
			break;
		}
		case CHIAKI_EVENT_VIDEO_FEC_FAILURE:
			CHIAKI_LOGV(&g_log, "Quadro %d perdido (FEC), pedido de IDR %s", (int)event->video_fec_failure.frame_index,
					event->video_fec_failure.idr_request_sent ? "enviado" : "não enviado");
			break;
		default:
			break;
	}
}

// --- Análise mínima de H.264 Annex-B ---

typedef struct
{
	bool has_sps;
	bool has_pps;
	bool has_idr;    // NAL tipo 5
	bool has_slice;  // NAL tipo 1 ou 5
} NalInfo;

// Percorre os start codes (00 00 01 / 00 00 00 01) até achar o primeiro slice.
static NalInfo nal_scan(const uint8_t *buf, size_t size)
{
	NalInfo info = { false, false, false, false };
	size_t i = 0;
	while(i + 3 < size)
	{
		if(buf[i] == 0 && buf[i + 1] == 0 && buf[i + 2] == 1)
		{
			uint8_t type = buf[i + 3] & 0x1f;
			if(type == 7) info.has_sps = true;
			else if(type == 8) info.has_pps = true;
			else if(type == 5) { info.has_idr = true; info.has_slice = true; break; }
			else if(type == 1) { info.has_slice = true; break; }
			i += 3;
		}
		else
			i++;
	}
	return info;
}

static bool starts_with_start_code(const uint8_t *buf, size_t size)
{
	return (size >= 4 && buf[0] == 0 && buf[1] == 0 && buf[2] == 0 && buf[3] == 1)
		|| (size >= 3 && buf[0] == 0 && buf[1] == 0 && buf[2] == 1);
}

static void request_idr(StreamCtx *ctx, const char *why)
{
	ctx->idr_request_ms = chiaki_time_now_monotonic_ms();
	ChiakiErrorCode err = chiaki_session_request_idr(&ctx->session);
	if(err != CHIAKI_ERR_SUCCESS)
		CHIAKI_LOGW(&g_log, "Pedido de keyframe (%s) falhou: %s", why, chiaki_error_string(err));
	else
		CHIAKI_LOGI(&g_log, "Pedido de keyframe enviado (%s)", why);
}

// Chamado pela libchiaki com cada quadro H.264 completo (Annex-B). Antes do primeiro
// quadro (e a cada troca de perfil) ela chama com o cabeçalho do perfil: só SPS/PPS,
// sem slice. Guardamos esse cabeçalho e o colocamos na frente de cada IDR, para o
// decodificador do Telão sempre conseguir começar (ou recomeçar) num keyframe.
static bool video_cb(uint8_t *buf, size_t buf_size, int32_t frames_lost, bool frame_recovered, void *user)
{
	StreamCtx *ctx = user;
	if(!buf || !buf_size)
		return true;
	if(!starts_with_start_code(buf, buf_size))
		CHIAKI_LOGW(&g_log, "Quadro de vídeo sem start code Annex-B (%zu bytes)", buf_size);

	NalInfo nal = nal_scan(buf, buf_size);

	if(!nal.has_slice)
	{
		if(nal.has_sps)
		{
			bool changed = !ctx->header || ctx->header_size != buf_size || memcmp(ctx->header, buf, buf_size) != 0;
			if(changed)
			{
				uint8_t *copy = malloc(buf_size);
				if(copy)
				{
					memcpy(copy, buf, buf_size);
					free(ctx->header);
					ctx->header = copy;
					ctx->header_size = buf_size;
					// Novo SPS = nova sequência: só serve a partir do próximo IDR.
					ctx->waiting_keyframe = true;
					CHIAKI_LOGI(&g_log, "Cabeçalho de vídeo (SPS/PPS) recebido: %zu bytes", buf_size);
				}
			}
		}
		else
			CHIAKI_LOGV(&g_log, "Amostra de vídeo sem slice ignorada (%zu bytes)", buf_size);
		return true;
	}

	// Número do quadro: conta também os que a libchiaki perdeu, para o Telão ver o buraco.
	ctx->frame_id += 1 + (frames_lost > 0 ? (uint32_t)frames_lost : 0);
	if(frames_lost > 0 || frame_recovered)
		CHIAKI_LOGV(&g_log, "Quadro %u: %d perdido(s)%s", ctx->frame_id, (int)frames_lost, frame_recovered ? ", recuperado" : "");

	if(ctx->idr_requested)
	{
		ctx->idr_requested = false;
		ctx->waiting_keyframe = true;
		request_idr(ctx, "pedido do Telão");
	}

	if(ctx->waiting_keyframe && !nal.has_idr)
	{
		ctx->frames_dropped++;
		if(chiaki_time_now_monotonic_ms() - ctx->idr_request_ms >= IDR_RETRY_MS)
			request_idr(ctx, "esperando keyframe");
		return true;
	}

	if(nal.has_idr && !nal.has_sps)
	{
		if(!ctx->header)
		{
			// Sem SPS/PPS o decodificador não consegue começar: espera o próximo.
			ctx->waiting_keyframe = true;
			ctx->frames_dropped++;
			if(chiaki_time_now_monotonic_ms() - ctx->idr_request_ms >= IDR_RETRY_MS)
				request_idr(ctx, "IDR sem SPS/PPS");
			return true;
		}
		out_packet2(PKT_VIDEO, ctx->frame_id, ctx->header, ctx->header_size, buf, buf_size);
	}
	else
		out_packet(PKT_VIDEO, ctx->frame_id, buf, buf_size);

	if(ctx->waiting_keyframe)
	{
		CHIAKI_LOGI(&g_log, "Keyframe enviado (quadro %u, %llu descartado(s) antes)", ctx->frame_id,
				(unsigned long long)ctx->frames_dropped);
		ctx->waiting_keyframe = false;
		ctx->frames_dropped = 0;
	}

	if(g_out_broken)
		stream_request_stop(ctx, STOP_OUTPUT);
	return true;
}

static void audio_settings_cb(uint32_t channels, uint32_t rate, void *user)
{
	StreamCtx *ctx = user;
	ctx->audio_channels = channels;
	ctx->audio_rate = rate;
	CHIAKI_LOGI(&g_log, "Som do PS5: %u canal(is), %u Hz", channels, rate);
	if(rate != 48000)
	{
		char msg[160];
		snprintf(msg, sizeof(msg), "O PS5 mandou som a %u Hz (o esperado era 48000 Hz); o som pode sair com a velocidade errada.", rate);
		emit_message_event("warning", msg, false);
	}
}

// PCM decodificado pelo Opus: "samples" é o número de amostras POR CANAL.
static void audio_frame_cb(int16_t *buf, size_t samples, void *user)
{
	StreamCtx *ctx = user;
	uint32_t channels = ctx->audio_channels ? ctx->audio_channels : 2;
	if(channels == 2)
	{
		out_packet(PKT_AUDIO, 0, buf, samples * 2 * sizeof(int16_t));
	}
	else
	{
		// Converte para estéreo: mono duplicado; mais de 2 canais, ficam os 2 primeiros.
		if(ctx->audio_buf_samples < samples)
		{
			int16_t *nb = realloc(ctx->audio_buf, samples * 2 * sizeof(int16_t));
			if(!nb)
				return;
			ctx->audio_buf = nb;
			ctx->audio_buf_samples = samples;
		}
		for(size_t i = 0; i < samples; i++)
		{
			int16_t l = buf[i * channels];
			int16_t r = channels >= 2 ? buf[i * channels + 1] : l;
			ctx->audio_buf[2 * i] = l;
			ctx->audio_buf[2 * i + 1] = r;
		}
		out_packet(PKT_AUDIO, 0, ctx->audio_buf, samples * 2 * sizeof(int16_t));
	}
	if(g_out_broken)
		stream_request_stop(ctx, STOP_OUTPUT);
}

// Lê um bloco do stdin sem passar pelo stdio (não segura travas do FILE,
// então a saída do programa nunca fica presa esperando esta thread).
static long stdin_read(char *buf, size_t size)
{
#ifdef _WIN32
	DWORD n = 0;
	if(!ReadFile(GetStdHandle(STD_INPUT_HANDLE), buf, (DWORD)size, &n, NULL))
		return -1;
	return (long)n;
#else
	ssize_t n;
	do
		n = read(0, buf, size);
	while(n < 0 && errno == EINTR);
	return (long)n;
#endif
}

static void handle_command(StreamCtx *ctx, char *line)
{
	// Tira espaços e \r das pontas.
	char *start = line;
	while(*start && isspace((unsigned char)*start))
		start++;
	size_t len = strlen(start);
	while(len && isspace((unsigned char)start[len - 1]))
		start[--len] = '\0';
	if(!len)
		return;
	if(strcmp(start, "idr") == 0)
	{
		// Quem pede de fato é a thread de vídeo, no próximo quadro (sem disputar estado).
		ctx->idr_requested = true;
		CHIAKI_LOGI(&g_log, "Telão pediu keyframe");
	}
	else
		CHIAKI_LOGW(&g_log, "Comando desconhecido no stdin: %s", start);
}

static void *stdin_thread_func(void *user)
{
	StreamCtx *ctx = user;
	char line[256];
	size_t line_len = 0;
	char chunk[256];
	while(true)
	{
		long n = stdin_read(chunk, sizeof(chunk));
		if(n <= 0)
			break;
		for(long i = 0; i < n; i++)
		{
			char c = chunk[i];
			if(c == '\n')
			{
				line[line_len] = '\0';
				handle_command(ctx, line);
				line_len = 0;
			}
			else if(line_len + 1 < sizeof(line))
				line[line_len++] = c;
		}
	}
	if(line_len)
	{
		line[line_len] = '\0';
		handle_command(ctx, line);
	}
	CHIAKI_LOGI(&g_log, "stdin fechado, encerrando a transmissão");
	stream_request_stop(ctx, STOP_STDIN);
	return NULL;
}

static int stream_fail(const char *message)
{
	CHIAKI_LOGE(&g_log, "%s", message);
	emit_message_event("error", message, true);
	return 1;
}

static int cmd_stream(Args *args)
{
	emit_simple_event("connecting");

	if(!args->host)
		return stream_fail("Informe o endereço do console (--host).");

	StreamCtx *ctx = calloc(1, sizeof(StreamCtx));
	if(!ctx)
		return stream_fail("Sem memória.");

	ChiakiConnectInfo info;
	memset(&info, 0, sizeof(info));
	if(!parse_regist_key(args->regist_key, info.regist_key))
	{
		free(ctx);
		return stream_fail("Chave de pareamento (--regist-key) inválida.");
	}
	size_t rp_key_len = 0;
	if(!args->rp_key || !hex_decode(args->rp_key, info.morning, sizeof(info.morning), &rp_key_len) || rp_key_len != sizeof(info.morning))
	{
		free(ctx);
		return stream_fail("Chave de pareamento (--rp-key) inválida: precisa ter 32 dígitos hexadecimais.");
	}

	ChiakiVideoResolutionPreset resolution = CHIAKI_VIDEO_RESOLUTION_PRESET_1080p;
	if(args->resolution)
	{
		if(strcmp(args->resolution, "1080p") == 0) resolution = CHIAKI_VIDEO_RESOLUTION_PRESET_1080p;
		else if(strcmp(args->resolution, "720p") == 0) resolution = CHIAKI_VIDEO_RESOLUTION_PRESET_720p;
		else if(strcmp(args->resolution, "540p") == 0) resolution = CHIAKI_VIDEO_RESOLUTION_PRESET_540p;
		else if(strcmp(args->resolution, "360p") == 0) resolution = CHIAKI_VIDEO_RESOLUTION_PRESET_360p;
		else
		{
			free(ctx);
			return stream_fail("Resolução inválida (use 720p ou 1080p).");
		}
	}
	ChiakiVideoFPSPreset fps = CHIAKI_VIDEO_FPS_PRESET_60;
	if(args->fps)
	{
		if(strcmp(args->fps, "60") == 0) fps = CHIAKI_VIDEO_FPS_PRESET_60;
		else if(strcmp(args->fps, "30") == 0) fps = CHIAKI_VIDEO_FPS_PRESET_30;
		else
		{
			free(ctx);
			return stream_fail("Quadros por segundo inválidos (use 30 ou 60).");
		}
	}
	chiaki_connect_video_profile_preset(&ctx->profile, resolution, fps);
	if(args->bitrate)
	{
		unsigned long kbps = 0;
		if(!parse_uint(args->bitrate, &kbps) || kbps < 500 || kbps > 100000)
		{
			free(ctx);
			return stream_fail("Taxa de bits inválida (use kbps, entre 500 e 100000).");
		}
		ctx->profile.bitrate = (unsigned int)kbps;
	}
	ctx->profile.codec = CHIAKI_CODEC_H264;
	CHIAKI_LOGI(&g_log, "Perfil de vídeo: %ux%u, %u fps, %u kbps, H.264", ctx->profile.width, ctx->profile.height,
			ctx->profile.max_fps, ctx->profile.bitrate);

	info.ps5 = true;
	info.host = args->host;
	info.video_profile = ctx->profile;
	info.video_profile_auto_downgrade = true;
	info.enable_keyboard = false;
	info.enable_dualsense = false;
	info.audio_video_disabled = CHIAKI_NONE_DISABLED;
	info.auto_regist = false;
	info.holepunch_session = NULL;
	info.rudp_sock = NULL;
	info.packet_loss_max = 0.05; // mesmo padrão do chiaki-ng
	info.enable_idr_on_fec_failure = true;

	chiaki_mutex_init(&ctx->state_mutex, false);
	chiaki_cond_init(&ctx->state_cond);
	ctx->waiting_keyframe = true;

	ChiakiErrorCode err = chiaki_session_init(&ctx->session, &info, &g_log);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		chiaki_cond_fini(&ctx->state_cond);
		chiaki_mutex_fini(&ctx->state_mutex);
		free(ctx);
		return stream_fail(err == CHIAKI_ERR_PARSE_ADDR ? "Endereço do console inválido." : "Não foi possível preparar a conexão com o PS5.");
	}

	chiaki_opus_decoder_init(&ctx->opus, &g_log);
	chiaki_opus_decoder_set_cb(&ctx->opus, audio_settings_cb, audio_frame_cb, ctx);
	ChiakiAudioSink audio_sink;
	chiaki_opus_decoder_get_sink(&ctx->opus, &audio_sink);
	chiaki_session_set_audio_sink(&ctx->session, &audio_sink);
	chiaki_session_set_video_sample_cb(&ctx->session, video_cb, ctx);
	chiaki_session_set_event_cb(&ctx->session, event_cb, ctx);

	err = chiaki_session_start(&ctx->session);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		chiaki_session_fini(&ctx->session);
		chiaki_opus_decoder_fini(&ctx->opus);
		chiaki_cond_fini(&ctx->state_cond);
		chiaki_mutex_fini(&ctx->state_mutex);
		free(ctx);
		return stream_fail("Não foi possível iniciar a conexão com o PS5.");
	}

	ChiakiThread stdin_thread;
	if(chiaki_thread_create(&stdin_thread, stdin_thread_func, ctx) != CHIAKI_ERR_SUCCESS)
		CHIAKI_LOGW(&g_log, "Não foi possível criar a thread do stdin");
	else
		chiaki_thread_set_name(&stdin_thread, "telao-ps5 stdin");

	// Espera: stdin fechado, saída fechada, senha pedida ou sessão encerrada.
	chiaki_mutex_lock(&ctx->state_mutex);
	chiaki_cond_wait_pred(&ctx->state_cond, &ctx->state_mutex, stream_should_wake, ctx);
	chiaki_mutex_unlock(&ctx->state_mutex);

	chiaki_session_stop(&ctx->session);
	chiaki_session_join(&ctx->session);

	chiaki_mutex_lock(&ctx->state_mutex);
	StopReason reason = ctx->stop_reason;
	bool quit_received = ctx->quit_received;
	chiaki_mutex_unlock(&ctx->state_mutex);

	if(!quit_received)
	{
		// A libchiaki sempre manda QUIT ao terminar a thread da sessão; isto é só garantia.
		Str s = { 0 };
		str_add(&s, "{\"event\":\"quit\",\"reason\":\"STOPPED\",\"message\":");
		str_add_json(&s, quit_reason_message(CHIAKI_QUIT_REASON_STOPPED));
		str_add(&s, "}");
		emit_event_str(&s);
		str_free(&s);
	}

	chiaki_session_fini(&ctx->session);
	chiaki_opus_decoder_fini(&ctx->opus);
	// A thread do stdin pode continuar bloqueada lendo; o processo termina por cima dela.
	// Por isso ctx não é liberado aqui.

	CHIAKI_LOGI(&g_log, "Fim da transmissão (motivo interno %d)", (int)reason);
	return reason == STOP_STDIN ? 0 : 1;
}

// ---------------- main ----------------

static void usage(void)
{
	fprintf(stderr,
		"telao-ps5: receptor de Reprodução Remota do PS5 para o Telão (baseado no chiaki-ng, AGPL-3.0)\n"
		"Uso:\n"
		"  telao-ps5 discover [--timeout 2000] [--host IP]\n"
		"  telao-ps5 register --host IP --account-id BASE64 --pin 12345678 [--broadcast]\n"
		"  telao-ps5 wake --host IP --regist-key HEX\n"
		"  telao-ps5 stream --host IP --regist-key HEX --rp-key HEX [--resolution 720p|1080p] [--fps 30|60] [--bitrate KBPS]\n"
		"Opção geral: --verbose (todos os logs no stderr)\n");
}

int main(int argc, char **argv)
{
#ifdef _WIN32
	// stdout binário: sem isto o Windows troca \n por \r\n no meio do vídeo.
	_setmode(_fileno(stdout), _O_BINARY);
	_setmode(_fileno(stdin), _O_BINARY);
#else
	// Se o Telão fechar o pipe, o write falha com EPIPE em vez de matar o processo.
	signal(SIGPIPE, SIG_IGN);
#endif
	setvbuf(stdout, NULL, _IOFBF, 1 << 16);

	chiaki_mutex_init(&g_log_mutex, false);
	chiaki_mutex_init(&g_out_mutex, false);

	const char *mode = argc >= 2 ? argv[1] : NULL;
	bool is_stream = mode && strcmp(mode, "stream") == 0;

	Args args;
	char err_buf[256];
	const char *arg_err = mode ? parse_args(argc, argv, &args, err_buf, sizeof(err_buf)) : NULL;

	uint32_t mask = CHIAKI_LOG_INFO | CHIAKI_LOG_WARNING | CHIAKI_LOG_ERROR;
	if(mode && args.verbose)
		mask = CHIAKI_LOG_ALL;
	chiaki_log_init(&g_log, mask, log_cb, NULL);

	if(!mode || (strcmp(mode, "discover") && strcmp(mode, "register") && strcmp(mode, "wake") && !is_stream))
	{
		usage();
		return reply_error(mode ? "Modo desconhecido (use discover, register, wake ou stream)." : "Informe o modo (discover, register, wake ou stream).");
	}
	if(arg_err)
	{
		usage();
		if(is_stream)
		{
			emit_message_event("error", arg_err, true);
			return 1;
		}
		return reply_error(arg_err);
	}

	ChiakiErrorCode err = chiaki_lib_init();
	if(err != CHIAKI_ERR_SUCCESS)
	{
		CHIAKI_LOGE(&g_log, "chiaki_lib_init falhou: %s", chiaki_error_string(err));
		const char *msg = "Não foi possível iniciar a biblioteca do chiaki-ng.";
		if(is_stream)
		{
			emit_message_event("error", msg, true);
			return 1;
		}
		return reply_error(msg);
	}

	int r;
	if(strcmp(mode, "discover") == 0)
		r = cmd_discover(&args);
	else if(strcmp(mode, "register") == 0)
		r = cmd_register(&args);
	else if(strcmp(mode, "wake") == 0)
		r = cmd_wake(&args);
	else
		r = cmd_stream(&args);

	fflush(stdout);
	fflush(stderr);
	return r;
}
