Instalador de **teste** do Telão com o PS5 (Reprodução Remota, sem placa de captura).

> **Não publique este rascunho.** Se ele for publicado, o Telão de todo mundo tenta se atualizar para a versão de teste.

## 1. Instalar

1. Baixe o arquivo `.exe` em **Assets**, no fim desta página.
2. Abra e instale por cima do Telão que já está no PC. O Windows mostra o aviso de "editor desconhecido", como nas outras versões.

## 2. Preparar o PS5 (só na primeira vez)

O PS5 aceita cada usuário em um lugar só: no controle **ou** na Reprodução Remota. Se o usuário pareado com o Telão entrar pelo controle, o console encerra a transmissão. Por isso o Telão usa um **segundo usuário**:

1. No PS5, crie um segundo usuário com **outra conta PSN** (gratuita). Usuário convidado não serve.
2. Entre no PS5 com esse segundo usuário.
3. Abra **Configurações → Sistema → Reprodução Remota** e ative **Habilitar Reprodução Remota**.
4. Ainda ali, escolha **Vincular dispositivo**. O PS5 mostra um código de 8 números. Deixe essa tela aberta.

## 3. Parear no Telão (só na primeira vez)

O PS5 e o PC precisam estar na mesma rede.

1. Feche o aplicativo oficial de Reprodução Remota e o chiaki-ng, se estiverem abertos.
2. No Telão, entre numa sala e clique em **Compartilhar tela → aba PS5 → Parear um PS5**.
3. Clique em **Procurar na rede**. Se o console não aparecer, digite o endereço que está no PS5 em **Configurações → Rede → Status da conexão**.
4. Clique em **Entrar na PSN** e faça o login com a conta do **segundo usuário**. O login é na página da Sony; o Telão não vê a senha.
5. Digite o código de 8 números e clique em **Parear**.

Se o Telão já estava pareado com o seu usuário principal, escolha o console na aba PS5, clique em **Esquecer este PS5** e pareie de novo.

## 4. Transmitir e jogar

1. No Telão: **Compartilhar tela → PS5 →** escolha o console **→ Transmitir**.
2. Ligue o controle e escolha o **seu usuário de sempre**.
3. Jogue na TV. Os amigos veem a mesma imagem da TV.

## Se algo falhar

- **A transmissão fecha ao ligar o controle:** o controle entrou com o mesmo usuário pareado com o Telão. Refaça os passos 2 e 3 com o segundo usuário.
- **"Reprodução Remota já em uso":** outro aparelho ou programa está conectado ao PS5. Feche-o e tente de novo.
- **O Windows pergunta sobre o `telao-ps5.exe`:** permita em redes privadas.
- **Outro problema:** guarde a mensagem que apareceu e o arquivo `%APPDATA%\Telao\logs\ps5.log`.
