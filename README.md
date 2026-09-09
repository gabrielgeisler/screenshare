MUDAR A SENHA NO .ENV

## Notificação no Discord (início/fim de transmissão)

No `.env`, configure:

- `DISCORD_BOT_TOKEN`: token do bot
- `DISCORD_CHANNEL_ID`: ID do canal que vai receber a mensagem
- `DISCORD_START_MESSAGE` (opcional): texto da mensagem de início

Com isso, quando a transmissão iniciar, o servidor envia uma mensagem no canal.
Quando a transmissão encerrar, o servidor apaga a mesma mensagem enviada no início.

## Links personalizados de transmissão

Ao iniciar uma transmissão, o emissor recebe um link baseado no seu nome, como
`http://localhost:3000/gabriel`. Quem abrir esse endereço entra diretamente na
transmissão ativa correspondente.

Para que o link enviado pelo Discord use seu domínio público, defina no `.env`:

- `PUBLIC_BASE_URL`: por exemplo, `https://screenshare.seudominio.com`

Use `{link}` em `DISCORD_START_MESSAGE` para incluir o endereço personalizado
na notificação. Sem essa configuração, o endereço padrão de produção é usado.

Permissões mínimas do bot no canal:

- Enviar mensagens (`Send Messages`)
- Gerenciar mensagens (`Manage Messages`) para apagar a mensagem depois

# RODAR NPM INSTALL DENTRO DA PASTA
# RODAR NPM START PARA INICIAR APLICAÇÃO
