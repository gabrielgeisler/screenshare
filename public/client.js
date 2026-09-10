const socket = io();

const shareBtn = document.getElementById('shareBtn');
const stopBtn = document.getElementById('stopBtn');
const volumeControl = document.getElementById('volumeControl');
const volumeIcon = document.getElementById('volumeIcon');
const volumeSlider = document.getElementById('volumeSlider');
const viewerQualitySelect = document.getElementById('viewerQualitySelect');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const remoteControls = document.getElementById('remoteControls');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const localBox = document.getElementById('localBox');
const remoteBox = document.getElementById('remoteBox');
const statusEl = document.getElementById('status');
const viewersBtn = document.getElementById('viewersBtn');
const viewersCount = document.getElementById('viewersCount');
const viewersPanel = document.getElementById('viewersPanel');
const qualityBtn = document.getElementById('qualityBtn');
const qualityPanel = document.getElementById('qualityPanel');
const viewersList = document.getElementById('viewersList');
const broadcastList = document.getElementById('broadcastList');
const backToListBtn = document.getElementById('backToListBtn');
const broadcastLink = document.getElementById('broadcastLink');
const broadcastLinkAnchor = document.getElementById('broadcastLinkAnchor');
const copyBroadcastLinkBtn = document.getElementById('copyBroadcastLinkBtn');
const themeToggle = document.getElementById('themeToggle');
const themeIcon = document.getElementById('themeIcon');
const matrixCanvas = document.getElementById('matrixCanvas');

function iniciarMatrix() {
  if (!matrixCanvas || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const contexto = matrixCanvas.getContext('2d');
  const caracteres = 'アカサタナハマヤラワ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let colunas = [];
  let largura = 0;
  let altura = 0;
  let frameId;

  function redimensionar() {
    const escala = window.devicePixelRatio || 1;
    largura = window.innerWidth;
    altura = window.innerHeight;
    matrixCanvas.width = largura * escala;
    matrixCanvas.height = altura * escala;
    contexto.setTransform(escala, 0, 0, escala, 0, 0);
    colunas = Array.from({ length: Math.ceil(largura / 18) }, () => Math.random() * -altura / 18);
  }

  function desenhar() {
    contexto.fillStyle = 'rgba(0, 0, 0, 0.08)';
    contexto.fillRect(0, 0, largura, altura);
    contexto.font = '14px monospace';

    colunas.forEach((posicao, indice) => {
      const caractere = caracteres[Math.floor(Math.random() * caracteres.length)];
      const x = indice * 18;
      contexto.fillStyle = indice % 7 === 0 ? 'rgba(190, 255, 210, 0.75)' : 'rgba(45, 190, 95, 0.5)';
      contexto.fillText(caractere, x, posicao * 18);
      colunas[indice] = posicao > altura / 18 + Math.random() * 20 ? 0 : posicao + 0.28;
    });

    frameId = requestAnimationFrame(desenhar);
  }

  redimensionar();
  window.addEventListener('resize', redimensionar);
  desenhar();
  window.addEventListener('pagehide', () => cancelAnimationFrame(frameId), { once: true });
}

iniciarMatrix();

// TURN é essencial para quem está atrás de NAT/firewall restritivo, onde a
// conexão P2P direta via STUN falha; carregado do servidor antes de qualquer oferta
const rtcConfigPromise = fetch('/ice-servers')
  .then((res) => res.json())
  .then((config) => {
    const temTurn = config.iceServers.some((s) => [].concat(s.urls).some((u) => u.startsWith('turn')));
    console.log(temTurn ? '[TURN] Servidor TURN recebido do backend, será tentado se necessário.' : '[TURN] Nenhum TURN configurado no servidor (só STUN) — pode falhar para NAT restritivo.');
    return config;
  })
  .catch((err) => {
    console.warn('Não foi possível carregar os ICE servers, usando padrão:', err);
    return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  });

let localStream = null;
// Uma conexão por espectador, indexada pelo id do socket dele
const peerConnections = {};
// Conexão usada quando este cliente está assistindo a tela de outra pessoa
let watcherConnection = null;
let selectedBroadcasterId = null;
let activeBroadcasts = [];
let thumbnailTimeout = null;
// Candidates ICE que chegam antes da remoteDescription estar pronta ficam aqui até poderem ser aplicados
const pendingCandidates = {};
const broadcastSlugFromUrl = window.location.pathname.split('/').filter(Boolean)[0] || null;
let deveEntrarNaTransmissaoDaUrl = Boolean(broadcastSlugFromUrl);

// Prioriza H.264 na negociação: é o único codec com decodificação por hardware praticamente
// universal, enquanto VP9/AV1 (escolhidos por padrão em alguns navegadores) caem para decodificação
// por software em várias placas de vídeo — o que trava especialmente ao renderizar em tela cheia
function preferirCodec(pc, mimePreferido) {
  if (typeof RTCRtpSender === 'undefined' || !RTCRtpSender.getCapabilities) return;
  const capacidades = RTCRtpSender.getCapabilities('video');
  if (!capacidades) return;

  const preferidos = capacidades.codecs.filter((c) => c.mimeType === mimePreferido);
  if (!preferidos.length) return;
  const outros = capacidades.codecs.filter((c) => c.mimeType !== mimePreferido);
  const ordenados = [...preferidos, ...outros];

  pc.getTransceivers().forEach((t) => {
    const ehVideo = t.sender?.track?.kind === 'video' || t.receiver?.track?.kind === 'video';
    if (ehVideo && t.setCodecPreferences) {
      try {
        t.setCodecPreferences(ordenados);
      } catch (err) {
        console.warn('Não foi possível definir preferência de codec:', err);
      }
    }
  });
}

// Depois que a conexão fecha (conectada/completa), inspeciona o par de candidates escolhido
// via getStats() para confirmar se o TURN (candidate "relay") foi realmente usado ou não
async function diagnosticarCandidatoEscolhido(pc, rotulo) {
  try {
    const stats = await pc.getStats();
    let parEscolhido = null;
    stats.forEach((report) => {
      if (report.type === 'transport' && report.selectedCandidatePairId) {
        parEscolhido = stats.get(report.selectedCandidatePairId);
      } else if (report.type === 'candidate-pair' && report.selected) {
        parEscolhido = report;
      }
    });
    if (!parEscolhido) {
      console.log(`[TURN][${rotulo}] Não foi possível identificar o par de candidates ativo.`);
      return;
    }
    const local = stats.get(parEscolhido.localCandidateId);
    const remoto = stats.get(parEscolhido.remoteCandidateId);
    const usaRelay = local?.candidateType === 'relay' || remoto?.candidateType === 'relay';
    console.log(
      `[TURN][${rotulo}] Candidate local=${local?.candidateType} remoto=${remoto?.candidateType} → ` +
      (usaRelay ? 'USANDO TURN (relay) ✅' : 'conexão direta/STUN, sem TURN (não precisou)')
    );

    // Loga o codec de vídeo realmente negociado, pra confirmar se ficou em H.264 (leve, com
    // decodificação por hardware) ou caiu pra VP8/VP9 (pode pesar bastante em tela cheia)
    stats.forEach((report) => {
      if ((report.type === 'inbound-rtp' || report.type === 'outbound-rtp') && report.kind === 'video' && report.codecId) {
        const codec = stats.get(report.codecId);
        if (codec) console.log(`[codec][${rotulo}] Vídeo usando: ${codec.mimeType}`);
      }
    });
  } catch (err) {
    console.warn(`[TURN][${rotulo}] Falha ao inspecionar candidates:`, err);
  }
}

function adicionarOuEnfileirarCandidate(id, pc, candidate) {
  if (pc && pc.remoteDescription && pc.remoteDescription.type) {
    pc.addIceCandidate(new RTCIceCandidate(candidate)).catch((err) => console.warn('Erro ao adicionar candidate:', err));
  } else {
    (pendingCandidates[id] = pendingCandidates[id] || []).push(candidate);
  }
}

function esvaziarCandidatesPendentes(id, pc) {
  const fila = pendingCandidates[id];
  if (!fila || !fila.length) return;
  delete pendingCandidates[id];
  fila.forEach((candidate) => {
    pc.addIceCandidate(new RTCIceCandidate(candidate)).catch((err) => console.warn('Erro ao adicionar candidate em fila:', err));
  });
}

const QUALITY_PRESETS = {
  high: { maxBitrate: 6000000, scaleResolutionDownBy: 1, maxFramerate: 60 },
  medium: { maxBitrate: 3500000, scaleResolutionDownBy: 1.5, maxFramerate: 60 },
  low: { maxBitrate: 1800000, scaleResolutionDownBy: 2.25, maxFramerate: 30 },
};

// ---------- Autenticação ----------
// A senha já foi validada via HTTP Basic Auth antes de a página carregar,
// então basta liberar a UI e se anunciar como espectador
shareBtn.disabled = false;

function atualizarTema() {
  const escuro = document.documentElement.classList.contains('dark');
  themeIcon.textContent = escuro ? '☀️' : '🌙';
  themeToggle.setAttribute('aria-label', escuro ? 'Alternar modo claro' : 'Alternar modo escuro');
}

themeToggle.addEventListener('click', () => {
  document.documentElement.classList.toggle('dark');
  localStorage.setItem('screenshare_theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  atualizarTema();
});

atualizarTema();

// ---------- Nome do usuário (pedido só na primeira vez, guardado no navegador) ----------

const NAME_STORAGE_KEY = 'screenshare_displayName';
const nomeSalvo = localStorage.getItem(NAME_STORAGE_KEY);

if (nomeSalvo) {
  socket.emit('identify', nomeSalvo);
} else {
  const destino = `${window.location.pathname}${window.location.search}`;
  window.location.replace(`/welcome.html?redirect=${encodeURIComponent(destino)}`);
}

// ---------- Lista de quem está assistindo ----------

const broadcasterViewers = document.getElementById('broadcasterViewers');

function atualizarListaEspectadores() {
  const transmissaoId = selectedBroadcasterId || socket.id;
  const transmissao = activeBroadcasts.find((broadcast) => broadcast.id === transmissaoId);
  const espectadores = transmissao?.viewers || [];
  viewersCount.textContent = espectadores.length;
  viewersList.innerHTML = espectadores.length
    ? espectadores.map((nome) => `<li>${escapeHtml(nome)}</li>`).join('')
    : '<li class="empty">Ninguém assistindo</li>';

  // Quando este cliente é o broadcaster, mostra os nomes acima do botão de parar
  if (localStream) {
    broadcasterViewers.textContent = espectadores.length
      ? `👥 Assistindo agora: ${espectadores.join(', ')}`
      : '👥 Ninguém assistindo';
    broadcasterViewers.classList.remove('hidden');
  } else {
    broadcasterViewers.classList.add('hidden');
  }
}

viewersBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  viewersPanel.classList.toggle('hidden');
  qualityPanel.classList.add('hidden');
  qualityBtn.setAttribute('aria-expanded', 'false');
});

qualityBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  const fechado = qualityPanel.classList.toggle('hidden');
  qualityBtn.setAttribute('aria-expanded', String(!fechado));
  viewersPanel.classList.add('hidden');
});

function escapeHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

// ---------- Transmissões ativas ----------

function renderBroadcasts() {
  const availableBroadcasts = activeBroadcasts.filter((broadcast) => broadcast.id !== socket.id);
  broadcastList.innerHTML = '';

  availableBroadcasts.forEach((broadcast) => {
    const button = document.createElement('button');
    button.className = 'broadcast-card';
    button.type = 'button';
    const preview = document.createElement('img');
    preview.className = 'broadcast-thumbnail';
    preview.alt = `Prévia da transmissão de ${broadcast.nome}`;
    if (broadcast.thumbnail) preview.src = broadcast.thumbnail;

    const name = document.createElement('strong');
    name.textContent = String(broadcast.nome).toLocaleUpperCase('pt-BR');
    const viewers = document.createElement('span');
    viewers.textContent = `${broadcast.viewers?.length || 0} assistindo`;
    const action = document.createElement('span');
    action.textContent = 'Assistir transmissão';
    button.append(preview, name, viewers, action);
    button.addEventListener('click', () => {
      window.location.assign(`/${encodeURIComponent(broadcast.slug)}`);
    });
    broadcastList.appendChild(button);
  });

  if (!localStream && !selectedBroadcasterId) {
    statusEl.textContent = availableBroadcasts.length
      ? `${availableBroadcasts.length} transmissão${availableBroadcasts.length === 1 ? '' : 'ões'} ativa${availableBroadcasts.length === 1 ? '' : 's'}. Escolha uma para assistir.`
      : 'Nenhuma transmissão ativa.';
  }
}

function selectBroadcast(broadcasterId, broadcasterName) {
  ofertaSeq += 1;
  if (watcherConnection) {
    watcherConnection.close();
    watcherConnection = null;
  }
  if (selectedBroadcasterId && selectedBroadcasterId !== broadcasterId) {
    delete pendingCandidates[selectedBroadcasterId];
  }
  selectedBroadcasterId = broadcasterId;
  remoteVideo.srcObject = null;
  atualizarListaEspectadores();
  statusEl.textContent = `Conectando à transmissão de ${broadcasterName}...`;
  socket.emit('watcher', broadcasterId);
}

function mostrarLinkDaTransmissao(slug) {
  const link = `${window.location.origin}/${slug}`;
  broadcastLinkAnchor.href = link;
  broadcastLinkAnchor.textContent = link;
  broadcastLink.classList.remove('hidden');
}

function returnToBroadcasts() {
  deveEntrarNaTransmissaoDaUrl = false;
  window.history.replaceState(null, '', '/');
  ofertaSeq += 1;
  if (watcherConnection) {
    watcherConnection.close();
    watcherConnection = null;
  }
  if (selectedBroadcasterId) delete pendingCandidates[selectedBroadcasterId];
  selectedBroadcasterId = null;
  socket.emit('watcher', null);
  atualizarListaEspectadores();
  remoteVideo.srcObject = null;
  remoteBox.classList.add('hidden');
  volumeControl.classList.add('hidden');
  volumeControl.classList.remove('slider-open');
  viewersPanel.classList.add('hidden');
  qualityPanel.classList.add('hidden');
  qualityBtn.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('watching');
  document.body.classList.remove('controls-hidden');
  window.clearTimeout(hideControlsTimeout);
  renderBroadcasts();
}

socket.on('broadcasts-list', (broadcasts) => {
  activeBroadcasts = Array.isArray(broadcasts) ? broadcasts : [];
  atualizarListaEspectadores();
  renderBroadcasts();

  if (deveEntrarNaTransmissaoDaUrl && !selectedBroadcasterId && !localStream) {
    const transmissao = activeBroadcasts.find((broadcast) => broadcast.slug === broadcastSlugFromUrl);
    if (transmissao) selectBroadcast(transmissao.id, transmissao.nome);
  }
});

function enviarMiniatura() {
  if (!localStream || localVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  const context = canvas.getContext('2d');
  context.drawImage(localVideo, 0, 0, canvas.width, canvas.height);
  socket.emit('broadcast-thumbnail', canvas.toDataURL('image/jpeg', 0.5));
}

function capturarMiniaturaInicial() {
  const agendarCaptura = () => {
    window.clearTimeout(thumbnailTimeout);
    thumbnailTimeout = window.setTimeout(enviarMiniatura, 1000);
  };

  if (localVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    agendarCaptura();
    return;
  }
  localVideo.addEventListener('loadeddata', agendarCaptura, { once: true });
}

// ---------- Quem compartilha a tela (broadcaster) ----------

shareBtn.addEventListener('click', async () => {
  try {
    // systemAudio: 'include' pede ao Chrome pra já vir com "Compartilhar áudio" marcado;
    // só funciona ao escolher "Toda a tela" ou uma aba — janelas específicas não suportam áudio
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 60, max: 60 },
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      systemAudio: 'include',
    });
    localVideo.srcObject = localStream;

    // O foco principal desta ferramenta é transmitir vídeos, então manter o movimento fluido
    // é mais importante que preservar a resolução durante uma oscilação de rede.
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack && 'contentHint' in videoTrack) {
      videoTrack.contentHint = 'motion';
    }
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack && 'contentHint' in audioTrack) {
      audioTrack.contentHint = 'music';
    }

    // Para automaticamente se o usuário parar pela barra do navegador
    videoTrack?.addEventListener('ended', stopSharing);

    socket.emit('broadcaster', ({ slug }) => mostrarLinkDaTransmissao(slug));
    selectedBroadcasterId = null;
    shareBtn.disabled = true;
    shareBtn.classList.add('hidden');
    stopBtn.disabled = false;
    stopBtn.classList.remove('hidden');
    localBox.classList.remove('hidden');
    remoteBox.classList.add('hidden');
    capturarMiniaturaInicial();
    statusEl.textContent = mensagemStatusAudio(localStream);
  } catch (err) {
    console.error('Erro ao capturar a tela:', err);
    statusEl.textContent = 'Não foi possível iniciar o compartilhamento.';
  }
});

stopBtn.addEventListener('click', stopSharing);

// O áudio de outros apps (fora do navegador) só é capturado pelo Chrome/Edge no Windows,
// e mesmo assim só ao escolher "Toda a tela" — é limitação do navegador/SO, não do código
function ehMacOS() {
  return /Mac OS X/.test(navigator.userAgent) && !/iPhone|iPad/.test(navigator.userAgent);
}

function nomeDoNavegador() {
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua) && !/Chrome|Chromium|CriOS|Edg\//.test(ua)) return 'Safari';
  return 'chromium';
}

function mensagemStatusAudio(stream) {
  if (stream.getAudioTracks().length) {
    return 'Você está compartilhando sua tela.';
  }

  // Safari e Firefox no macOS não implementam captura de áudio via getDisplayMedia de jeito
  // nenhum (nem tela inteira, nem aba) — é limitação do navegador nesse SO, não dá pra contornar
  const navegador = nomeDoNavegador();
  if (ehMacOS() && (navegador === 'Safari' || navegador === 'Firefox')) {
    return `Você está compartilhando sua tela (sem áudio: o ${navegador} no macOS não suporta capturar áudio ao compartilhar tela — use Chrome/Edge/Brave para ter som).`;
  }

  const displaySurface = stream.getVideoTracks()[0]?.getSettings().displaySurface;
  if (displaySurface === 'window') {
    return 'Você está compartilhando sua tela (sem áudio: compartilhar uma janela específica nunca captura som; escolha "Toda a tela" ou uma aba).';
  }
  return 'Você está compartilhando sua tela (sem áudio: seu navegador/sistema operacional não suporta capturar o som do computador aqui).';
}

function stopSharing() {
  if (!localStream) return;

  window.clearTimeout(thumbnailTimeout);
  thumbnailTimeout = null;
  localStream.getTracks().forEach((track) => track.stop());
  localStream = null;
  localVideo.srcObject = null;
  broadcastLink.classList.add('hidden');

  Object.values(peerConnections).forEach((pc) => pc.close());
  for (const id in peerConnections) {
    delete peerConnections[id];
    delete pendingCandidates[id];
  }

  // Avisa o servidor para repassar aos espectadores que a transmissão acabou
  socket.emit('stop-broadcast');

  shareBtn.disabled = false;
  shareBtn.classList.remove('hidden');
  stopBtn.disabled = true;
  stopBtn.classList.add('hidden');
  localBox.classList.add('hidden');
  renderBroadcasts();
  statusEl.textContent = 'Compartilhamento encerrado.';
}

// Conta a tentativa de negociação mais recente por espectador; usado para descartar
// tentativas antigas que só terminam de "esperar" depois de uma mais nova já ter assumido
// (evita duas RTCPeerConnection enviando a mesma stream ao mesmo tempo para o mesmo peer)
const watcherNegotiationSeq = {};

socket.on('watcher', async (watcherId) => {
  if (!localStream) return;

  const minhaSeq = (watcherNegotiationSeq[watcherId] = (watcherNegotiationSeq[watcherId] || 0) + 1);

  // Se já existia uma conexão antiga pra esse espectador (ex.: reconexão rápida), fecha antes de recriar
  if (peerConnections[watcherId]) {
    peerConnections[watcherId].close();
    delete peerConnections[watcherId];
  }

  const rtcConfig = await rtcConfigPromise;

  // Uma tentativa mais nova pode ter chegado enquanto esperávamos os ICE servers; descarta esta
  if (watcherNegotiationSeq[watcherId] !== minhaSeq) return;

  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections[watcherId] = pc;

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  preferirCodec(pc, 'video/H264');

  // Começa no teto; cada espectador pode reduzir sua própria resolução e bitrate depois
  pc.getSenders().forEach((sender) => {
    if (sender.track && sender.track.kind === 'video') {
      try {
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = QUALITY_PRESETS.high.maxBitrate;
        params.encodings[0].scaleResolutionDownBy = QUALITY_PRESETS.high.scaleResolutionDownBy;
        params.encodings[0].maxFramerate = QUALITY_PRESETS.high.maxFramerate;
        params.degradationPreference = 'balanced';
        sender.setParameters(params).catch((err) => console.warn('Erro ao definir parâmetros do sender:', err));
      } catch (err) {
        console.warn('Não foi possível configurar parâmetros de codificação:', err);
      }
    }
  });

  const tiposGerados = new Set();
  const temTurnConfigurado = rtcConfig.iceServers.some((s) => [].concat(s.urls).some((u) => u.startsWith('turn')));

  pc.onicecandidate = (event) => {
    if (event.candidate && peerConnections[watcherId] === pc) {
      tiposGerados.add(event.candidate.type);
      console.log(`[TURN][broadcaster→${watcherId}] candidate gerado: ${event.candidate.type}`);
      socket.emit('candidate', watcherId, event.candidate);
    }
  };

  pc.onicegatheringstatechange = () => {
    if (pc.iceGatheringState === 'complete' && temTurnConfigurado && !tiposGerados.has('relay')) {
      console.warn(`[TURN][broadcaster→${watcherId}] TURN está configurado mas NENHUM candidate relay foi gerado. ` +
        'Verifique se o TURN_URL/porta estão acessíveis, e se usuário/senha estão corretos.');
    }
  };

  // Ajuda a diagnosticar espectadores que não conseguem conectar (ex.: falta de TURN);
  // restartIce() aqui não adiantaria, pois é o espectador quem vai pedir uma nova oferta
  pc.oniceconnectionstatechange = () => {
    console.log(`[broadcaster] ICE state com ${watcherId}: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      diagnosticarCandidatoEscolhido(pc, `broadcaster→${watcherId}`);
    }
    if (pc.iceConnectionState === 'failed') {
      pc.close();
      delete peerConnections[watcherId];
      delete pendingCandidates[watcherId];
    }
  };

  pc.createOffer()
    .then((offer) => pc.setLocalDescription(offer))
    .then(() => {
      if (peerConnections[watcherId] === pc) socket.emit('offer', watcherId, pc.localDescription);
    })
    .catch((err) => console.error('Erro ao criar oferta para', watcherId, err));
});

function aplicarQualidadeNoSender(sender, preset) {
  const params = sender.getParameters();
  if (!params.encodings || !params.encodings.length) params.encodings = [{}];
  params.encodings[0].maxBitrate = preset.maxBitrate;
  params.encodings[0].scaleResolutionDownBy = preset.scaleResolutionDownBy;
  params.encodings[0].maxFramerate = preset.maxFramerate;
  return sender.setParameters(params);
}

socket.on('quality-request', (watcherId, quality) => {
  const pc = peerConnections[watcherId];
  const preset = QUALITY_PRESETS[quality];
  if (!pc || !preset) return;

  pc.getSenders()
    .filter((sender) => sender.track?.kind === 'video')
    .forEach((sender) => aplicarQualidadeNoSender(sender, preset)
      .catch((err) => console.warn('Erro ao aplicar qualidade solicitada pelo espectador:', err)));
});

socket.on('answer', (watcherId, description) => {
  const pc = peerConnections[watcherId];
  if (!pc) return;
  pc.setRemoteDescription(description)
    .then(() => esvaziarCandidatesPendentes(watcherId, pc))
    .catch((err) => console.error('Erro ao aplicar answer de', watcherId, err));
});

socket.on('watcher-disconnected', (watcherId) => {
  const pc = peerConnections[watcherId];
  if (pc) {
    pc.close();
    delete peerConnections[watcherId];
  }
  delete pendingCandidates[watcherId];
});

// ---------- Quem assiste a tela (watcher) ----------

// Mesma lógica de descarte de tentativas antigas usada no lado do broadcaster
let ofertaSeq = 0;

socket.on('offer', async (broadcasterId, description) => {
  if (broadcasterId !== selectedBroadcasterId) return;
  const minhaSeq = ++ofertaSeq;

  // Se já havía uma conexão anterior (ex.: nova transmissão começando), fecha antes de recriar
  if (watcherConnection) {
    watcherConnection.close();
    watcherConnection = null;
  }

  const rtcConfig = await rtcConfigPromise;

  // Uma oferta mais nova pode ter chegado enquanto esperávamos os ICE servers; descarta esta
  if (minhaSeq !== ofertaSeq || broadcasterId !== selectedBroadcasterId) return;

  const pc = new RTCPeerConnection(rtcConfig);
  watcherConnection = pc;

  socket.emit('quality-request', broadcasterId, viewerQualitySelect.value);

  const tiposGeradosWatcher = new Set();
  const temTurnConfiguradoWatcher = rtcConfig.iceServers.some((s) => [].concat(s.urls).some((u) => u.startsWith('turn')));

  pc.ontrack = (event) => {
    if (watcherConnection !== pc) return;

    // Elimina o buffer de atraso (playout delay) para renderizar quadros recebidos instantaneamente e eliminar micro-travamentos
    if (event.receiver && 'playoutDelayHint' in event.receiver) {
      event.receiver.playoutDelayHint = 0.1;
    }

    remoteVideo.srcObject = event.streams[0];
    remoteBox.classList.remove('hidden');
    localBox.classList.add('hidden');
    document.body.classList.add('watching');
    statusEl.textContent = 'Assistindo à tela compartilhada.';
    // Sempre exibe o controle de volume; áudio/vídeo podem chegar em eventos separados,
    // então não dá para confiar em getAudioTracks() no primeiro disparo do ontrack
    volumeControl.classList.remove('hidden');
    // Garante que o volume comece em 100% e sem mudo ao entrar na transmissão
    remoteVideo.muted = false;
    remoteVideo.volume = 1;
    volumeSlider.value = 100;
    volumeIcon.textContent = '🔊';
    // Inicia o ciclo de auto-ocultar dos controles
    showControls();
    // Alguns navegadores (ex.: aba anônima) bloqueiam o autoplay; força o play manualmente
    remoteVideo.play().catch((err) => console.warn('Falha ao iniciar o vídeo automaticamente:', err));
  };

  pc.onicecandidate = (event) => {
    if (event.candidate && watcherConnection === pc) {
      tiposGeradosWatcher.add(event.candidate.type);
      console.log(`[TURN][watcher] candidate gerado: ${event.candidate.type}`);
      socket.emit('candidate', broadcasterId, event.candidate);
    }
  };

  pc.onicegatheringstatechange = () => {
    if (pc.iceGatheringState === 'complete' && temTurnConfiguradoWatcher && !tiposGeradosWatcher.has('relay')) {
      console.warn('[TURN][watcher] TURN está configurado mas NENHUM candidate relay foi gerado. ' +
        'Verifique se o TURN_URL/porta estão acessíveis, e se usuário/senha estão corretos.');
    }
  };

  // Quem assiste nunca cria ofertas, então restartIce() aqui não teria efeito nenhum;
  // a forma que realmente funciona é fechar e pedir uma oferta nova do zero ao broadcaster
  pc.oniceconnectionstatechange = () => {
    if (watcherConnection !== pc) return;
    console.log(`[watcher] ICE state: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      diagnosticarCandidatoEscolhido(pc, 'watcher');
    }
    if (pc.iceConnectionState === 'failed') {
      statusEl.textContent = 'Conexão falhou. Reconectando automaticamente...';
      pc.close();
      watcherConnection = null;
      if (selectedBroadcasterId) socket.emit('watcher', selectedBroadcasterId);
    }
  };

  pc
    .setRemoteDescription(description)
    .then(() => {
      if (watcherConnection !== pc) throw new Error('Oferta substituída por uma tentativa mais nova.');
      esvaziarCandidatesPendentes(broadcasterId, pc);
      return pc.createAnswer();
    })
    .then((answer) => pc.setLocalDescription(answer))
    .then(() => {
      if (watcherConnection === pc) socket.emit('answer', broadcasterId, pc.localDescription);
    })
    .catch((err) => console.error('Erro ao responder oferta de', broadcasterId, err));
});

// ---------- Auto-ocultar controles ao assistir ----------
// Esconde os botões depois de alguns segundos sem interação; reaparecem ao mover o mouse/tocar na tela
const CONTROLS_HIDE_DELAY = 3000;
let hideControlsTimeout = null;

function scheduleHideControls() {
  if (!document.body.classList.contains('watching')) return;
  window.clearTimeout(hideControlsTimeout);
  hideControlsTimeout = window.setTimeout(() => {
    document.body.classList.add('controls-hidden');
  }, CONTROLS_HIDE_DELAY);
}

function showControls() {
  if (!document.body.classList.contains('watching')) return;
  document.body.classList.remove('controls-hidden');
  scheduleHideControls();
}

['mousemove', 'mousedown', 'touchstart', 'touchmove', 'keydown'].forEach((evt) => {
  document.addEventListener(evt, showControls, { passive: true });
});

viewerQualitySelect.addEventListener('change', () => {
  if (selectedBroadcasterId) {
    socket.emit('quality-request', selectedBroadcasterId, viewerQualitySelect.value);
  }
});

socket.on('candidate', (id, candidate) => {
  const pc = peerConnections[id] || (id === selectedBroadcasterId ? watcherConnection : null);
  adicionarOuEnfileirarCandidate(id, pc, candidate);
});

socket.on('broadcaster-disconnected', (broadcasterId) => {
  if (broadcasterId !== selectedBroadcasterId) return;
  returnToBroadcasts();
  statusEl.textContent = 'O compartilhamento de tela foi encerrado.';
});

volumeSlider.addEventListener('input', () => {
  const value = Number(volumeSlider.value);
  remoteVideo.muted = value === 0;
  remoteVideo.volume = value / 100;
  volumeIcon.textContent = value === 0 ? '🔇' : '🔊';
  remoteVideo.play().catch((err) => console.warn('Falha ao ativar o som:', err));
});

// Guarda o último volume não-zero para restaurar ao desmutar pelo ícone
let lastVolume = Number(volumeSlider.value) || 50;

// Roda do mouse sobre o vídeo remoto ajusta o volume sem precisar clicar no slider
let volumeWheelHideTimeout = null;
remoteVideo.addEventListener('wheel', (event) => {
  if (!selectedBroadcasterId) return;
  event.preventDefault();

  const passo = 5;
  const atual = Number(volumeSlider.value);
  const novo = Math.min(100, Math.max(0, atual + (event.deltaY < 0 ? passo : -passo)));
  volumeSlider.value = novo;
  remoteVideo.muted = novo === 0;
  remoteVideo.volume = novo / 100;
  volumeIcon.textContent = novo === 0 ? '🔇' : '🔊';
  remoteVideo.play().catch((err) => console.warn('Falha ao ativar o som:', err));

  // Mostra o slider brevemente como feedback visual e some de novo em seguida
  volumeControl.classList.remove('hidden');
  volumeControl.classList.add('slider-open');
  window.clearTimeout(volumeWheelHideTimeout);
  volumeWheelHideTimeout = window.setTimeout(() => volumeControl.classList.remove('slider-open'), 1200);
}, { passive: false });

volumeIcon.addEventListener('click', (event) => {
  event.stopPropagation();
  // O clique no ícone apenas abre/fecha o slider; mutar/desmutar é feito pelo
  // próprio slider (0 = mudo) ou pelos controles nativos em tela cheia
  volumeControl.classList.toggle('slider-open');
});

fullscreenBtn.addEventListener('click', () => {
  // Deixa só o <video> em tela cheia (não a caixa) para o navegador usar o caminho
  // acelerado por GPU do vídeo; fullscreen na caixa força composição por software e trava
  if (remoteVideo.requestFullscreen) {
    remoteVideo.requestFullscreen().catch((err) => console.warn('Falha ao entrar em tela cheia:', err));
  }
});

backToListBtn.addEventListener('click', returnToBroadcasts);

copyBroadcastLinkBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(broadcastLinkAnchor.href);
    copyBroadcastLinkBtn.textContent = 'Link copiado';
    window.setTimeout(() => {
      copyBroadcastLinkBtn.textContent = 'Copiar link';
    }, 2000);
  } catch (err) {
    console.warn('Não foi possível copiar o link:', err);
  }
});

// Como o vídeo some da tela normal quando é ele o elemento em fullscreen, usamos os
// controles nativos do navegador (volume, sair da tela cheia) enquanto estiver nesse modo
document.addEventListener('fullscreenchange', () => {
  const emTelaCheia = document.fullscreenElement === remoteVideo;
  remoteVideo.controls = emTelaCheia;
  if (!emTelaCheia) {
    // Sincroniza o slider com o volume/mudo que o usuário pode ter ajustado nos controles nativos
    volumeSlider.value = Math.round(remoteVideo.muted ? 0 : remoteVideo.volume * 100);
    volumeIcon.textContent = remoteVideo.muted || remoteVideo.volume === 0 ? '🔇' : '🔊';
  }
});

// Fecha os painéis de espectadores e qualidade ao clicar fora deles
document.addEventListener('click', (event) => {
  if (!viewersPanel.classList.contains('hidden') && !viewersPanel.contains(event.target) && event.target !== viewersBtn) {
    viewersPanel.classList.add('hidden');
  }
  if (!qualityPanel.classList.contains('hidden') && !qualityPanel.contains(event.target) && event.target !== qualityBtn) {
    qualityPanel.classList.add('hidden');
    qualityBtn.setAttribute('aria-expanded', 'false');
  }
  if (volumeControl.classList.contains('slider-open') && !volumeControl.contains(event.target)) {
    volumeControl.classList.remove('slider-open');
  }
});
