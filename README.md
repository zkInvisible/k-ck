# Kick Telegram Sunucu Botu

Bu bot, Kick sohbetindeki spam mesajları (bizim için çekiliş kelimelerini) algılayıp Telegram üzerinden bildirim gönderir. Render gibi sunucularda 7/24 çalışmaya uygundur.

## Render.com Kurulum Rehberi

### Adım 1: Projeyi GitHub'a Yükle
1. Kendine bir [GitHub](https://github.com) hesabı aç (eğer yoksa).
2. Yeni bir "Repository" oluştur. (Private veya Public seçebilirsin, `.env` dosyan gizli olduğu için sorun olmaz).
3. Bilgisayarındaki `kick-telegram-bot` klasörünün içindeki şu dosyaları GitHub'a yükle (Sürükle bırak yapabilirsin):
   - `server.js`
   - `package.json`
   - `package-lock.json`
   - (Dikkat: `.env` ve `node_modules` klasörünü **YÜKLEME**. Zaten yeni eklediğim `.gitignore` dosyası onların yanlışlıkla yüklenmesini otomatik engelleyecektir).

### Adım 2: Render.com'a Bağla
1. [Render.com](https://render.com)'a gir ve GitHub hesabınla giriş yap.
2. Sağ üstteki **New** butonuna basıp **Web Service** seçeneğine tıkla.
3. Listeden GitHub deponu bul ve seç.
4. Ayarları birebir şöyle yap:
   - **Name**: (Bota istediğin bir isim ver)
   - **Language**: Node
   - **Branch**: main
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free (Ücretsiz)

### Adım 3: Çevre Değişkenlerini (Şifreleri) Ekle
Render'da oluşturma sayfasında aşağı in ve **"Environment Variables"** sekmesini aç. Bilgisayarındaki `.env` dosyasının içindeki bilgileri buraya satır satır ekle:
1. Key: `TELEGRAM_TOKEN` | Value: `(Telegram'dan aldığın uzun şifre)`
2. Key: `TELEGRAM_CHAT_ID` | Value: `(Kendi ID'n)`
3. Key: `KICK_CHATROOM_ID` | Value: `23724894`
4. Key: `KICK_CHANNEL_NAME` | Value: `idlemonkk`

Son olarak en alttaki **"Create Web Service"** butonuna bas.
Birkaç dakika kurulum yapacak ve yeşil "Live" yazısını göreceksin! Bot artık bulutta aktif!

### Adım 4 (Önemli): 7/24 Uyanık Tutma (Ping)
Render ücretsiz sunucuları 15 dakika işlem görmezse uykuya dalar. Botun uyumaması için projenin içine özel bir web portu hazırladım. Şunu yapman yeterli:
1. Render'da botun yeşil "Live" yazdıktan sonra hemen sol üstte sana verdiği web sitesi linkini kopyala (Örn: `https://kick-bot-abc.onrender.com`).
2. [cron-job.org](https://cron-job.org) adresine git ve ücretsiz üye ol.
3. "Create Cronjob" tuşuna bas.
4. Render'dan kopyaladığın web sitesi linkini yapıştır ve süreyi **"Every 5 minutes" (5 dakikada bir)** olarak ayarla.
5. Create deyip kaydet! 

Artık o site senin botuna her 5 dakikada bir gizli bir ping atacak ve Render sunucusunun asla uyumamasını sağlayacak. Botun sonsuza dek ücretsiz ve 7/24 çalışacak. Tebrikler! 🎉
