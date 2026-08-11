require('dotenv').config();
const Pusher = require('pusher-js');
const axios = require('axios');
const express = require('express');

// --- AYARLAR ---
const TIME_WINDOW_MS = 15 * 1000; // 15 saniye
const MESSAGE_THRESHOLD = 5; // 5 mesaj
const COOLDOWN_MS = 10 * 1000; // 10 saniye bekleme süresi
const ALERT_LIMIT = 1; // Bir kelime için max atılacak bildirim
const RESET_TIME_MS = 5 * 60 * 1000; // 5 dakika sessizlik sonrası sıfırlama

let messageHistory = [];
let cooldowns = {};
let alertCount = {}; // Kelime bazlı bildirim sayacı

// Telegram'a Mesaj Gönderme Fonksiyonu
async function sendTelegramMessage(keyword, count) {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const channelName = process.env.KICK_CHANNEL_NAME || "Yayıncı";

  if (!token || !chatId) {
    console.error("HATA: Telegram Token veya Chat ID eksik! Lütfen .env dosyanızı kontrol edin.");
    return;
  }

  const text = `🚨 Çekiliş aktif key: ${keyword}`;

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
    console.log(`[Telegram] Başarıyla mesaj gönderildi: ${keyword}`);
  } catch (error) {
    console.error("[Telegram Hata] Mesaj gönderilemedi:", error.response ? error.response.data : error.message);
  }
}

// Eski mesajları temizleme
function cleanOldMessages(now) {
  messageHistory = messageHistory.filter(msg => now - msg.timestamp <= TIME_WINDOW_MS);
}

// Yeni mesaj geldiğinde işleme
function processNewMessage(text, senderId) {
  const now = Date.now();
  const lowerText = text.trim().toLowerCase();

  if (!lowerText) return;

  // Filtrelemeler (Saat, noktalama, vb.)
  const isTime = /^\d{1,2}:\d{2}$/.test(lowerText);
  const isJustPunctuation = /^[^a-zA-Z0-9çğıöşüÇĞİÖŞÜ]+$/.test(lowerText) && lowerText.length <= 3;
  const isSystemMsg = lowerText === "yeni mesajlar" || lowerText === "live" || lowerText === "clip" || lowerText.includes("bir mesaj gönderin");

  if (isTime || isJustPunctuation || isSystemMsg) return;

  // (Render loglarını yormamak adına örnek chat logu yazdırılması kaldırıldı)

  // Mesajı hafızaya ekle (Gönderen kişinin eşsiz ID'si ile birlikte)
  messageHistory.push({ text: lowerText, senderId: senderId, timestamp: now });
  cleanOldMessages(now);

  // ÖNEMLİ DÜZELTME: Aynı kelimeyi yazan FARKLI (benzersiz) kişileri sayar
  const messagesWithText = messageHistory.filter(msg => msg.text === lowerText);
  const count = new Set(messagesWithText.map(msg => msg.senderId)).size;

  if (count >= MESSAGE_THRESHOLD) {
    const lastAlerted = cooldowns[lowerText] || 0;

    // Eğer bu kelime için en son alarmın üzerinden 5 dakika (RESET_TIME_MS) geçtiyse limiti sıfırla
    if (now - lastAlerted > RESET_TIME_MS) {
      alertCount[lowerText] = 0;
    }

    // Sadece cooldown süresi geçtiyse tetikle
    if (now - lastAlerted > COOLDOWN_MS) {
      const currentAlerts = alertCount[lowerText] || 0;

      if (currentAlerts < ALERT_LIMIT) {
        console.log(`[Bot] SPAM YAKALANDI: ${lowerText} (${count} kez)`);

        // Telegram'a gönder
        sendTelegramMessage(text.trim(), count);

        alertCount[lowerText] = currentAlerts + 1;
      }

      // Cooldown'a al (sürekli spam devam ederse süreyi ileri atar, limiti aşsa da 5 dk sessizlik bekler)
      cooldowns[lowerText] = now;
    }
  }
}

// --- KICK PUSHER BAĞLANTISI ---
const chatroomId = process.env.KICK_CHATROOM_ID;
if (!chatroomId) {
  console.error("HATA: KICK_CHATROOM_ID .env dosyasında bulunamadı! Lütfen walkthrough dosyasındaki adımları izleyin.");
  process.exit(1);
}

console.log(`[Bot] Kick Pusher sunucusuna bağlanılıyor... (Oda ID: ${chatroomId})`);

// Kick'in güncel public Pusher anahtarı
const pusher = new Pusher('32cbd69e4b950bf97679', {
  cluster: 'us2',
  forceTLS: true,
  activityTimeout: 120000 // Bağlantının uzun süre uyanık kalması için
});

const channel = pusher.subscribe(`chatrooms.${chatroomId}.v2`);

channel.bind('App\\Events\\ChatMessageEvent', (data) => {
  // data.content içerisinde metin, data.sender.id içerisinde gönderen kişinin eşsiz ID'si bulunur
  if (data && data.content && data.sender && data.sender.id) {
    processNewMessage(data.content, data.sender.id);
  }
});

// Başlangıç bildirimi (Gereksiz restart bildirimlerini engellemek için) kaldırıldı

pusher.connection.bind('error', (err) => {
  console.error("[Bot] ❌ Pusher bağlantı hatası:", err);
});


// --- RENDER (WEB SUNUCUSU) İÇİN KEEP-ALIVE ---
// Render gibi sistemler bir web portunun dinlenmesini şart koşar, yoksa botu çöktü sanır.
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Kick Tracker Bot is Running and Listening to Chat!');
});

app.listen(port, () => {
  console.log(`[Bot] Express sunucusu port ${port} üzerinde ayağa kalktı. (Ping servisleri için hazır)`);
});
