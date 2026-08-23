MUDAR A SENHA NO .ENV

## Notificação no Discord (início/fim de transmissão)

No `.env`, configure:

- `DISCORD_BOT_TOKEN`: token do bot
- `DISCORD_CHANNEL_ID`: ID do canal que vai receber a mensagem
- `DISCORD_START_MESSAGE` (opcional): texto da mensagem de início

Com isso, quando a transmissão iniciar, o servidor envia uma mensagem no canal.
Quando a transmissão encerrar, o servidor apaga a mesma mensagem enviada no início.

Permissões mínimas do bot no canal:

- Enviar mensagens (`Send Messages`)
- Gerenciar mensagens (`Manage Messages`) para apagar a mensagem depois

# RODAR NPM INSTALL DENTRO DA PASTA
# RODAR NPM START PARA INICIAR APLICAÇÃO
