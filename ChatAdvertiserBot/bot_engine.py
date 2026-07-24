import time
import threading
import ctypes
import ctypes.wintypes
import config

# ============================================================
#  Win32 API Constants & Functions
# ============================================================

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_MOUSEMOVE = 0x0200
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_CHAR = 0x0102
MK_LBUTTON = 0x0001
VK_RETURN = 0x0D
VK_CONTROL = 0x11
VK_V = 0x56

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_ABSOLUTE = 0x8000
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

# ctypes return & arg types
user32.PostMessageW.restype = ctypes.c_bool
user32.PostMessageW.argtypes = [ctypes.wintypes.HWND, ctypes.c_uint, ctypes.wintypes.WPARAM, ctypes.wintypes.LPARAM]

user32.SendMessageW.restype = ctypes.c_ssize_t
user32.SendMessageW.argtypes = [ctypes.wintypes.HWND, ctypes.c_uint, ctypes.wintypes.WPARAM, ctypes.wintypes.LPARAM]

user32.ScreenToClient.restype = ctypes.c_bool
user32.ScreenToClient.argtypes = [ctypes.wintypes.HWND, ctypes.POINTER(ctypes.wintypes.POINT)]

user32.WindowFromPoint.restype = ctypes.wintypes.HWND
user32.WindowFromPoint.argtypes = [ctypes.wintypes.POINT]

user32.IsChild.restype = ctypes.c_bool
user32.IsChild.argtypes = [ctypes.wintypes.HWND, ctypes.wintypes.HWND]

user32.IsWindow.restype = ctypes.c_bool
user32.IsWindow.argtypes = [ctypes.wintypes.HWND]

user32.IsWindowVisible.restype = ctypes.c_bool
user32.IsWindowVisible.argtypes = [ctypes.wintypes.HWND]

user32.SetForegroundWindow.restype = ctypes.c_bool
user32.SetForegroundWindow.argtypes = [ctypes.wintypes.HWND]

kernel32.GlobalAlloc.restype = ctypes.c_void_p
kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
kernel32.GlobalUnlock.restype = ctypes.c_bool
kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]

user32.OpenClipboard.restype = ctypes.c_bool
user32.OpenClipboard.argtypes = [ctypes.c_void_p]
user32.CloseClipboard.restype = ctypes.c_bool
user32.EmptyClipboard.restype = ctypes.c_bool
user32.SetClipboardData.restype = ctypes.c_void_p
user32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
user32.GetClipboardData.restype = ctypes.c_void_p
user32.GetClipboardData.argtypes = [ctypes.c_uint]


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


WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)


def MAKELPARAM(x, y):
    return (y << 16) | (x & 0xFFFF)


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


def get_target_hwnd_at_point(screen_x, screen_y, parent_hwnd):
    """
    Verilen ekran koordinatındaki alt pencereyi (child HWND) bulur.
    Eğer alt pencere bulunursa onu, bulunamazsa parent_hwnd döner.
    """
    pt = ctypes.wintypes.POINT(screen_x, screen_y)
    child = user32.WindowFromPoint(pt)
    if child and (child == parent_hwnd or user32.IsChild(parent_hwnd, child)):
        return child
    return parent_hwnd


def screen_to_client_coords(hwnd, screen_x, screen_y):
    """
    Ekran mutlak koordinatını hedef pencerenin client (iç) koordinatına çevirir.
    """
    pt = ctypes.wintypes.POINT(screen_x, screen_y)
    user32.ScreenToClient(hwnd, ctypes.byref(pt))
    return pt.x, pt.y


# ============================================================
#  PostMessage (Arka Plan - RDP Kapalıyken %100 Çalışan Mod)
# ============================================================

def post_click(parent_hwnd, screen_x, screen_y):
    """
    PostMessage ile arka planda tıklama gönderir.
    Ekran çözünürlüğünden, RDP durumundan veya görünürlükten etkilenmez.
    """
    target_hwnd = get_target_hwnd_at_point(screen_x, screen_y, parent_hwnd)
    client_x, client_y = screen_to_client_coords(target_hwnd, screen_x, screen_y)
    lParam = MAKELPARAM(client_x, client_y)

    user32.PostMessageW(target_hwnd, WM_MOUSEMOVE, 0, lParam)
    time.sleep(0.02)
    user32.PostMessageW(target_hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lParam)
    time.sleep(0.05)
    user32.PostMessageW(target_hwnd, WM_LBUTTONUP, 0, lParam)
    return target_hwnd, client_x, client_y


def post_type_text(target_hwnd, text):
    """
    WM_CHAR mesajı ile her karakteri doğrudan pencere mesaj kuyruğuna gönderir.
    Clipboard, Ctrl+V veya dil düzeninden etkilenmez.
    """
    for char in text:
        user32.PostMessageW(target_hwnd, WM_CHAR, ord(char), 0)
        time.sleep(0.008)


def post_enter(target_hwnd):
    """
    Enter tuşunu PostMessage ile arka planda gönderir.
    """
    user32.PostMessageW(target_hwnd, WM_KEYDOWN, VK_RETURN, 0)
    time.sleep(0.03)
    user32.PostMessageW(target_hwnd, WM_KEYUP, VK_RETURN, 0)


# ============================================================
#  SendInput (Ön Plan Modu)
# ============================================================

def _send_input(*inputs):
    n = len(inputs)
    arr = (INPUT * n)(*inputs)
    user32.SendInput(n, arr, ctypes.sizeof(INPUT))


def _screen_to_absolute(x, y):
    screen_w = user32.GetSystemMetrics(0)
    screen_h = user32.GetSystemMetrics(1)
    if screen_w <= 0: screen_w = 1920
    if screen_h <= 0: screen_h = 1080
    abs_x = int(x * 65536 / screen_w)
    abs_y = int(y * 65536 / screen_h)
    return abs_x, abs_y


def sendinput_click(screen_x, screen_y):
    abs_x, abs_y = _screen_to_absolute(screen_x, screen_y)
    move = INPUT()
    move.type = INPUT_MOUSE
    move.union.mi.dx = abs_x
    move.union.mi.dy = abs_y
    move.union.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE
    _send_input(move)
    time.sleep(0.03)

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


def sendinput_type_text(text):
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


def sendinput_enter():
    down = INPUT()
    down.type = INPUT_KEYBOARD
    down.union.ki.wVk = VK_RETURN

    up = INPUT()
    up.type = INPUT_KEYBOARD
    up.union.ki.wVk = VK_RETURN
    up.union.ki.dwFlags = KEYEVENTF_KEYUP

    _send_input(down)
    time.sleep(0.03)
    _send_input(up)


# ============================================================
#  LegendBotEngine
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

        self.click_x = config.DEFAULT_CLICK_X
        self.click_y = config.DEFAULT_CLICK_Y
        self.window_keyword = config.WINDOW_TITLE_KEYWORD
        self.mode = "postmessage"  # "postmessage" (Arka Plan) veya "sendinput" (Ön Plan)

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
        result = find_window_by_keyword(self.window_keyword)
        if result:
            self.target_hwnd, self.target_title = result
            return True
        self.target_hwnd = None
        self.target_title = ""
        return False

    def start(self, msg1=None, msg2=None, interval=None, click_x=None, click_y=None, keyword=None, mode=None):
        if self.is_running:
            self.log("Bot zaten çalışıyor.")
            return

        if msg1: self.msg1 = msg1
        if msg2: self.msg2 = msg2
        if interval: self.cycle_interval = float(interval)
        if click_x is not None: self.click_x = int(click_x)
        if click_y is not None: self.click_y = int(click_y)
        if keyword: self.window_keyword = keyword
        if mode: self.mode = mode

        if not self.find_target():
            self.log(f"❌ HATA: '{self.window_keyword}' başlıklı pencere bulunamadı!")
            self.alert_cb("Pencere Bulunamadı", f"'{self.window_keyword}' başlığını içeren pencere bulunamadı.\n\nOyun istemcisinin açık olduğundan emin olun.")
            return

        self.log(f"✅ Hedef pencere bulundu: '{self.target_title}' (HWND: {self.target_hwnd})")
        self.log(f"📍 Tıklama koordinatı: ({self.click_x}, {self.click_y})")
        
        mode_name = "Arka Plan Modu (PostMessage - RDP Kapalıyken Çalışır)" if self.mode == "postmessage" else "Ön Plan Modu (SendInput)"
        self.log(f"⚙️ Çalışma Modu: {mode_name}")

        self.is_running = True
        self.is_paused = False
        self.total_messages_sent = 0
        self.update_counters()

        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        self.log("🚀 Bot başlatıldı. Döngü çalışıyor.")
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

    def test_send_once(self, text, click_x=None, click_y=None, keyword=None, mode=None):
        """
        Tek bir mesajı test amaçlı anında gönderir.
        """
        cx = int(click_x) if click_x is not None else self.click_x
        cy = int(click_y) if click_y is not None else self.click_y
        kw = keyword or self.window_keyword
        m = mode or self.mode

        target = find_window_by_keyword(kw)
        if not target:
            self.log(f"❌ TEST HATA: '{kw}' başlıklı pencere bulunamadı!")
            return False

        hwnd, title = target
        self.log(f"🧪 Test mesajı gönderiliyor -> HWND:{hwnd} ('{title}') | Koord: ({cx},{cy}) | Mod: {m}")

        if m == "postmessage":
            target_hwnd, client_x, client_y = post_click(hwnd, cx, cy)
            self.log(f"   📍 PostMessage tıklandı -> Child HWND: {target_hwnd} | Client Koord: ({client_x}, {client_y})")
            time.sleep(0.25)
            post_type_text(target_hwnd, text)
            time.sleep(0.25)
            post_enter(target_hwnd)
        else:
            if user32.IsWindow(hwnd):
                user32.SetForegroundWindow(hwnd)
                time.sleep(0.1)
            sendinput_click(cx, cy)
            time.sleep(0.25)
            sendinput_type_text(text)
            time.sleep(0.25)
            sendinput_enter()

        self.log("✅ Test mesajı gönderildi!")
        return True

    def _send_message(self, text, msg_num):
        """
        Tek bir mesajı belirlenen modda gönderir.
        """
        if not self.target_hwnd or not user32.IsWindow(self.target_hwnd):
            if not self.find_target():
                self.log("❌ Hedef pencere bulunamadı!")
                return False

        if self.mode == "postmessage":
            # PostMessage: Arka Plan Modu (RDP kapalıyken de çalışır)
            target_hwnd, client_x, client_y = post_click(self.target_hwnd, self.click_x, self.click_y)
            time.sleep(0.25)
            post_type_text(target_hwnd, text)
            time.sleep(0.25)
            post_enter(target_hwnd)
            time.sleep(0.10)
        else:
            # SendInput: Ön Plan Modu
            if user32.IsWindow(self.target_hwnd):
                user32.SetForegroundWindow(self.target_hwnd)
                time.sleep(0.10)
            sendinput_click(self.click_x, self.click_y)
            time.sleep(0.25)
            sendinput_type_text(text)
            time.sleep(0.25)
            sendinput_enter()
            time.sleep(0.10)

        self.total_messages_sent += 1
        self.update_counters()
        self.log(f"✉️ Mesaj {msg_num} gönderildi (#{self.total_messages_sent}): '{text[:40]}...'")
        return True

    def _interruptible_sleep(self, duration):
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
