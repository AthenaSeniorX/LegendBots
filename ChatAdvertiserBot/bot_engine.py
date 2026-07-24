import time
import threading
import ctypes
import ctypes.wintypes
import config

# ============================================================
#  Win32 SendInput API — Sistemsel Gerçek Tıklama & Klavye
#  PostMessage oyunlarda çalışmaz, SendInput gerçek input gönderir.
#  tscon ile masaüstü oturumu açık kaldığında RDP kapalı bile çalışır.
# ============================================================

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

# --- ctypes Return Type Düzeltmeleri (64-bit Windows uyumluluğu) ---
# GlobalAlloc, GlobalLock, GlobalUnlock: pointer döner, varsayılan c_int 64-bit'te yanlış
kernel32.GlobalAlloc.restype = ctypes.c_void_p
kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
kernel32.GlobalUnlock.restype = ctypes.c_bool
kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]

# Clipboard fonksiyonları
user32.OpenClipboard.restype = ctypes.c_bool
user32.OpenClipboard.argtypes = [ctypes.c_void_p]
user32.CloseClipboard.restype = ctypes.c_bool
user32.EmptyClipboard.restype = ctypes.c_bool
user32.SetClipboardData.restype = ctypes.c_void_p
user32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
user32.GetClipboardData.restype = ctypes.c_void_p
user32.GetClipboardData.argtypes = [ctypes.c_uint]

# --- SendInput Yapıları ---
INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_ABSOLUTE = 0x8000

KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

VK_RETURN = 0x0D
VK_CONTROL = 0x11
VK_V = 0x56


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.wintypes.LONG),
        ("dy", ctypes.wintypes.LONG),
        ("mouseData", ctypes.wintypes.DWORD),
        ("dwFlags", ctypes.wintypes.DWORD),
        ("time", ctypes.wintypes.DWORD),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", ctypes.wintypes.WORD),
        ("wScan", ctypes.wintypes.WORD),
        ("dwFlags", ctypes.wintypes.DWORD),
        ("time", ctypes.wintypes.DWORD),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]


class _INPUT_UNION(ctypes.Union):
    _fields_ = [
        ("mi", MOUSEINPUT),
        ("ki", KEYBDINPUT),
    ]


class INPUT(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.wintypes.DWORD),
        ("union", _INPUT_UNION),
    ]


# --- Window Finding ---
WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)


def find_window_by_keyword(keyword):
    """
    Tüm açık pencereleri tarayarak başlığında keyword geçen pencereyi bulur.
    Returns: (hwnd, title) tuple veya None
    """
    result = []
    keyword_lower = keyword.lower()

    def enum_callback(hwnd, lParam):
        if user32.IsWindowVisible(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buff = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buff, length + 1)
                title = buff.value
                if keyword_lower in title.lower():
                    result.append((hwnd, title))
        return True

    user32.EnumWindows(WNDENUMPROC(enum_callback), 0)

    if result:
        result.sort(key=lambda x: len(x[1]), reverse=True)
        return result[0]
    return None


# --- SendInput Helpers ---

def _send_input(*inputs):
    """SendInput API çağrısı."""
    n = len(inputs)
    arr = (INPUT * n)(*inputs)
    user32.SendInput(n, arr, ctypes.sizeof(INPUT))


def _screen_to_absolute(x, y):
    """
    Ekran piksel koordinatlarını SendInput'un istediği
    0-65535 normalized koordinatlara çevirir.
    """
    screen_w = user32.GetSystemMetrics(0)  # SM_CXSCREEN
    screen_h = user32.GetSystemMetrics(1)  # SM_CYSCREEN
    abs_x = int(x * 65536 / screen_w)
    abs_y = int(y * 65536 / screen_h)
    return abs_x, abs_y


def real_click(screen_x, screen_y):
    """
    Ekran koordinatına GERÇEK sistemsel tıklama gönderir.
    SendInput kullanır — oyunlar dahil tüm uygulamalarda çalışır.
    """
    abs_x, abs_y = _screen_to_absolute(screen_x, screen_y)

    # 1. Fareyi pozisyona taşı
    move = INPUT()
    move.type = INPUT_MOUSE
    move.union.mi.dx = abs_x
    move.union.mi.dy = abs_y
    move.union.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE
    _send_input(move)
    time.sleep(0.03)

    # 2. Sol tıklama (basma + bırakma)
    down = INPUT()
    down.type = INPUT_MOUSE
    down.union.mi.dx = abs_x
    down.union.mi.dy = abs_y
    down.union.mi.dwFlags = MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE
    _send_input(down)
    time.sleep(0.03)

    up = INPUT()
    up.type = INPUT_MOUSE
    up.union.mi.dx = abs_x
    up.union.mi.dy = abs_y
    up.union.mi.dwFlags = MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE
    _send_input(up)


def real_key_press(vk_code):
    """Tek bir tuşa gerçek basma + bırakma."""
    down = INPUT()
    down.type = INPUT_KEYBOARD
    down.union.ki.wVk = vk_code

    up = INPUT()
    up.type = INPUT_KEYBOARD
    up.union.ki.wVk = vk_code
    up.union.ki.dwFlags = KEYEVENTF_KEYUP

    _send_input(down)
    time.sleep(0.03)
    _send_input(up)


def real_hotkey(vk_modifier, vk_key):
    """Modifier + Key kombinasyonu (örn: Ctrl+V)."""
    mod_down = INPUT()
    mod_down.type = INPUT_KEYBOARD
    mod_down.union.ki.wVk = vk_modifier

    key_down = INPUT()
    key_down.type = INPUT_KEYBOARD
    key_down.union.ki.wVk = vk_key

    key_up = INPUT()
    key_up.type = INPUT_KEYBOARD
    key_up.union.ki.wVk = vk_key
    key_up.union.ki.dwFlags = KEYEVENTF_KEYUP

    mod_up = INPUT()
    mod_up.type = INPUT_KEYBOARD
    mod_up.union.ki.wVk = vk_modifier
    mod_up.union.ki.dwFlags = KEYEVENTF_KEYUP

    _send_input(mod_down)
    time.sleep(0.02)
    _send_input(key_down)
    time.sleep(0.02)
    _send_input(key_up)
    time.sleep(0.02)
    _send_input(mod_up)


def real_type_text(text):
    """Metin karakterlerini tek tek SendInput ile yazar (unicode destekli)."""
    for char in text:
        code = ord(char)
        down = INPUT()
        down.type = INPUT_KEYBOARD
        down.union.ki.wScan = code
        down.union.ki.dwFlags = KEYEVENTF_UNICODE

        up = INPUT()
        up.type = INPUT_KEYBOARD
        up.union.ki.wScan = code
        up.union.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP

        _send_input(down)
        time.sleep(0.005)
        _send_input(up)
        time.sleep(0.005)


def clipboard_set(text):
    """
    Win32 API ile doğrudan clipboard'a yazar.
    Thread-safe ve güvenilir — pyperclip'e bağımlı değil.
    """
    CF_UNICODETEXT = 13
    GMEM_MOVEABLE = 0x0002
    
    # Metin verisini hazırla (UTF-16-LE, null terminated)
    data = text.encode('utf-16-le') + b'\x00\x00'
    
    max_attempts = 5
    for attempt in range(max_attempts):
        try:
            if user32.OpenClipboard(0):
                user32.EmptyClipboard()
                h = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
                if h:
                    ptr = kernel32.GlobalLock(h)
                    if ptr:
                        ctypes.memmove(ptr, data, len(data))
                        kernel32.GlobalUnlock(h)
                        user32.SetClipboardData(CF_UNICODETEXT, h)
                user32.CloseClipboard()
                return True
            else:
                # Clipboard başka bir process tarafından kullanılıyor, bekle
                time.sleep(0.05)
        except Exception:
            try:
                user32.CloseClipboard()
            except Exception:
                pass
            time.sleep(0.05)
    return False


def clipboard_get():
    """Clipboard'daki metni okur (doğrulama için)."""
    CF_UNICODETEXT = 13
    
    try:
        if user32.OpenClipboard(0):
            h = user32.GetClipboardData(CF_UNICODETEXT)
            if h:
                ptr = kernel32.GlobalLock(h)
                if ptr:
                    text = ctypes.wstring_at(ptr)
                    kernel32.GlobalUnlock(h)
                    user32.CloseClipboard()
                    return text
            user32.CloseClipboard()
    except Exception:
        try:
            user32.CloseClipboard()
        except Exception:
            pass
    return None


def real_paste(text):
    """
    Clipboard'a yaz + doğrula + Ctrl+V ile yapıştır.
    Thread-safe Win32 clipboard API kullanır.
    """
    # 1. Clipboard'a yaz
    clipboard_set(text)
    time.sleep(0.10)
    
    # 2. Doğrula — clipboard'da doğru metin var mı?
    verify = clipboard_get()
    if verify and verify.strip() != text.strip():
        # Tekrar dene
        time.sleep(0.05)
        clipboard_set(text)
        time.sleep(0.10)
    
    # 3. Ctrl+V gönder
    real_hotkey(VK_CONTROL, VK_V)


def bring_window_to_front(hwnd):
    """Pencereyi ön plana getirir (odaklar)."""
    if hwnd and user32.IsWindow(hwnd):
        # Minimize edilmişse geri aç
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            time.sleep(0.2)
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.1)
        return True
    return False


# ============================================================
#  Bot Engine
# ============================================================

class LegendBotEngine:
    def __init__(self, log_callback=None, alert_callback=None, status_callback=None, counter_callback=None):
        self.log_cb = log_callback or print
        self.alert_cb = alert_callback or print
        self.status_cb = status_callback or print
        self.counter_cb = counter_callback or (lambda sent: None)

        self.is_running = False
        self.is_paused = False
        self.total_messages_sent = 0

        self.msg1 = config.DEFAULT_MESSAGE_1
        self.msg2 = config.DEFAULT_MESSAGE_2
        self.cycle_interval = config.DEFAULT_CYCLE_INTERVAL
        self.inter_delay = config.INTER_MESSAGE_DELAY

        # Koordinatlar (ekran mutlak)
        self.click_x = config.DEFAULT_CLICK_X
        self.click_y = config.DEFAULT_CLICK_Y
        self.window_keyword = config.WINDOW_TITLE_KEYWORD
        self.use_type_fallback = False  # Ctrl+V yerine karakter karakter gönder

        self.target_hwnd = None
        self.target_title = ""
        self._thread = None

    def log(self, message):
        self.log_cb(f"[{time.strftime('%H:%M:%S')}] {message}")

    def update_status(self, status_str):
        self.status_cb(status_str)

    def update_counters(self):
        self.counter_cb(self.total_messages_sent)

    def find_target(self):
        """Hedef pencereyi bulur."""
        result = find_window_by_keyword(self.window_keyword)
        if result:
            self.target_hwnd, self.target_title = result
            return True
        self.target_hwnd = None
        self.target_title = ""
        return False

    def start(self, msg1=None, msg2=None, interval=None, click_x=None, click_y=None, keyword=None):
        if self.is_running:
            self.log("Bot zaten çalışıyor.")
            return

        if msg1: self.msg1 = msg1
        if msg2: self.msg2 = msg2
        if interval: self.cycle_interval = float(interval)
        if click_x is not None: self.click_x = int(click_x)
        if click_y is not None: self.click_y = int(click_y)
        if keyword: self.window_keyword = keyword

        # Hedef pencereyi bul
        if not self.find_target():
            self.log(f"❌ HATA: '{self.window_keyword}' başlıklı pencere bulunamadı!")
            self.alert_cb("Pencere Bulunamadı", f"'{self.window_keyword}' başlığını içeren pencere bulunamadı.\n\nOyun istemcisinin açık olduğundan emin olun.")
            return

        self.log(f"✅ Hedef pencere bulundu: '{self.target_title}' (HWND: {self.target_hwnd})")
        self.log(f"📍 Tıklama koordinatı: ({self.click_x}, {self.click_y})")
        self.log(f"📐 Ekran çözünürlüğü: {user32.GetSystemMetrics(0)}x{user32.GetSystemMetrics(1)}")

        self.is_running = True
        self.is_paused = False
        self.total_messages_sent = 0
        self.update_counters()

        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        self.log("🚀 Bot başlatıldı. SendInput modu — gerçek sistemsel tıklama aktif.")
        self.log("⚠️  RDP kapatmadan önce BAGLANTIYI_KOPAR_BOT_CALISSIN.bat çalıştırın!")
        self.update_status("Çalışıyor")

    def pause(self):
        if not self.is_running:
            return
        self.is_paused = not self.is_paused
        status = "Duraklatıldı" if self.is_paused else "Çalışıyor"
        self.log(f"Bot {status.lower()}.")
        self.update_status(status)

    def stop(self):
        self.is_running = False
        self.is_paused = False
        self.log("Bot durduruldu.")
        self.update_status("Durduruldu")

    def _ensure_window_focused(self):
        """Hedef pencerenin açık ve odaklı olduğundan emin ol."""
        if not self.target_hwnd or not user32.IsWindow(self.target_hwnd):
            self.log("⚠️ Hedef pencere kayboldu, yeniden aranıyor...")
            if not self.find_target():
                self.log("❌ Hedef pencere bulunamadı!")
                return False
            self.log(f"✅ Pencere yeniden bulundu: '{self.target_title}'")

        # Pencereyi ön plana getir (tıklamanın doğru pencereye gitmesi için)
        bring_window_to_front(self.target_hwnd)
        return True

    def _send_message(self, text, msg_num):
        """
        Tek bir mesajı gönderir:
        1. Pencereyi ön plana getir
        2. Chat kutusuna gerçek tıklama (SendInput)
        3. Metni clipboard'a kopyala ve doğrula
        4. Ctrl+V ile yapıştır
        5. Enter ile gönder
        """
        if not self._ensure_window_focused():
            return False

        # 1. Chat kutusuna tıkla
        real_click(self.click_x, self.click_y)
        time.sleep(0.30)

        # 2. Metni clipboard'a kopyala ve yapıştır
        self.log(f"📋 Clipboard'a yazılıyor: '{text[:40]}...'")
        
        if self.use_type_fallback:
            real_type_text(text)
        else:
            # Clipboard'a yaz
            if not clipboard_set(text):
                self.log(f"⚠️ Clipboard yazma başarısız! Tekrar deneniyor...")
                time.sleep(0.1)
                clipboard_set(text)
            
            time.sleep(0.15)
            
            # Clipboard doğrulama
            verify = clipboard_get()
            if verify:
                if verify.strip() == text.strip():
                    self.log(f"✅ Clipboard doğrulandı.")
                else:
                    self.log(f"⚠️ Clipboard uyuşmuyor! Tekrar yazılıyor...")
                    clipboard_set(text)
                    time.sleep(0.15)
            
            # Ctrl+V ile yapıştır
            real_hotkey(VK_CONTROL, VK_V)
        
        time.sleep(0.30)

        # 3. Enter gönder
        real_key_press(VK_RETURN)
        time.sleep(0.10)

        self.total_messages_sent += 1
        self.update_counters()
        self.log(f"✉️ Mesaj {msg_num} gönderildi (#{self.total_messages_sent}): '{text[:40]}...'")
        return True

    def _interruptible_sleep(self, duration):
        """Kesintiye uğrayabilen bekleme."""
        start = time.time()
        while time.time() - start < duration:
            if not self.is_running:
                return False
            while self.is_paused and self.is_running:
                time.sleep(0.3)
            time.sleep(0.2)
        return True

    def _run_loop(self):
        while self.is_running:
            if self.is_paused:
                time.sleep(0.5)
                continue

            # Mesaj 1 gönder
            if not self._send_message(self.msg1, 1):
                self.log("Mesaj 1 gönderilemedi. 3 saniye sonra tekrar denenecek...")
                if not self._interruptible_sleep(3.0):
                    break
                continue

            # Mesajlar arası bekleme
            self.log(f"⏳ {self.inter_delay} saniye bekleniyor...")
            if not self._interruptible_sleep(self.inter_delay):
                break

            # Mesaj 2 gönder
            if not self._send_message(self.msg2, 2):
                self.log("Mesaj 2 gönderilemedi. 3 saniye sonra tekrar denenecek...")
                if not self._interruptible_sleep(3.0):
                    break
                continue

            # Döngü aralığı
            self.log(f"✅ Döngü tamamlandı. Toplam: {self.total_messages_sent} mesaj. Bekleniyor ({self.cycle_interval} sn)...")
            if not self._interruptible_sleep(self.cycle_interval):
                break

        self.update_status("Durduruldu")
