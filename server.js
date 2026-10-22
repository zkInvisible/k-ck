require('dotenv').config();

const axios = require('axios');
const express = require('express');
const { randomUUID } = require('crypto');
const WebSocket = require('ws');

// --- AYARLAR ---
const TIME_WINDOW_MS = Number(process.env.TIME_WINDOW_SECONDS || 15) * 1000;
const MESSAGE_THRESHOLD = Number(process.env.MESSAGE_THRESHOLD || 5);
const COOLDOWN_MS = Number(process.env.COOLDOWN_SECONDS || 15) * 1000;
const ALERT_LIMIT = Number(process.env.ALERT_LIMIT || 1);
const RESET_TIME_MS = Number(process.env.RESET_TIME_SECONDS || 300) * 1000;
const KICK_ORIGIN = 'https://kick.com';
const REALTIME_BASE = 'https://web.kick.com/api/v1/realtime';

let messageHistory = [];
const cooldowns = new Map();
const alertCounts = new Map();

function positiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} pozitif bir sayı olmalı.`);
  }
}

positiveNumber(TIME_WINDOW_MS, 'TIME_WINDOW_SECONDS');
positiveNumber(MESSAGE_THRESHOLD, 'MESSAGE_THRESHOLD');
positiveNumber(COOLDOWN_MS, 'COOLDOWN_SECONDS');
positiveNumber(ALERT_LIMIT, 'ALERT_LIMIT');
positiveNumber(RESET_TIME_MS, 'RESET_TIME_SECONDS');

async function sendTelegramMessage(keyword, count) {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.error('[Telegram] TELEGRAM_TOKEN veya TELEGRAM_CHAT_ID eksik.');
    return;
  }

  // parse_mode özellikle kullanılmıyor: çekiliş anahtarındaki _, *, [ gibi
  // karakterler Telegram Markdown ayrıştırmasını bozup mesajı reddedebiliyordu.
  const text = `🚨 Çekiliş aktif key: ${keyword}\n${count} farklı kullanıcı yazdı.`;

  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text, disable_web_page_preview: true },
      { timeout: 15000 }
    );
    console.log(`[Telegram] Mesaj gönderildi: ${keyword}`);
  } catch (error) {
    console.error('[Telegram] Mesaj gönderilemedi:', error.response?.data || error.message);
  }
}

function cleanOldMessages(now) {
  messageHistory = messageHistory.filter((message) => now - message.timestamp <= TIME_WINDOW_MS);
}

function processNewMessage(text, senderId) {
  const now = Date.now();
  const normalizedText = String(text).trim().toLocaleLowerCase('tr-TR');
  if (!normalizedText) return;

  const isTime = /^\d{1,2}:\d{2}$/.test(normalizedText);
  const isJustPunctuation = /^[^\p{L}\p{N}]+$/u.test(normalizedText) && normalizedText.length <= 3;
  const isSystemMessage =
    normalizedText === 'yeni mesajlar' ||
    normalizedText === 'live' ||
    normalizedText === 'clip' ||
    normalizedText.includes('bir mesaj gönderin');

  if (isTime || isJustPunctuation || isSystemMessage) return;

  messageHistory.push({ text: normalizedText, senderId: String(senderId), timestamp: now });
  cleanOldMessages(now);

  const matchingMessages = messageHistory.filter((message) => message.text === normalizedText);
  const count = new Set(matchingMessages.map((message) => message.senderId)).size;
  if (count < MESSAGE_THRESHOLD) return;

  const lastAlerted = cooldowns.get(normalizedText) || 0;
  if (now - lastAlerted > RESET_TIME_MS) alertCounts.set(normalizedText, 0);
  if (now - lastAlerted <= COOLDOWN_MS) return;

  const currentAlerts = alertCounts.get(normalizedText) || 0;
  if (currentAlerts < ALERT_LIMIT) {
    console.log(`[Bot] SPAM YAKALANDI: ${normalizedText} (${count} farklı kullanıcı)`);
    void sendTelegramMessage(String(text).trim(), count);
    alertCounts.set(normalizedText, currentAlerts + 1);
  }
  cooldowns.set(normalizedText, now);
}

function kickHeaders() {
  return {
    Accept: 'application/json, text/plain, */*',
    Origin: KICK_ORIGIN,
    Referer: `${KICK_ORIGIN}/`,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      'Chrome/143.0.0.0 Safari/537.36',
    'x-app-platform': 'web'
  };
}

async function resolveChannel() {
  const slug = (process.env.KICK_CHANNEL_NAME || '').trim().toLowerCase();
  if (!slug) throw new Error('KICK_CHANNEL_NAME eksik.');

  const response = await axios.get(`${KICK_ORIGIN}/api/v2/channels/${encodeURIComponent(slug)}`, {
    headers: kickHeaders(),
    timeout: 20000
  });

  const channelId = response.data?.id;
  const chatroomId = response.data?.chatroom?.id;
  if (!channelId || !chatroomId) throw new Error('Kick kanal veya sohbet odası ID döndürmedi.');

  const configuredChatroomId = process.env.KICK_CHATROOM_ID;
  if (configuredChatroomId && String(configuredChatroomId) !== String(chatroomId)) {
    console.warn(
      `[Kick] KICK_CHATROOM_ID eski (${configuredChatroomId}); güncel değer ${chatroomId}. ` +
        'Otomatik bulunan değer kullanılacak.'
    );
  }

  return { slug, channelId: String(channelId), chatroomId: String(chatroomId) };
}

async function postRealtime(path, data) {
  const response = await axios.post(`${REALTIME_BASE}${path}`, data, {
    headers: kickHeaders(),
    timeout: 20000
  });
  return response.data;
}

async function negotiateConnection(channelId, clientId) {
  const payload = await postRealtime(`/channels/${channelId}/chat/connection`, {
    client: { id: clientId, type: 'web' },
    capabilities: {
      accepted_providers: [{ provider: 'centrifugo' }, { provider: 'pusher' }]
    }
  });

  const connection = payload?.data?.connections?.[0];
  if (!connection?.provider || !connection?.credentials) {
    throw new Error('Kick geçerli bir gerçek zamanlı bağlantı döndürmedi.');
  }
  return connection;
}

async function getConnectionToken(clientId) {
  const payload = await postRealtime('/auth/connection', { client_id: clientId });
  const token = payload?.data?.token;
  if (!token || typeof token !== 'string') throw new Error('Kick bağlantı tokenı döndürmedi.');
  return token;
}

class KickRealtimeChat {
  constructor() {
    this.socket = null;
    this.stopped = false;
    this.reconnectTimer = null;
    this.refreshTimer = null;
    this.reconnectAttempt = 0;
    this.nextCommandId = 0;
    this.pendingCommands = new Map();
  }

  async start() {
    this.stopped = false;
    await this.connect();
  }

  async connect() {
    try {
      const channel = await resolveChannel();
      const clientId = randomUUID();
      const connection = await negotiateConnection(channel.channelId, clientId);

      if (connection.provider !== 'centrifugo') {
        throw new Error(`Desteklenmeyen Kick sağlayıcısı: ${connection.provider}`);
      }

      const url = connection.credentials.url;
      if (!/^wss:\/\/realtime\.[a-z0-9-]+\.platform\.kick\.com\/connection\/websocket$/i.test(url)) {
        throw new Error('Kick güvenilmeyen bir WebSocket adresi döndürdü.');
      }

      const token = await getConnectionToken(clientId);
      this.openSocket(url, token, clientId, channel);
    } catch (error) {
      console.error('[Kick] Bağlantı hazırlığı başarısız:', error.response?.data || error.message);
      this.scheduleReconnect();
    }
  }

  openSocket(url, token, clientId, channel) {
    const socket = new WebSocket(url, { origin: KICK_ORIGIN, handshakeTimeout: 20000 });
    this.socket = socket;
    this.nextCommandId = 0;
    this.pendingCommands.clear();

    socket.on('open', () => {
      console.log(`[Kick] Centrifugo bağlantısı açıldı (${channel.slug}, oda ${channel.chatroomId}).`);
      this.sendCommand('connect', { token, name: 'kick-alert', version: '2' });
    });

    socket.on('message', (buffer) => {
      const lines = buffer.toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          this.handleFrame(JSON.parse(line), clientId, channel);
        } catch (error) {
          console.error('[Kick] Geçersiz gerçek zamanlı veri:', error.message);
        }
      }
    });

    socket.on('error', (error) => console.error('[Kick] WebSocket hatası:', error.message));
    socket.on('close', (code, reason) => {
      if (socket !== this.socket) return;
      this.clearRefreshTimer();
      this.pendingCommands.clear();
      console.warn(`[Kick] Bağlantı kapandı (${code}: ${reason.toString() || 'neden yok'}).`);
      this.scheduleReconnect();
    });
  }

  send(payload) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
  }

  sendCommand(kind, data) {
    const id = ++this.nextCommandId;
    this.pendingCommands.set(id, kind);
    this.send({ id, [kind]: data });
  }

  handleFrame(frame, clientId, channel) {
    // Centrifugo ping: boş JSON gelir, boş JSON ile cevaplanır.
    if (frame && Object.keys(frame).length === 0) {
      this.send({});
      return;
    }

    if (frame.id) {
      const command = this.pendingCommands.get(frame.id);
      this.pendingCommands.delete(frame.id);
      if (frame.error) throw new Error(`Centrifugo ${command || 'komut'} reddedildi: ${JSON.stringify(frame.error)}`);

      if (command === 'connect') {
        this.reconnectAttempt = 0;
        this.scheduleTokenRefresh(frame.connect, clientId);
        this.sendCommand('subscribe', { channel: `chatrooms.${channel.chatroomId}.v2` });
      } else if (command === 'subscribe') {
        console.log('[Kick] Sohbet aboneliği aktif; mesajlar dinleniyor.');
      } else if (command === 'refresh') {
        this.scheduleTokenRefresh(frame.refresh, clientId);
      }
      return;
    }

    const push = frame?.push;
    if (push?.disconnect || push?.unsubscribe) {
      throw new Error(`Kick akışı kapattı: ${JSON.stringify(push.disconnect || push.unsubscribe)}`);
    }

    const publication = push?.pub?.data;
    if (!publication) return;
    const event = typeof publication === 'string' ? JSON.parse(publication) : publication;
    if (event?.event !== 'App\\Events\\ChatMessageEvent') return;

    const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    if (data?.content && data?.sender?.id != null) {
      processNewMessage(data.content, data.sender.id);
    }
  }

  scheduleTokenRefresh(lease, clientId) {
    this.clearRefreshTimer();
    if (!lease?.expires || !Number.isFinite(lease.ttl) || lease.ttl <= 0) return;

    this.refreshTimer = setTimeout(async () => {
      try {
        const token = await getConnectionToken(clientId);
        this.sendCommand('refresh', { token });
      } catch (error) {
        console.error('[Kick] Token yenilenemedi:', error.response?.data || error.message);
        this.socket?.close(4000, 'token refresh failed');
      }
    }, Math.max(1000, lease.ttl * 800));
  }

  clearRefreshTimer() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.reconnectAttempt++, 5));
    console.log(`[Kick] ${Math.round(delay / 1000)} saniye sonra yeniden bağlanılacak.`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearRefreshTimer();
    this.socket?.close(1000, 'shutdown');
  }
}

const kickChat = new KickRealtimeChat();
void kickChat.start();

// --- RENDER WEB SUNUCUSU ---
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (_req, res) => {
  res.send('Kick Tracker Bot is running. Check logs for realtime subscription status.');
});

const httpServer = app.listen(port, () => {
  console.log(`[Bot] Express sunucusu ${port} portunda hazır.`);
});

function shutdown(signal) {
  console.log(`[Bot] ${signal} alındı, kapatılıyor.`);
  kickChat.stop();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { processNewMessage, KickRealtimeChat };
