import time
import threading
import ctypes
import ctypes.wintypes
import pyperclip
import config

# Win32 Constants
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_CHAR = 0x0102
MK_LBUTTON = 0x0001
VK_RETURN = 0x0D
VK_CONTROL = 0x11

# ctypes declarations
user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

PostMessageW = user32.PostMessageW
SendMessageW = user32.SendMessageW
FindWindowW = user32.FindWindowW
EnumWindows = user32.EnumWindows
GetWindowTextW = user32.GetWindowTextW
GetWindowTextLengthW = user32.GetWindowTextLengthW
IsWindowVisible = user32.IsWindowVisible
GetWindowRect = user32.GetWindowRect
GetClientRect = user32.GetClientRect
ScreenToClient = user32.ScreenToClient
SetForegroundWindow = user32.SetForegroundWindow
IsWindow = user32.IsWindow

# For clipboard operations
OpenClipboard = user32.OpenClipboard
CloseClipboard = user32.CloseClipboard
EmptyClipboard = user32.EmptyClipboard
SetClipboardData = user32.SetClipboardData
GlobalAlloc = kernel32.GlobalAlloc
GlobalLock = kernel32.GlobalLock
GlobalUnlock = kernel32.GlobalUnlock

GMEM_MOVEABLE = 0x0002
CF_UNICODETEXT = 13

# EnumWindows callback type
WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)


def MAKELPARAM(x, y):
    """Pack x, y into a single LPARAM value for PostMessage."""
    return (y << 16) | (x & 0xFFFF)


def find_window_by_keyword(keyword):
    """
    Tüm açık pencereleri tarayarak başlığında keyword geçen pencereyi bulur.
    Returns: hwnd (int) veya None
    """
    result = []
    keyword_lower = keyword.lower()

    def enum_callback(hwnd, lParam):
        if IsWindowVisible(hwnd):
            length = GetWindowTextLengthW(hwnd)
            if length > 0:
                buff = ctypes.create_unicode_buffer(length + 1)
                GetWindowTextW(hwnd, buff, length + 1)
                title = buff.value
                if keyword_lower in title.lower():
                    result.append((hwnd, title))
        return True

    EnumWindows(WNDENUMPROC(enum_callback), 0)

    if result:
        # En uzun başlığa sahip olanı tercih et (ana pencere olma ihtimali yüksek)
        result.sort(key=lambda x: len(x[1]), reverse=True)
        return result[0]
    return None


def screen_to_client_coords(hwnd, screen_x, screen_y):
    """
    Ekran mutlak koordinatlarını pencere-client koordinatlarına çevirir.
    PostMessage pencere-relative koordinat ister.
    """
    point = ctypes.wintypes.POINT(screen_x, screen_y)
    ScreenToClient(hwnd, ctypes.byref(point))
    return point.x, point.y


def set_clipboard_text(text):
    """
    Win32 API ile doğrudan clipboard'a metin yazar.
    pyperclip'e alternatif olarak daha güvenilir çalışır.
    """
    try:
        pyperclip.copy(text)
        return True
    except Exception:
        pass
    
    # Fallback: Win32 API ile doğrudan clipboard
    try:
        if OpenClipboard(0):
            EmptyClipboard()
            data = text.encode('utf-16-le') + b'\x00\x00'
            h = GlobalAlloc(GMEM_MOVEABLE, len(data))
            ptr = GlobalLock(h)
            ctypes.memmove(ptr, data, len(data))
            GlobalUnlock(h)
            SetClipboardData(CF_UNICODETEXT, h)
            CloseClipboard()
            return True
    except Exception:
        try:
            CloseClipboard()
        except Exception:
            pass
    return False


def background_click(hwnd, client_x, client_y):
    """
    Pencere arka plandayken bile tıklama gönderir.
    PostMessage ile WM_LBUTTONDOWN + WM_LBUTTONUP gönderir.
    """
    lParam = MAKELPARAM(client_x, client_y)
    PostMessageW(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lParam)
    time.sleep(0.05)
    PostMessageW(hwnd, WM_LBUTTONUP, 0, lParam)


def background_paste(hwnd):
    """
    Arka planda Ctrl+V gönderir (clipboard'dan yapıştır).
    """
    # Ctrl tuşunu basılı tut
    PostMessageW(hwnd, WM_KEYDOWN, VK_CONTROL, 0)
    time.sleep(0.03)
    # 'V' tuşuna bas (Ctrl ile birlikte = yapıştır)
    PostMessageW(hwnd, WM_KEYDOWN, ord('V'), 0)
    time.sleep(0.03)
    PostMessageW(hwnd, WM_KEYUP, ord('V'), 0)
    time.sleep(0.03)
    PostMessageW(hwnd, WM_KEYUP, VK_CONTROL, 0)


def background_enter(hwnd):
    """
    Arka planda Enter tuşuna basar.
    """
    PostMessageW(hwnd, WM_KEYDOWN, VK_RETURN, 0)
    time.sleep(0.03)
    PostMessageW(hwnd, WM_KEYUP, VK_RETURN, 0)


def background_type_text(hwnd, text):
    """
    Fallback: WM_CHAR ile her karakteri tek tek gönderir.
    PostMessage Ctrl+V çalışmazsa bu kullanılır.
    """
    for char in text:
        PostMessageW(hwnd, WM_CHAR, ord(char), 0)
        time.sleep(0.005)


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

        # Win32 settings
        self.click_x = config.DEFAULT_CLICK_X  # Ekran mutlak X
        self.click_y = config.DEFAULT_CLICK_Y  # Ekran mutlak Y
        self.window_keyword = config.WINDOW_TITLE_KEYWORD
        self.use_wm_char_fallback = False  # WM_CHAR ile karakter karakter gönder

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
        """Hedef pencereyi arar ve hwnd döner."""
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
            self.log(f"❌ HATA: '{self.window_keyword}' başlıklı pencere bulunamadı! Bot başlatılamıyor.")
            self.alert_cb("Pencere Bulunamadı", f"'{self.window_keyword}' başlığını içeren pencere bulunamadı.\n\nOyun istemcisinin açık olduğundan emin olun.")
            return

        self.log(f"✅ Hedef pencere bulundu: '{self.target_title}' (HWND: {self.target_hwnd})")

        # Ekran koordinatlarını pencere-client koordinatlarına çevir
        client_x, client_y = screen_to_client_coords(self.target_hwnd, self.click_x, self.click_y)
        self.log(f"📍 Tıklama koordinatı: Ekran({self.click_x}, {self.click_y}) → Pencere({client_x}, {client_y})")

        self.is_running = True
        self.is_paused = False
        self.total_messages_sent = 0
        self.update_counters()

        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        self.log("🚀 Bot başlatıldı. Win32 API arka plan modu aktif.")
        self.log("ℹ️  RDP bağlantısını kesseniz bile bot çalışmaya devam edecek.")
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

    def _validate_window(self):
        """Hedef pencerenin hâlâ açık olup olmadığını kontrol eder."""
        if self.target_hwnd and IsWindow(self.target_hwnd):
            return True
        
        # Pencere kapanmış, yeniden bulmaya çalış
        self.log("⚠️ Hedef pencere kayboldu, yeniden aranıyor...")
        if self.find_target():
            self.log(f"✅ Pencere yeniden bulundu: '{self.target_title}' (HWND: {self.target_hwnd})")
            return True
        
        self.log("❌ Hedef pencere bulunamadı! Oyun kapatılmış olabilir.")
        return False

    def _send_message(self, text, msg_num):
        """
        Tek bir mesajı arka planda gönderir:
        1. Chat kutusuna tıkla (PostMessage)
        2. Metni clipboard'a kopyala
        3. Ctrl+V ile yapıştır (PostMessage)
        4. Enter ile gönder (PostMessage)
        """
        if not self._validate_window():
            return False

        hwnd = self.target_hwnd

        # Ekran → Client koordinat çevirisi (her seferinde, pencere taşınmış olabilir)
        client_x, client_y = screen_to_client_coords(hwnd, self.click_x, self.click_y)

        # 1. Chat kutusuna tıkla
        background_click(hwnd, client_x, client_y)
        time.sleep(0.15)

        # 2. Metni clipboard'a kopyala
        set_clipboard_text(text)
        time.sleep(0.10)

        # 3. Yapıştır
        if self.use_wm_char_fallback:
            # Fallback: Her karakteri tek tek gönder
            background_type_text(hwnd, text)
        else:
            # Birincil: Ctrl+V ile yapıştır
            background_paste(hwnd)
        time.sleep(0.15)

        # 4. Enter ile gönder
        background_enter(hwnd)

        self.total_messages_sent += 1
        self.update_counters()
        self.log(f"✉️ Mesaj {msg_num} gönderildi (#{self.total_messages_sent}): '{text[:40]}...'")
        return True

    def _interruptible_sleep(self, duration):
        """Kesintiye uğrayabilen bekleme. Bot durdurulursa erken çıkar."""
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
