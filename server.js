require('dotenv').config();
const https = require('https');
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const DISCORD_START_MESSAGE_TEMPLATE = process.env.DISCORD_START_MESSAGE || '🔴 🎥{nome} inicou uma transmissão! - https://screenshare.gariel.cloud/';
const DISCORD_NOTIFY_ENABLED = Boolean(DISCORD_BOT_TOKEN && DISCORD_CHANNEL_ID);

if (!DISCORD_NOTIFY_ENABLED) {
  console.warn('[DISCORD] Notificações desativadas (defina DISCORD_BOT_TOKEN e DISCORD_CHANNEL_ID no .env).');
}

const SOUND_EFFECT_API_URL = process.env.SOUND_EFFECT_API_URL || 'https://botdisc.zyfdc.dedyn.io:4443';
const SOUND_EFFECT_API_SECRET = process.env.SOUND_EFFECT_API_SECRET;
const SOUND_EFFECT_GUILD_ID = process.env.SOUND_EFFECT_GUILD_ID || '256536331180572672';
const SOUND_EFFECT_START_ID = process.env.SOUND_EFFECT_START_ID || '1542671783533088880';
const SOUND_EFFECT_STOP_ID = process.env.SOUND_EFFECT_STOP_ID || '1542672264967884901';
const SOUND_EFFECT_ENABLED = Boolean(SOUND_EFFECT_API_SECRET);

if (!SOUND_EFFECT_ENABLED) {
  console.warn('[SOUND-EFFECT] Desativado (defina SOUND_EFFECT_API_SECRET no .env).');
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

// O certificado do endpoint é autoassinado, então a verificação é desativada (equivalente ao curl -k)
function tocarSomEfeito(soundEffectId) {
  if (!SOUND_EFFECT_ENABLED) {
    console.warn(`[SOUND-EFFECT] Chamada ignorada (SOUND_EFFECT_API_SECRET não configurado) — efeito ${soundEffectId}`);
    return;
  }

  const url = new URL('/sound-effects/play', SOUND_EFFECT_API_URL);
  url.searchParams.set('guild_id', SOUND_EFFECT_GUILD_ID);
  url.searchParams.set('sound_effect_id', soundEffectId);

  console.log(`[SOUND-EFFECT] Chamando ${url.toString()}`);

  const req = https.request(
    {
      hostname: url.hostname,
      port: url.port || 4443,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'X-API-Secret': SOUND_EFFECT_API_SECRET,
      },
    },
    (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.error(`[SOUND-EFFECT] Falha ao tocar efeito ${soundEffectId} (${res.statusCode}): ${data || 'sem corpo'}`);
        } else {
          console.log(`[SOUND-EFFECT] Efeito ${soundEffectId} tocado com sucesso (${res.statusCode})`);
        }
      });
    }
  );

  req.on('error', (err) => console.error(`[SOUND-EFFECT] Erro ao chamar API para efeito ${soundEffectId}:`, err.message));
  req.end();
}

const discordBroadcastMessageIds = new Map();

function montarMensagemInicioDiscord(nomeBroadcaster) {
  const nome = String(nomeBroadcaster || 'Anônimo');
  return DISCORD_START_MESSAGE_TEMPLATE.replace('{nome}', nome);
}

async function enviarAvisoInicioDiscord(broadcasterId, nomeBroadcaster) {
  if (!DISCORD_NOTIFY_ENABLED || discordBroadcastMessageIds.has(broadcasterId)) return;
  try {
    const message = await discordRequest('POST', `/channels/${DISCORD_CHANNEL_ID}/messages`, {
      content: montarMensagemInicioDiscord(nomeBroadcaster),
    });
    if (message?.id) discordBroadcastMessageIds.set(broadcasterId, message.id);
  } catch (err) {
    console.error('[DISCORD] Erro ao enviar aviso de início:', err.message);
  }
}

async function apagarAvisoInicioDiscord(broadcasterId) {
  const messageId = discordBroadcastMessageIds.get(broadcasterId);
  if (!DISCORD_NOTIFY_ENABLED || !messageId) return;
  discordBroadcastMessageIds.delete(broadcasterId);

  try {
    await discordRequest('DELETE', `/channels/${DISCORD_CHANNEL_ID}/messages/${messageId}`);
  } catch (err) {
    console.error('[DISCORD] Erro ao apagar aviso de início:', err.message);
  }
}

app.get('/icon.svg', (req, res) => {
  res.sendFile(path.join(__dirname, 'icon.svg'));
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

// Cada transmissão é vinculada ao socket de quem a iniciou.
const broadcasters = new Map();

// Nome de cada conectado, usado para exibir quem está assistindo a transmissão
const nomesConectados = new Map();
const espectadoresPorSocket = new Map();

function listaDeEspectadores(broadcasterId) {
  return Array.from(espectadoresPorSocket.entries())
    .filter(([, transmissaoId]) => transmissaoId === broadcasterId)
    .map(([espectadorId]) => nomesConectados.get(espectadorId) || 'Anônimo');
}

function notificarEspectadores() {
  notificarTransmissoes();
}

function notificarTransmissoes() {
  io.emit('broadcasts-list', Array.from(broadcasters, ([id, transmissao]) => ({
    id,
    ...transmissao,
    viewers: listaDeEspectadores(id),
  })));
}

io.on('connection', (socket) => {
  nomesConectados.set(socket.id, 'Anônimo');
  notificarEspectadores();
  socket.emit('broadcasts-list', Array.from(broadcasters, ([id, transmissao]) => ({
    id,
    ...transmissao,
    viewers: listaDeEspectadores(id),
  })));

  // Guarda o nome informado pelo usuário na primeira vez que ele entra
  socket.on('identify', (nome) => {
    const nomeLimpo = String(nome || '').trim().slice(0, 30);
    nomesConectados.set(socket.id, nomeLimpo || 'Anônimo');
    if (broadcasters.has(socket.id)) {
      broadcasters.set(socket.id, {
        ...broadcasters.get(socket.id),
        nome: nomesConectados.get(socket.id),
      });
      notificarTransmissoes();
    }
    notificarEspectadores();
  });

  // Quem inicia o compartilhamento entra na lista de broadcasters.
  socket.on('broadcaster', () => {
    const nomeBroadcaster = nomesConectados.get(socket.id) || 'Anônimo';
    espectadoresPorSocket.delete(socket.id);
    broadcasters.set(socket.id, { nome: nomeBroadcaster, thumbnail: null });
    notificarTransmissoes();
    notificarEspectadores();

    enviarAvisoInicioDiscord(socket.id, nomeBroadcaster);
    tocarSomEfeito(SOUND_EFFECT_START_ID);
  });

  // A miniatura é um frame JPEG reduzido, enviado uma vez pelo emissor ao iniciar.
  socket.on('broadcast-thumbnail', (thumbnail) => {
    if (!broadcasters.has(socket.id)) return;
    if (typeof thumbnail !== 'string' || !thumbnail.startsWith('data:image/jpeg;base64,') || thumbnail.length > 50000) return;

    broadcasters.set(socket.id, {
      ...broadcasters.get(socket.id),
      thumbnail,
    });
    notificarTransmissoes();
  });

  // O broadcaster avisa quando encerra a transmissão sem se desconectar
  // (ex.: clicou em "Parar compartilhamento"), para os espectadores voltarem à tela inicial
  socket.on('stop-broadcast', () => {
    if (!broadcasters.has(socket.id)) return;
    broadcasters.delete(socket.id);
    for (const [espectadorId, transmissaoId] of espectadoresPorSocket) {
      if (transmissaoId === socket.id) espectadoresPorSocket.delete(espectadorId);
    }
    io.emit('broadcaster-disconnected', socket.id);
    notificarTransmissoes();
    notificarEspectadores();
    apagarAvisoInicioDiscord(socket.id);
    tocarSomEfeito(SOUND_EFFECT_STOP_ID);
  });

  // Um espectador escolhe qual transmissão deseja assistir.
  socket.on('watcher', (broadcasterId) => {
    if (broadcasters.has(broadcasterId) && broadcasterId !== socket.id) {
      espectadoresPorSocket.set(socket.id, broadcasterId);
      socket.to(broadcasterId).emit('watcher', socket.id);
      notificarTransmissoes();
      return;
    }
    espectadoresPorSocket.delete(socket.id);
    notificarTransmissoes();
  });

  // Repassa as mensagens de sinalização WebRTC entre os pares
  socket.on('offer', (targetId, description) => {
    socket.to(targetId).emit('offer', socket.id, description);
  });

  socket.on('answer', (targetId, description) => {
    socket.to(targetId).emit('answer', socket.id, description);
  });

  socket.on('candidate', (targetId, candidate) => {
    socket.to(targetId).emit('candidate', socket.id, candidate);
  });

  socket.on('disconnect', () => {
    nomesConectados.delete(socket.id);
    espectadoresPorSocket.delete(socket.id);
    if (broadcasters.delete(socket.id)) {
      for (const [espectadorId, transmissaoId] of espectadoresPorSocket) {
        if (transmissaoId === socket.id) espectadoresPorSocket.delete(espectadorId);
      }
      io.emit('broadcaster-disconnected', socket.id);
      notificarTransmissoes();
      apagarAvisoInicioDiscord(socket.id);
      tocarSomEfeito(SOUND_EFFECT_STOP_ID);
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
