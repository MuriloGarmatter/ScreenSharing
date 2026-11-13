# telao-ps5: receptor de Reprodução Remota do PS5 para o Telão (AGPL-3.0).
#
# Compila junto com a libchiaki do chiaki-ng. Aponte CHIAKI_NG_DIR para uma cópia do
# chiaki-ng v1.10.1 com os submódulos (nanopb, jerasure, gf-complete, curl):
#
#   git clone --branch v1.10.1 https://github.com/streetpea/chiaki-ng.git
#   git -C chiaki-ng submodule update --init third-party/nanopb third-party/jerasure \
#       third-party/gf-complete third-party/curl
#   cmake -S native/ps5 -B build-ps5 -G Ninja -DCMAKE_BUILD_TYPE=Release -DCHIAKI_NG_DIR=$PWD/chiaki-ng
#   cmake --build build-ps5

cmake_minimum_required(VERSION 3.16)
project(telao_ps5 C)

set(CHIAKI_NG_DIR "${CMAKE_CURRENT_SOURCE_DIR}/chiaki-ng" CACHE PATH "Pasta com o código do chiaki-ng v1.10.1 (com submódulos)")
if(NOT EXISTS "${CHIAKI_NG_DIR}/lib/include/chiaki/session.h")
	message(FATAL_ERROR "chiaki-ng não encontrado em ${CHIAKI_NG_DIR}. Use -DCHIAKI_NG_DIR=<pasta do chiaki-ng v1.10.1>.")
endif()

# Só a libchiaki: sem interface gráfica, CLI, testes, decodificadores de vídeo
# (o Telão decodifica na placa de vídeo) nem integrações de controle.
macro(telao_force name value)
	set(${name} ${value} CACHE STRING "" FORCE)
endmacro()
telao_force(CHIAKI_ENABLE_GUI OFF)
telao_force(CHIAKI_ENABLE_CLI OFF)
telao_force(CHIAKI_ENABLE_TESTS OFF)
telao_force(CHIAKI_ENABLE_ANDROID OFF)
telao_force(CHIAKI_ENABLE_BOREALIS OFF)
telao_force(CHIAKI_ENABLE_FFMPEG_DECODER OFF)
telao_force(CHIAKI_ENABLE_PI_DECODER OFF)
telao_force(CHIAKI_ENABLE_SETSU OFF)
telao_force(CHIAKI_ENABLE_STEAMDECK_NATIVE OFF)
telao_force(CHIAKI_ENABLE_STEAM_SHORTCUT OFF)
telao_force(CHIAKI_ENABLE_SPEEX OFF)
telao_force(CHIAKI_LIB_ENABLE_OPUS ON)
telao_force(CHIAKI_LIB_ENABLE_MBEDTLS OFF)
# Usa o curl do submódulo (estático), como o chiaki-ng faz por padrão.
telao_force(CHIAKI_USE_SYSTEM_CURL OFF)

add_subdirectory("${CHIAKI_NG_DIR}" chiaki-ng EXCLUDE_FROM_ALL)

add_executable(telao-ps5 telao-ps5.c)
set_target_properties(telao-ps5 PROPERTIES C_STANDARD 99 C_STANDARD_REQUIRED ON C_EXTENSIONS ON)
target_link_libraries(telao-ps5 PRIVATE chiaki-lib)

if(WIN32)
	target_compile_definitions(telao-ps5 PRIVATE _WIN32_WINNT=0x0A00 WIN32_LEAN_AND_MEAN)
	target_link_libraries(telao-ps5 PRIVATE ws2_32 iphlpapi)
	if(MINGW)
		# Programa de console; libgcc embutida para precisar de menos DLLs.
		target_link_options(telao-ps5 PRIVATE -static-libgcc)
	endif()
endif()

if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
	target_compile_options(telao-ps5 PRIVATE -Wall -Wextra -Wno-unused-parameter)
endif()

install(TARGETS telao-ps5 RUNTIME DESTINATION .)
