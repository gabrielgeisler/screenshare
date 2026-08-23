require('dotenv').config();
const crypto = require('crypto');
const https = require('https');
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const SENHA = process.env.SENHA;
if (!SENHA) {
  console.error('Defina a variável SENHA no arquivo .env antes de iniciar o servidor.');
  process.exit(1);
}

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const DISCORD_START_MESSAGE_TEMPLATE = process.env.DISCORD_START_MESSAGE || '🔴 🎥{nome} inicou uma transmissão! - https://screenshare.gariel.cloud/';
const DISCORD_NOTIFY_ENABLED = Boolean(DISCORD_BOT_TOKEN && DISCORD_CHANNEL_ID);

if (!DISCORD_NOTIFY_ENABLED) {
  console.warn('[DISCORD] Notificações desativadas (defina DISCORD_BOT_TOKEN e DISCORD_CHANNEL_ID no .env).');
}

// Valida o cabeçalho "Authorization: Basic ..." contra a senha do .env;
// o usuário digita a senha só uma vez porque o navegador reenvia o cabeçalho sozinho
function checkBasicAuth(header) {
  if (!header || !header.startsWith('Basic ')) return false;

  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const senhaDigitada = decoded.slice(decoded.indexOf(':') + 1);

  const esperado = Buffer.from(SENHA);
  const recebido = Buffer.from(senhaDigitada);
  if (esperado.length !== recebido.length) return false;
  return crypto.timingSafeEqual(esperado, recebido);
}

function discordRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    if (!DISCORD_NOTIFY_ENABLED) {
      resolve(null);
      return;
    }

    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'discord.com',
        path: `/api/v10${apiPath}`,
        method,
        headers: {
          Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          if (!ok) {
            reject(new Error(`[DISCORD] ${method} ${apiPath} falhou (${res.statusCode}): ${data || 'sem corpo'}`));
            return;
          }

          if (!data) {
            resolve(null);
            return;
          }

          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on('error', (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

let discordBroadcastMessageId = null;

function montarMensagemInicioDiscord(nomeBroadcaster) {
  const nome = String(nomeBroadcaster || 'Anônimo');
  return DISCORD_START_MESSAGE_TEMPLATE.replace('{nome}', nome);
}

async function enviarAvisoInicioDiscord(nomeBroadcaster) {
  if (!DISCORD_NOTIFY_ENABLED || discordBroadcastMessageId) return;
  try {
    const message = await discordRequest('POST', `/channels/${DISCORD_CHANNEL_ID}/messages`, {
      content: montarMensagemInicioDiscord(nomeBroadcaster),
    });
    discordBroadcastMessageId = message?.id || null;
  } catch (err) {
    console.error('[DISCORD] Erro ao enviar aviso de início:', err.message);
  }
}

async function apagarAvisoInicioDiscord() {
  if (!DISCORD_NOTIFY_ENABLED || !discordBroadcastMessageId) return;
  const messageId = discordBroadcastMessageId;
  discordBroadcastMessageId = null;

  try {
    await discordRequest('DELETE', `/channels/${DISCORD_CHANNEL_ID}/messages/${messageId}`);
  } catch (err) {
    console.error('[DISCORD] Erro ao apagar aviso de início:', err.message);
  }
}

app.use((req, res, next) => {
  if (checkBasicAuth(req.headers.authorization)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Compartilhamento de Tela"');
  res.status(401).send('Autenticação necessária.');
});

app.use(express.static(path.join(__dirname, 'public')));

// Loga uma vez na subida se o TURN está configurado, pra não precisar adivinhar depois
if (process.env.TURN_URL) {
  console.log(`[TURN] Configurado: ${process.env.TURN_URL} (usuário: ${process.env.TURN_USERNAME || '(vazio)'})`);
} else {
  console.warn('[TURN] Não configurado (TURN_URL ausente no .env) — espectadores atrás de NAT restritivo podem falhar.');
}

// Monta a lista de ICE servers dinamicamente; TURN é opcional via .env,
// mas necessário para quem está atrás de NAT/firewall restritivo (STUN sozinho não basta)
app.get('/ice-servers', (req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  const temTurn = Boolean(process.env.TURN_URL);

  if (temTurn) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }

  console.log(`[TURN] /ice-servers pedido por ${req.ip} — TURN ${temTurn ? 'incluído' : 'AUSENTE'}`);
  res.json({ iceServers });
});

// Guarda o id de quem está compartilhando a tela no momento
let broadcasterId = null;

// O handshake do socket.io reenvia o mesmo cabeçalho de Basic Auth do navegador
io.use((socket, next) => {
  if (checkBasicAuth(socket.handshake.headers.authorization)) {
    socket.data.authenticated = true;
    return next();
  }
  next(new Error('unauthorized'));
});

// Nome de cada conectado, usado para exibir quem está assistindo a transmissão
const nomesConectados = new Map();

function listaDeEspectadores() {
  return Array.from(nomesConectados.entries())
    .filter(([id]) => id !== broadcasterId)
    .map(([, nome]) => nome);
}

function notificarEspectadores() {
  io.emit('viewers-list', listaDeEspectadores());
}

io.on('connection', (socket) => {
  nomesConectados.set(socket.id, 'Anônimo');
  notificarEspectadores();

  // Guarda o nome informado pelo usuário na primeira vez que ele entra
  socket.on('identify', (nome) => {
    if (!socket.data.authenticated) return;
    const nomeLimpo = String(nome || '').trim().slice(0, 30);
    nomesConectados.set(socket.id, nomeLimpo || 'Anônimo');
    notificarEspectadores();
  });

  // Quem inicia o compartilhamento vira o "broadcaster"
  socket.on('broadcaster', () => {
    if (!socket.data.authenticated) return;

    if (broadcasterId && broadcasterId !== socket.id) {
      apagarAvisoInicioDiscord();
    }

    const eraSemTransmissao = !broadcasterId;
    const nomeBroadcaster = nomesConectados.get(socket.id) || 'Anônimo';
    broadcasterId = socket.id;
    socket.broadcast.emit('broadcaster', broadcasterId);
    notificarEspectadores();

    if (eraSemTransmissao || !discordBroadcastMessageId) {
      enviarAvisoInicioDiscord(nomeBroadcaster);
    }
  });

  // O broadcaster avisa quando encerra a transmissão sem se desconectar
  // (ex.: clicou em "Parar compartilhamento"), para os espectadores voltarem à tela inicial
  socket.on('stop-broadcast', () => {
    if (!socket.data.authenticated || socket.id !== broadcasterId) return;
    broadcasterId = null;
    socket.broadcast.emit('broadcaster-disconnected');
    notificarEspectadores();
    apagarAvisoInicioDiscord();
  });

  // Um espectador avisa que quer assistir
  socket.on('watcher', () => {
    if (!socket.data.authenticated) return;
    if (broadcasterId) {
      socket.to(broadcasterId).emit('watcher', socket.id);
    }
  });

  // Repassa as mensagens de sinalização WebRTC entre os pares
  socket.on('offer', (targetId, description) => {
    if (!socket.data.authenticated) return;
    socket.to(targetId).emit('offer', socket.id, description);
  });

  socket.on('answer', (targetId, description) => {
    if (!socket.data.authenticated) return;
    socket.to(targetId).emit('answer', socket.id, description);
  });

  socket.on('candidate', (targetId, candidate) => {
    if (!socket.data.authenticated) return;
    socket.to(targetId).emit('candidate', socket.id, candidate);
  });

  socket.on('disconnect', () => {
    nomesConectados.delete(socket.id);
    if (socket.id === broadcasterId) {
      broadcasterId = null;
      socket.broadcast.emit('broadcaster-disconnected');
      apagarAvisoInicioDiscord();
    } else {
      socket.broadcast.emit('watcher-disconnected', socket.id);
    }
    notificarEspectadores();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
