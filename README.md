# 🎯 Kick Chat Spam Dedektörü

Kick yayın platformu chatini izler. Aynı mesaj **15 saniye içinde 10 farklı kullanıcı** tarafından yazılırsa **Telegram'a bildirim** gönderir.

---

## 📋 Kurulum Adımları

### 1. Telegram Bot Oluştur

1. Telegram'da **@BotFather**'ı aç
2. `/newbot` yaz → bot adı ve kullanıcı adı belirle
3. **TELEGRAM_TOKEN**'ı kopyala (örn: `7412356789:AAGabcd...`)

### 2. Telegram Chat ID'ni Al

1. Botuna bir mesaj gönder
2. Tarayıcıda şu URL'yi aç:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. Yanıtta `"chat":{"id":` yazan kısmı bul → **TELEGRAM_CHAT_ID**

> Grup kullanıyorsan: Botu gruba ekle, aynı adımları uygula (ID negatif sayı olacak)

---

### 3. Render'a Deploy Et (Ücretsiz)

#### A) GitHub'a yükle
```bash
git init
git add .
git commit -m "ilk commit"
git remote add origin https://github.com/KULLANICI/kick-bot.git
git push -u origin main
```

#### B) Render.com
1. [render.com](https://render.com) → **New → Web Service**
2. GitHub repo'nu bağla
3. Ayarlar:
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `python bot.py`
   - **Instance Type:** Free
4. **Environment Variables** ekle:

| Key | Value |
|-----|-------|
| `TELEGRAM_TOKEN` | BotFather'dan aldığın token |
| `TELEGRAM_CHAT_ID` | Chat ID'n |
| `KICK_CHANNEL` | İzlenecek kanal (örn: `xqc`) |
| `TIME_WINDOW` | `15` (saniye, isteğe bağlı) |
| `MIN_USERS` | `10` (kullanıcı sayısı, isteğe bağlı) |

5. **Deploy** butonuna bas ✅

---

### 4. 7/24 Açık Tut (Ücretsiz)

Render free tier servisi 15 dakika işlem olmadığında uyutur.
**UptimeRobot** ile çöz (ücretsiz):

1. [uptimerobot.com](https://uptimerobot.com) → Hesap aç
2. **Add New Monitor:**
   - Type: **HTTP(s)**
   - URL: `https://SERVIS-ADIN.onrender.com/health`
   - Interval: **5 minutes**
3. Kaydet → Bot artık 7/24 çalışır ✅

---

## ⚙️ Ayarlar

| Değişken | Varsayılan | Açıklama |
|----------|-----------|----------|
| `TIME_WINDOW` | `15` | Kaç saniye içinde sayılsın |
| `MIN_USERS` | `10` | Kaç farklı kullanıcı gerekli |
| `MIN_MSG_LENGTH` | `3` | Min kaç karakter uzunluğunda mesajlar takip edilsin |
| `PUSHER_APP_KEY` | `eb1d5f283081a78b932c` | Kick'in Pusher anahtarı |

---

## 🔧 Pusher Key Değişirse Ne Yapmalı?

1. Chrome'da kick.com'u aç
2. **F12 → Network → "pusher" filtrele**
3. WebSocket URL'deki `app/XXXXX` kısmını kopyala
4. Render'da `PUSHER_APP_KEY` değerini güncelle

---

## 🖥️ Lokal Test

```bash
pip install -r requirements.txt

export TELEGRAM_TOKEN="7412356789:AAGabc..."
export TELEGRAM_CHAT_ID="123456789"
export KICK_CHANNEL="xqc"

python bot.py
```

---

## 📨 Bildirim Örneği

```
🚨 KICK CHAT UYARISI
━━━━━━━━━━━━━━━━━━━━
📺 Kanal: kick.com/xqc
⏰ Saat: 21:45:12
👥 Farklı kullanıcı: 13 (15sn içinde)

💬 Mesaj:
POGGERS

👤 Kullanıcılar (13/13):
  • kullanici1
  • kullanici2
  • ...
```
