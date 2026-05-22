"""
Kick Chat Spam Dedektörü
========================
Aynı mesajı 15 saniye içinde 10+ farklı kullanıcı yazarsa Telegram'a bildirim gönderir.
"""

import asyncio
import json
import os
import time
import logging
import aiohttp
import websockets
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List
from datetime import datetime

# ─── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ─── Config ──────────────────────────────────────────────────────────────────
TELEGRAM_TOKEN   = os.environ["TELEGRAM_TOKEN"]       # BotFather'dan alınan token
TELEGRAM_CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]     # Telegram kullanıcı/grup ID
KICK_CHANNEL     = os.environ.get("KICK_CHANNEL", "")  # kick.com/KANAL_ADI

TIME_WINDOW      = int(os.environ.get("TIME_WINDOW", "15"))    # saniye
MIN_USERS        = int(os.environ.get("MIN_USERS", "5"))       # farklı kullanıcı sayısı
MIN_MSG_LENGTH   = int(os.environ.get("MIN_MSG_LENGTH", "2"))   # min mesaj uzunluğu (spam filtresi)

# Pusher bağlantısı - eğer değişirse Chrome DevTools > Network > "pusher" filtrele
PUSHER_APP_KEY   = os.environ.get("PUSHER_APP_KEY", "eb1d5f283081a78b932c")
PUSHER_URL = os.getenv("PUSHER_URL", "wss://ws-eu.pusher.com/app/eb1d5f283081a78b932c?protocol=7&client=js&version=7.4.0&flash=false")

KICK_API_BASE    = "https://kick.com/api/v2/channels"

# ─── Veri Yapısı ─────────────────────────────────────────────────────────────
@dataclass
class MessageRecord:
    """Bir mesajı kaç farklı kullanıcının yazdığını takip eder."""
    users: set = field(default_factory=set)
    timestamps: List[float] = field(default_factory=list)
    notified: bool = False  # aynı dalga için tekrar bildirim gitmesin

# mesaj_metni → MessageRecord
message_tracker: Dict[str, MessageRecord] = defaultdict(MessageRecord)

# ─── Kick API ────────────────────────────────────────────────────────────────
async def get_chatroom_id(session: aiohttp.ClientSession, channel_slug: str) -> int:
    """Kanal adından chatroom ID'sini çeker. CHATROOM_ID env var varsa direkt kullanır."""

    # Manuel ID tanımlanmışsa API'ye hiç gitme
    manual_id = os.environ.get("CHATROOM_ID", "").strip()
    if manual_id:
        log.info(f"✅ Chatroom ID env'den alındı: {manual_id}")
        return int(manual_id)

    url = f"{KICK_API_BASE}/{channel_slug}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://kick.com/",
        "Origin": "https://kick.com",
        "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
    }
    async with session.get(url, headers=headers) as resp:
        if resp.status != 200:
            raise ValueError(
                f"Kick API hatası: HTTP {resp.status}\n"
                f"👉 Çözüm: Tarayıcında şu URL'yi aç: https://kick.com/api/v2/channels/{channel_slug}\n"
                f"   'chatroom':{{'id': XXXXX}} kısmındaki sayıyı kopyala.\n"
                f"   Render'da CHATROOM_ID=XXXXX olarak env variable ekle."
            )
        data = await resp.json()
        chatroom_id = data.get("chatroom", {}).get("id")
        if not chatroom_id:
            raise ValueError("chatroom ID bulunamadı.")
        log.info(f"✅ Chatroom ID bulundu: {chatroom_id} ({channel_slug})")
        return chatroom_id

# ─── Telegram ────────────────────────────────────────────────────────────────
async def send_telegram(session: aiohttp.ClientSession, text: str) -> None:
    """Telegram botuna mesaj gönderir."""
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    try:
        async with session.post(url, json=payload) as resp:
            if resp.status != 200:
                body = await resp.text()
                log.error(f"Telegram hatası: {resp.status} — {body}")
            else:
                log.info(f"📨 Telegram bildirimi gönderildi")
    except Exception as e:
        log.error(f"Telegram bağlantı hatası: {e}")

# ─── Mesaj İşleme ─────────────────────────────────────────────────────────────
async def process_message(
    session: aiohttp.ClientSession,
    channel: str,
    username: str,
    content: str,
) -> None:
    """Gelen mesajı kaydeder, eşik aşılırsa bildirim gönderir."""

    if len(content.strip()) < MIN_MSG_LENGTH:
        return

    now = time.time()
    msg_key = content.strip().lower()  # büyük/küçük harf farkını yoksay
    record = message_tracker[msg_key]

    # Zaman penceresinin dışındaki kayıtları temizle
    cutoff = now - TIME_WINDOW
    record.timestamps = [t for t in record.timestamps if t >= cutoff]

    # Zaman penceresinde kimse yoksa kullanıcı setini sıfırla
    if not record.timestamps:
        record.users.clear()
        record.notified = False

    # Yeni kaydı ekle
    record.users.add(username)
    record.timestamps.append(now)

    user_count = len(record.users)
    log.debug(f"[{username}] «{content[:40]}» — penceredeki farklı kullanıcı: {user_count}")

    # Eşiği aştı ve henüz bildirilmedi
    if user_count >= MIN_USERS and not record.notified:
        record.notified = True
        await fire_alert(session, channel, content, record.users, user_count)

async def fire_alert(
    session: aiohttp.ClientSession,
    channel: str,
    message: str,
    users: set,
    count: int,
) -> None:
    """Uyarı mesajı oluşturup Telegram'a gönderir."""
    ts = datetime.now().strftime("%H:%M:%S")
    user_list = "\n".join(f"  • {u}" for u in list(users)[:20])  # max 20 kullanıcı listele

    text = (
        f"🚨 <b>KICK CHAT UYARISI</b>\n"
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"📺 Kanal: <b>kick.com/{channel}</b>\n"
        f"⏰ Saat: {ts}\n"
        f"👥 Farklı kullanıcı: <b>{count}</b> ({TIME_WINDOW}sn içinde)\n\n"
        f"💬 Mesaj:\n<code>{message[:300]}</code>\n\n"
        f"👤 Kullanıcılar ({min(count,20)}/{count}):\n{user_list}"
    )
    log.warning(f"🚨 UYARI: «{message[:50]}» → {count} kullanıcı")
    await send_telegram(session, text)

# ─── Temizlik Görevi ──────────────────────────────────────────────────────────
async def cleanup_task() -> None:
    """Eski mesaj kayıtlarını bellekten temizler (her 60sn)."""
    while True:
        await asyncio.sleep(60)
        now = time.time()
        cutoff = now - TIME_WINDOW
        stale_keys = [
            k for k, v in message_tracker.items()
            if not any(t >= cutoff for t in v.timestamps)
        ]
        for k in stale_keys:
            del message_tracker[k]
        if stale_keys:
            log.debug(f"🧹 {len(stale_keys)} eski kayıt temizlendi")

# ─── WebSocket ───────────────────────────────────────────────────────────────
async def listen_chat(session: aiohttp.ClientSession, chatroom_id: int, channel: str) -> None:
    """Kick chat WebSocket'ine bağlanır ve mesajları dinler."""
    reconnect_delay = 5  # saniye

    while True:
        try:
            log.info(f"🔌 Pusher'a bağlanılıyor... ({PUSHER_URL[:60]}...)")
            async with websockets.connect(
                PUSHER_URL,
                ping_interval=30,
                ping_timeout=10,
                extra_headers={"Origin": "https://kick.com"},
            ) as ws:
                log.info("🔌 WebSocket bağlandı")

                # Pusher bağlantısı kuruldu mesajını bekle
                raw = await ws.recv()
                data = json.loads(raw)
                if data.get("event") != "pusher:connection_established":
                    raise ConnectionError(f"Beklenmeyen ilk mesaj: {data}")

                # Chatroom kanalına abone ol
                channel_name = f"chatrooms.{chatroom_id}.v2"
                subscribe_msg = json.dumps({
                    "event": "pusher:subscribe",
                    "data": {"auth": "", "channel": channel_name},
                })
                await ws.send(subscribe_msg)
                log.info(f"📡 Abone olundu: {channel_name}")

                reconnect_delay = 5  # başarılı bağlantıda sıfırla

                # Mesaj döngüsü
                async for raw_msg in ws:
                    try:
                        msg = json.loads(raw_msg)
                        event = msg.get("event", "")

                        # Ping/pong
                        if event == "pusher:ping":
                            await ws.send(json.dumps({"event": "pusher:pong", "data": {}}))
                            continue

                        # Chat mesajı
                        if event == "App\\Events\\ChatMessageEvent":
                            payload = msg.get("data", {})
                            if isinstance(payload, str):
                                payload = json.loads(payload)

                            username = (
                                payload.get("sender", {}).get("username")
                                or payload.get("sender", {}).get("slug")
                                or "unknown"
                            )
                            content = payload.get("content", "").strip()

                            if content:
                                await process_message(session, channel, username, content)

                    except json.JSONDecodeError:
                        pass
                    except Exception as e:
                        log.error(f"Mesaj işleme hatası: {e}")

        except (websockets.ConnectionClosed, ConnectionResetError) as e:
            log.warning(f"⚠️  Bağlantı kapandı: {e}. {reconnect_delay}sn sonra yeniden bağlanılıyor...")
        except Exception as e:
            log.error(f"❌ WebSocket hatası: {e}. {reconnect_delay}sn sonra yeniden denenecek...")

        await asyncio.sleep(reconnect_delay)
        reconnect_delay = min(reconnect_delay * 2, 60)  # exponential backoff, max 60sn

# ─── HTTP Keep-Alive (Render için) ───────────────────────────────────────────
async def health_server() -> None:
    """
    Render gibi platformlar servisi uyku moduna almamak için HTTP endpoint ister.
    GET / → 200 OK döner.
    """
    from aiohttp import web

    async def handle(_request):
        return web.Response(
            text=json.dumps({
                "status": "ok",
                "channel": KICK_CHANNEL,
                "tracked_messages": len(message_tracker),
                "uptime": "running",
            }),
            content_type="application/json",
        )

    app = web.Application()
    app.router.add_get("/", handle)
    app.router.add_get("/health", handle)

    port = int(os.environ.get("PORT", 10000))
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    log.info(f"🌐 Health server başlatıldı → http://0.0.0.0:{port}")

# ─── Ana Fonksiyon ────────────────────────────────────────────────────────────
async def main() -> None:
    if not KICK_CHANNEL:
        raise ValueError("KICK_CHANNEL environment variable ayarlanmamış!")

    log.info("=" * 50)
    log.info(f"🎯 Kick Chat Spam Dedektörü başlıyor")
    log.info(f"📺 Kanal   : kick.com/{KICK_CHANNEL}")
    log.info(f"⏱️  Zaman   : {TIME_WINDOW} saniye")
    log.info(f"👥 Eşik    : {MIN_USERS} farklı kullanıcı")
    log.info("=" * 50)

    async with aiohttp.ClientSession() as session:
        # Chatroom ID'sini al (CHATROOM_ID env varsa API'ye gitme)
        chatroom_id = await get_chatroom_id(session, KICK_CHANNEL)
        log.info(f"🔑 Chatroom ID: {chatroom_id}")

        # Başlangıç bildirimi
        await send_telegram(
            session,
            f"✅ <b>Bot başlatıldı!</b>\n"
            f"📺 <b>kick.com/{KICK_CHANNEL}</b> izleniyor\n"
            f"👥 Eşik: <b>{MIN_USERS} kullanıcı / {TIME_WINDOW}sn</b>"
        )

        # Tüm görevleri paralel çalıştır
        await asyncio.gather(
            health_server(),
            listen_chat(session, chatroom_id, KICK_CHANNEL),
            cleanup_task(),
        )

if __name__ == "__main__":
    asyncio.run(main())
