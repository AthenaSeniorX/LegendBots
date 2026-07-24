from __future__ import annotations

import ctypes
import ctypes.wintypes
import logging
from logging.handlers import RotatingFileHandler
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Optional

import config


# Win32 messages and flags
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_CHAR = 0x0102
WM_MOUSEMOVE = 0x0200
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
MK_LBUTTON = 0x0001
VK_RETURN = 0x0D

SMTO_BLOCK = 0x0001
SMTO_ABORTIFHUNG = 0x0002

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79


user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

WNDENUMPROC = ctypes.WINFUNCTYPE(
    ctypes.c_bool,
    ctypes.wintypes.HWND,
    ctypes.wintypes.LPARAM,
)


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


user32.EnumWindows.restype = ctypes.c_bool
user32.EnumWindows.argtypes = [WNDENUMPROC, ctypes.wintypes.LPARAM]
user32.EnumChildWindows.restype = ctypes.c_bool
user32.EnumChildWindows.argtypes = [
    ctypes.wintypes.HWND,
    WNDENUMPROC,
    ctypes.wintypes.LPARAM,
]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextLengthW.argtypes = [ctypes.wintypes.HWND]
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [
    ctypes.wintypes.HWND,
    ctypes.wintypes.LPWSTR,
    ctypes.c_int,
]
user32.GetClassNameW.restype = ctypes.c_int
user32.GetClassNameW.argtypes = [
    ctypes.wintypes.HWND,
    ctypes.wintypes.LPWSTR,
    ctypes.c_int,
]
user32.GetWindowThreadProcessId.restype = ctypes.wintypes.DWORD
user32.GetWindowThreadProcessId.argtypes = [
    ctypes.wintypes.HWND,
    ctypes.POINTER(ctypes.wintypes.DWORD),
]
user32.GetClientRect.restype = ctypes.c_bool
user32.GetClientRect.argtypes = [
    ctypes.wintypes.HWND,
    ctypes.POINTER(ctypes.wintypes.RECT),
]
user32.GetWindowRect.restype = ctypes.c_bool
user32.GetWindowRect.argtypes = [
    ctypes.wintypes.HWND,
    ctypes.POINTER(ctypes.wintypes.RECT),
]
user32.ClientToScreen.restype = ctypes.c_bool
user32.ClientToScreen.argtypes = [
    ctypes.wintypes.HWND,
    ctypes.POINTER(ctypes.wintypes.POINT),
]
user32.ScreenToClient.restype = ctypes.c_bool
user32.ScreenToClient.argtypes = [
    ctypes.wintypes.HWND,
    ctypes.POINTER(ctypes.wintypes.POINT),
]
user32.IsWindow.restype = ctypes.c_bool
user32.IsWindow.argtypes = [ctypes.wintypes.HWND]
user32.IsWindowVisible.restype = ctypes.c_bool
user32.IsWindowVisible.argtypes = [ctypes.wintypes.HWND]
user32.IsWindowEnabled.restype = ctypes.c_bool
user32.IsWindowEnabled.argtypes = [ctypes.wintypes.HWND]
user32.SetForegroundWindow.restype = ctypes.c_bool
user32.SetForegroundWindow.argtypes = [ctypes.wintypes.HWND]
user32.SendInput.restype = ctypes.wintypes.UINT
user32.SendInput.argtypes = [
    ctypes.wintypes.UINT,
    ctypes.POINTER(INPUT),
    ctypes.c_int,
]
user32.SendMessageTimeoutW.restype = ctypes.wintypes.LPARAM
user32.SendMessageTimeoutW.argtypes = [
    ctypes.wintypes.HWND,
    ctypes.wintypes.UINT,
    ctypes.wintypes.WPARAM,
    ctypes.wintypes.LPARAM,
    ctypes.wintypes.UINT,
    ctypes.wintypes.UINT,
    ctypes.POINTER(ctypes.c_size_t),
]
kernel32.GetCurrentProcessId.restype = ctypes.wintypes.DWORD


class BackgroundInputError(RuntimeError):
    """HWND hedefi input mesajını kabul etmediğinde yükseltilir."""


class CoordinateError(ValueError):
    """Pencere içi koordinat hedef client alanının dışında olduğunda yükseltilir."""


@dataclass(frozen=True)
class WindowCandidate:
    hwnd: int
    title: str
    process_id: int
    class_name: str
    client_width: int
    client_height: int

    @property
    def client_area(self) -> int:
        return max(0, self.client_width) * max(0, self.client_height)


@dataclass(frozen=True)
class ChildCandidate:
    hwnd: int
    class_name: str
    left: int
    top: int
    right: int
    bottom: int

    @property
    def area(self) -> int:
        return max(0, self.right - self.left) * max(0, self.bottom - self.top)

    def contains(self, screen_x: int, screen_y: int) -> bool:
        return self.left <= screen_x < self.right and self.top <= screen_y < self.bottom


@dataclass(frozen=True)
class InputTarget:
    hwnd: int
    client_x: int
    client_y: int
    class_name: str


_INPUT_CLASS_PRIORITY = (
    ("chrome_renderwidgethosthwnd", 100),
    ("intermediate d3d window", 95),
    ("macromediaflashplayeractivex", 95),
    ("internet explorer_server", 90),
    ("cef", 85),
    ("chrome_widgetwin", 80),
    ("webview", 75),
)


def _build_file_logger() -> logging.Logger:
    logger = logging.getLogger("legend_chat_advertiser")
    if logger.handlers:
        return logger

    logger.setLevel(logging.INFO)
    log_path = Path(config.BASE_DIR) / "advertiser.log"
    try:
        handler = RotatingFileHandler(
            log_path,
            maxBytes=2_000_000,
            backupCount=3,
            encoding="utf-8",
        )
        handler.setFormatter(
            logging.Formatter("%(asctime)s | %(levelname)s | %(message)s")
        )
        logger.addHandler(handler)
    except OSError:
        logger.addHandler(logging.NullHandler())
    return logger


_FILE_LOGGER = _build_file_logger()


def make_lparam(x: int, y: int) -> int:
    return ((int(y) & 0xFFFF) << 16) | (int(x) & 0xFFFF)


def _get_window_text(hwnd: int) -> str:
    length = int(user32.GetWindowTextLengthW(hwnd))
    if length <= 0:
        return ""
    buffer = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buffer, length + 1)
    return buffer.value


def _get_class_name(hwnd: int) -> str:
    buffer = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buffer, len(buffer))
    return buffer.value


def _get_process_id(hwnd: int) -> int:
    process_id = ctypes.wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(process_id))
    return int(process_id.value)


def get_client_size(hwnd: int) -> tuple[int, int]:
    rect = ctypes.wintypes.RECT()
    if not user32.GetClientRect(hwnd, ctypes.byref(rect)):
        raise BackgroundInputError(f"Client alanı okunamadı (HWND: {hwnd}).")
    return max(0, rect.right - rect.left), max(0, rect.bottom - rect.top)


def _window_candidate(hwnd: int) -> WindowCandidate:
    width, height = get_client_size(hwnd)
    return WindowCandidate(
        hwnd=int(hwnd),
        title=_get_window_text(hwnd),
        process_id=_get_process_id(hwnd),
        class_name=_get_class_name(hwnd),
        client_width=width,
        client_height=height,
    )


def select_window_candidate(
    candidates: Iterable[WindowCandidate],
    keyword: str,
    current_process_id: Optional[int] = None,
) -> Optional[WindowCandidate]:
    """Kendi GUI sürecini dışlayıp en olası oyun penceresini seçer."""
    needle = keyword.strip().casefold()
    if not needle:
        return None

    current_pid = (
        int(kernel32.GetCurrentProcessId())
        if current_process_id is None
        else int(current_process_id)
    )
    eligible = [
        candidate
        for candidate in candidates
        if candidate.process_id != current_pid
        and needle in candidate.title.casefold()
        and candidate.client_area > 0
    ]
    if not eligible:
        return None

    def score(candidate: WindowCandidate) -> tuple[int, int, int]:
        exact_title = int(candidate.title.strip().casefold() == needle)
        likely_game_class = int(
            any(
                token in candidate.class_name.casefold()
                for token in ("chrome", "cef", "flash", "browser")
            )
        )
        return candidate.client_area, likely_game_class, exact_title

    return max(eligible, key=score)


def enumerate_windows_by_keyword(keyword: str) -> list[WindowCandidate]:
    candidates: list[WindowCandidate] = []
    needle = keyword.strip().casefold()
    if not needle:
        return candidates

    def enum_callback(hwnd: int, _lparam: int) -> bool:
        try:
            if not user32.IsWindowVisible(hwnd):
                return True
            title = _get_window_text(hwnd)
            if needle not in title.casefold():
                return True
            candidates.append(_window_candidate(hwnd))
        except (OSError, BackgroundInputError):
            pass
        return True

    callback = WNDENUMPROC(enum_callback)
    user32.EnumWindows(callback, 0)
    return candidates


def find_window_by_keyword(keyword: str) -> Optional[tuple[int, str]]:
    candidate = select_window_candidate(enumerate_windows_by_keyword(keyword), keyword)
    if candidate is None:
        return None
    return candidate.hwnd, candidate.title


def _input_class_priority(class_name: str) -> int:
    folded = class_name.casefold()
    for token, priority in _INPUT_CLASS_PRIORITY:
        if token in folded:
            return priority
    return 0


def select_input_child(
    children: Iterable[ChildCandidate],
    screen_x: int,
    screen_y: int,
) -> Optional[ChildCandidate]:
    """Noktayı kapsayan CEF/Flash render child HWND'sini seçer."""
    containing = [
        child
        for child in children
        if child.contains(screen_x, screen_y) and child.area > 0
    ]
    if not containing:
        return None

    preferred = [child for child in containing if _input_class_priority(child.class_name)]
    pool = preferred or containing
    return max(
        pool,
        key=lambda child: (
            _input_class_priority(child.class_name),
            -child.area,
        ),
    )


def _enumerate_child_candidates(parent_hwnd: int) -> list[ChildCandidate]:
    children: list[ChildCandidate] = []

    def enum_callback(hwnd: int, _lparam: int) -> bool:
        try:
            if not user32.IsWindowVisible(hwnd) or not user32.IsWindowEnabled(hwnd):
                return True
            rect = ctypes.wintypes.RECT()
            if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                return True
            children.append(
                ChildCandidate(
                    hwnd=int(hwnd),
                    class_name=_get_class_name(hwnd),
                    left=int(rect.left),
                    top=int(rect.top),
                    right=int(rect.right),
                    bottom=int(rect.bottom),
                )
            )
        except OSError:
            pass
        return True

    callback = WNDENUMPROC(enum_callback)
    user32.EnumChildWindows(parent_hwnd, callback, 0)
    return children


def client_to_screen_coords(hwnd: int, client_x: int, client_y: int) -> tuple[int, int]:
    point = ctypes.wintypes.POINT(int(client_x), int(client_y))
    if not user32.ClientToScreen(hwnd, ctypes.byref(point)):
        raise BackgroundInputError(
            f"Pencere koordinatı ekrana çevrilemedi (HWND: {hwnd})."
        )
    return int(point.x), int(point.y)


def screen_to_client_coords(hwnd: int, screen_x: int, screen_y: int) -> tuple[int, int]:
    point = ctypes.wintypes.POINT(int(screen_x), int(screen_y))
    if not user32.ScreenToClient(hwnd, ctypes.byref(point)):
        raise BackgroundInputError(
            f"Ekran koordinatı pencereye çevrilemedi (HWND: {hwnd})."
        )
    return int(point.x), int(point.y)


def validate_client_point(parent_hwnd: int, client_x: int, client_y: int) -> tuple[int, int]:
    width, height = get_client_size(parent_hwnd)
    if width <= 0 or height <= 0:
        raise CoordinateError(
            f"Hedef pencerenin client alanı geçersiz: {width}x{height}."
        )
    if not (0 <= int(client_x) < width and 0 <= int(client_y) < height):
        raise CoordinateError(
            "Chat koordinatı pencere dışında: "
            f"({client_x}, {client_y}); geçerli alan 0..{width - 1}, 0..{height - 1}."
        )
    return width, height


def resolve_input_target(
    parent_hwnd: int,
    client_x: int,
    client_y: int,
) -> InputTarget:
    """
    Gül botundaki yaklaşımla pencere içindeki CEF/Flash render HWND'sini bulur.

    WindowFromPoint kullanılmaz; böylece oyun başka bir pencerenin arkasındayken
    veya RDP bağlantısı kesildiğinde masaüstü z-order'ına bağımlı kalınmaz.
    """
    if not user32.IsWindow(parent_hwnd):
        raise BackgroundInputError(f"Hedef pencere artık mevcut değil (HWND: {parent_hwnd}).")

    validate_client_point(parent_hwnd, client_x, client_y)
    screen_x, screen_y = client_to_screen_coords(parent_hwnd, client_x, client_y)
    selected = select_input_child(
        _enumerate_child_candidates(parent_hwnd),
        screen_x,
        screen_y,
    )
    target_hwnd = selected.hwnd if selected else int(parent_hwnd)
    target_class = selected.class_name if selected else _get_class_name(parent_hwnd)
    target_x, target_y = screen_to_client_coords(target_hwnd, screen_x, screen_y)
    return InputTarget(target_hwnd, target_x, target_y, target_class)


def inspect_window(
    hwnd: int,
    title: str,
    client_x: int,
    client_y: int,
) -> dict[str, object]:
    if not user32.IsWindow(hwnd):
        raise BackgroundInputError(f"Hedef pencere artık mevcut değil (HWND: {hwnd}).")
    width, height = validate_client_point(hwnd, client_x, client_y)
    input_target = resolve_input_target(hwnd, client_x, client_y)
    return {
        "hwnd": hwnd,
        "title": title,
        "process_id": _get_process_id(hwnd),
        "class_name": _get_class_name(hwnd),
        "client_width": width,
        "client_height": height,
        "input_hwnd": input_target.hwnd,
        "input_class_name": input_target.class_name,
        "input_x": input_target.client_x,
        "input_y": input_target.client_y,
    }


def inspect_target(keyword: str, client_x: int, client_y: int) -> dict[str, object]:
    target = find_window_by_keyword(keyword)
    if target is None:
        raise BackgroundInputError(
            f"'{keyword}' ifadesini içeren oyun penceresi bulunamadı."
        )
    return inspect_window(target[0], target[1], client_x, client_y)


def _send_window_message(
    hwnd: int,
    message: int,
    wparam: int = 0,
    lparam: int = 0,
    timeout_ms: int = 1500,
) -> int:
    if not user32.IsWindow(hwnd):
        raise BackgroundInputError(f"Input HWND artık mevcut değil: {hwnd}.")

    result_value = ctypes.c_size_t()
    accepted = user32.SendMessageTimeoutW(
        hwnd,
        message,
        wparam,
        lparam,
        SMTO_BLOCK | SMTO_ABORTIFHUNG,
        timeout_ms,
        ctypes.byref(result_value),
    )
    if not accepted:
        raise BackgroundInputError(
            f"HWND {hwnd} mesajı kabul etmedi veya {timeout_ms} ms içinde yanıt vermedi "
            f"(WM=0x{message:04X})."
        )
    return int(result_value.value)


def post_click(parent_hwnd: int, client_x: int, client_y: int) -> InputTarget:
    """Arka planda, fiziksel fareyi oynatmadan HWND'ye tek tıklama iletir."""
    target = resolve_input_target(parent_hwnd, client_x, client_y)
    lparam = make_lparam(target.client_x, target.client_y)
    _send_window_message(target.hwnd, WM_MOUSEMOVE, 0, lparam)
    time.sleep(0.04)
    _send_window_message(target.hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lparam)
    time.sleep(0.08)
    _send_window_message(target.hwnd, WM_LBUTTONUP, 0, lparam)
    return target


def post_type_text(target_hwnd: int, text: str) -> None:
    """Clipboard ve klavye düzeninden bağımsız WM_CHAR yazımı."""
    for char in str(text):
        codepoint = ord(char)
        if codepoint <= 0xFFFF:
            units = (codepoint,)
        else:
            adjusted = codepoint - 0x10000
            units = (
                0xD800 + (adjusted >> 10),
                0xDC00 + (adjusted & 0x3FF),
            )
        for unit in units:
            _send_window_message(target_hwnd, WM_CHAR, unit, 1)
        time.sleep(0.012)


def post_enter(target_hwnd: int) -> None:
    """Gerçekçi scan-code lParam değerleriyle Enter gönderir."""
    _send_window_message(target_hwnd, WM_KEYDOWN, VK_RETURN, 0x001C0001)
    time.sleep(0.04)
    _send_window_message(target_hwnd, WM_KEYUP, VK_RETURN, 0xC01C0001)


def _send_input(*inputs: INPUT) -> None:
    if not inputs:
        return
    array = (INPUT * len(inputs))(*inputs)
    sent = user32.SendInput(len(inputs), array, ctypes.sizeof(INPUT))
    if int(sent) != len(inputs):
        raise BackgroundInputError(
            f"SendInput yalnızca {sent}/{len(inputs)} olayı iletebildi."
        )


def _screen_to_absolute(screen_x: int, screen_y: int) -> tuple[int, int]:
    left = int(user32.GetSystemMetrics(SM_XVIRTUALSCREEN))
    top = int(user32.GetSystemMetrics(SM_YVIRTUALSCREEN))
    width = int(user32.GetSystemMetrics(SM_CXVIRTUALSCREEN))
    height = int(user32.GetSystemMetrics(SM_CYVIRTUALSCREEN))
    if width <= 1 or height <= 1:
        raise BackgroundInputError("Windows sanal ekran boyutu okunamadı.")
    abs_x = round((int(screen_x) - left) * 65535 / (width - 1))
    abs_y = round((int(screen_y) - top) * 65535 / (height - 1))
    return abs_x, abs_y


def sendinput_click(screen_x: int, screen_y: int) -> None:
    abs_x, abs_y = _screen_to_absolute(screen_x, screen_y)
    common_flags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK

    move = INPUT()
    move.type = INPUT_MOUSE
    move.union.mi.dx = abs_x
    move.union.mi.dy = abs_y
    move.union.mi.dwFlags = MOUSEEVENTF_MOVE | common_flags

    down = INPUT()
    down.type = INPUT_MOUSE
    down.union.mi.dx = abs_x
    down.union.mi.dy = abs_y
    down.union.mi.dwFlags = MOUSEEVENTF_LEFTDOWN | common_flags

    up = INPUT()
    up.type = INPUT_MOUSE
    up.union.mi.dx = abs_x
    up.union.mi.dy = abs_y
    up.union.mi.dwFlags = MOUSEEVENTF_LEFTUP | common_flags

    _send_input(move)
    time.sleep(0.04)
    _send_input(down)
    time.sleep(0.05)
    _send_input(up)


def sendinput_type_text(text: str) -> None:
    for char in str(text):
        codepoint = ord(char)
        if codepoint > 0xFFFF:
            raise BackgroundInputError(
                "Ön plan SendInput modu BMP dışı Unicode karakter desteklemiyor."
            )

        down = INPUT()
        down.type = INPUT_KEYBOARD
        down.union.ki.wScan = codepoint
        down.union.ki.dwFlags = KEYEVENTF_UNICODE

        up = INPUT()
        up.type = INPUT_KEYBOARD
        up.union.ki.wScan = codepoint
        up.union.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
        _send_input(down, up)
        time.sleep(0.01)


def sendinput_enter() -> None:
    down = INPUT()
    down.type = INPUT_KEYBOARD
    down.union.ki.wVk = VK_RETURN

    up = INPUT()
    up.type = INPUT_KEYBOARD
    up.union.ki.wVk = VK_RETURN
    up.union.ki.dwFlags = KEYEVENTF_KEYUP
    _send_input(down, up)


class LegendBotEngine:
    def __init__(
        self,
        log_callback: Optional[Callable[[str], None]] = None,
        alert_callback: Optional[Callable[[str, str], None]] = None,
        status_callback: Optional[Callable[[str], None]] = None,
        counter_callback: Optional[Callable[[int], None]] = None,
    ):
        self.log_cb = log_callback or print
        self.alert_cb = alert_callback or (lambda title, message: print(f"{title}: {message}"))
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
        self.mode = "postmessage"

        self.target_hwnd: Optional[int] = None
        self.target_title = ""
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    def log(self, message: str, level: int = logging.INFO) -> None:
        _FILE_LOGGER.log(level, message)
        self.log_cb(f"[{time.strftime('%H:%M:%S')}] {message}")

    def update_status(self, status: str) -> None:
        self.status_cb(status)

    def update_counters(self) -> None:
        self.counter_cb(self.total_messages_sent)

    def find_target(self) -> bool:
        result = find_window_by_keyword(self.window_keyword)
        if result:
            self.target_hwnd, self.target_title = result
            return True
        self.target_hwnd = None
        self.target_title = ""
        return False

    def _validate_settings(self) -> None:
        if not self.msg1.strip() or not self.msg2.strip():
            raise ValueError("İki reklam mesajı da dolu olmalıdır.")
        if self.cycle_interval < 0:
            raise ValueError("Reklam döngü aralığı negatif olamaz.")
        if self.inter_delay < 0:
            raise ValueError("Mesajlar arası bekleme negatif olamaz.")
        if self.mode not in {"postmessage", "sendinput"}:
            raise ValueError(f"Bilinmeyen çalışma modu: {self.mode}")

    def start(
        self,
        msg1: Optional[str] = None,
        msg2: Optional[str] = None,
        interval: Optional[float] = None,
        click_x: Optional[int] = None,
        click_y: Optional[int] = None,
        keyword: Optional[str] = None,
        mode: Optional[str] = None,
    ) -> bool:
        if self.is_running:
            self.log("Bot zaten çalışıyor.")
            return False
        if self._thread is not None and self._thread.is_alive():
            self.log(
                "Önceki bot döngüsü hâlâ kapanıyor; birkaç saniye sonra yeniden başlatın.",
                logging.WARNING,
            )
            return False

        if msg1 is not None:
            self.msg1 = str(msg1)
        if msg2 is not None:
            self.msg2 = str(msg2)
        if interval is not None:
            self.cycle_interval = float(interval)
        if click_x is not None:
            self.click_x = int(click_x)
        if click_y is not None:
            self.click_y = int(click_y)
        if keyword is not None:
            self.window_keyword = str(keyword).strip()
        if mode is not None:
            self.mode = str(mode)

        try:
            self._validate_settings()
        except (TypeError, ValueError) as exc:
            self.log(f"AYAR HATASI: {exc}", logging.ERROR)
            self.alert_cb("Geçersiz Ayar", str(exc))
            return False

        if not self.find_target():
            message = (
                f"'{self.window_keyword}' ifadesini içeren oyun penceresi bulunamadı.\n\n"
                "Oyunun açık olduğundan ve botla aynı Windows oturumunda çalıştığından "
                "emin olun."
            )
            self.log(f"HEDEF HATASI: {message.replace(os.linesep, ' ')}", logging.ERROR)
            self.alert_cb("Pencere Bulunamadı", message)
            return False

        try:
            details = inspect_window(
                self.target_hwnd,
                self.target_title,
                self.click_x,
                self.click_y,
            )
        except (BackgroundInputError, CoordinateError) as exc:
            self.log(f"HEDEF HATASI: {exc}", logging.ERROR)
            self.alert_cb("Hedef/Koordinat Hatası", str(exc))
            self.target_hwnd = None
            return False

        mode_name = (
            "Arka Plan HWND (SendMessageTimeout)"
            if self.mode == "postmessage"
            else "Ön Plan (SendInput)"
        )
        self.log(
            "Hedef hazır: "
            f"'{self.target_title}' | HWND={self.target_hwnd} | "
            f"client={details['client_width']}x{details['client_height']} | "
            f"input HWND={details['input_hwnd']} ({details['input_class_name'] or 'sınıfsız'})"
        )
        self.log(
            f"Koordinat (client): ({self.click_x}, {self.click_y}) | Mod: {mode_name}"
        )

        self.is_running = True
        self.is_paused = False
        self.total_messages_sent = 0
        self._stop_event.clear()
        self.update_counters()
        self.update_status("Çalışıyor")

        self._thread = threading.Thread(
            target=self._run_loop,
            name="LegendChatAdvertiser",
            daemon=True,
        )
        self._thread.start()
        self.log("Bot başlatıldı; reklam döngüsü aktif.")
        return True

    def pause(self) -> None:
        if not self.is_running:
            return
        self.is_paused = not self.is_paused
        status = "Duraklatıldı" if self.is_paused else "Çalışıyor"
        self.log(f"Bot {status.lower()}.")
        self.update_status(status)

    def stop(self) -> None:
        was_running = self.is_running
        self.is_running = False
        self.is_paused = False
        self._stop_event.set()
        if was_running:
            self.log("Bot durduruldu.")
        self.update_status("Durduruldu")

    def _deliver_message(self, hwnd: int, text: str) -> InputTarget:
        if self.mode == "postmessage":
            input_target = post_click(hwnd, self.click_x, self.click_y)
            time.sleep(0.20)
            post_type_text(input_target.hwnd, text)
            time.sleep(0.15)
            post_enter(input_target.hwnd)
            return input_target

        validate_client_point(hwnd, self.click_x, self.click_y)
        screen_x, screen_y = client_to_screen_coords(hwnd, self.click_x, self.click_y)
        if not user32.SetForegroundWindow(hwnd):
            self.log(
                "Ön plan modunda oyun odağı doğrulanamadı; SendInput yine denenecek.",
                logging.WARNING,
            )
        time.sleep(0.12)
        sendinput_click(screen_x, screen_y)
        time.sleep(0.20)
        sendinput_type_text(text)
        time.sleep(0.15)
        sendinput_enter()
        return InputTarget(hwnd, self.click_x, self.click_y, _get_class_name(hwnd))

    def test_send_once(
        self,
        text: str,
        click_x: Optional[int] = None,
        click_y: Optional[int] = None,
        keyword: Optional[str] = None,
        mode: Optional[str] = None,
    ) -> bool:
        if self.is_running:
            self.log(
                "Test iletimi reddedildi: çalışan reklam döngüsüyle aynı anda test gönderilemez.",
                logging.WARNING,
            )
            return False

        cx = int(click_x) if click_x is not None else self.click_x
        cy = int(click_y) if click_y is not None else self.click_y
        kw = (keyword or self.window_keyword).strip()
        selected_mode = mode or self.mode
        if selected_mode not in {"postmessage", "sendinput"}:
            self.log(f"TEST HATASI: bilinmeyen mod '{selected_mode}'.", logging.ERROR)
            return False

        target = find_window_by_keyword(kw)
        if target is None:
            self.log(
                f"TEST HATASI: '{kw}' ifadesini içeren oyun penceresi bulunamadı.",
                logging.ERROR,
            )
            return False

        hwnd, title = target
        previous = (self.click_x, self.click_y, self.mode)
        self.click_x, self.click_y, self.mode = cx, cy, selected_mode
        self.log(
            f"Test iletimi: HWND={hwnd} ('{title}') | client=({cx}, {cy}) | "
            f"mod={selected_mode}"
        )
        try:
            input_target = self._deliver_message(hwnd, text)
        except (BackgroundInputError, CoordinateError, OSError) as exc:
            self.log(f"TEST BAŞARISIZ: {exc}", logging.ERROR)
            return False
        finally:
            self.click_x, self.click_y, self.mode = previous

        self.log(
            "Test input'u Windows tarafından kabul edildi: "
            f"input HWND={input_target.hwnd} ({input_target.class_name or 'sınıfsız'}). "
            "Mesajın oyun sohbetinde göründüğünü elle kontrol edin."
        )
        return True

    def _send_message(self, text: str, message_number: int) -> bool:
        if not self.target_hwnd or not user32.IsWindow(self.target_hwnd):
            if not self.find_target():
                self.log(
                    "Oyun penceresi şu anda yok; 3 saniye sonra yeniden aranacak.",
                    logging.WARNING,
                )
                self.update_status("Hedef bekleniyor")
                return False
            self.log(
                f"Oyun penceresi yeniden bulundu: '{self.target_title}' "
                f"(HWND={self.target_hwnd})."
            )
            self.update_status("Çalışıyor")

        try:
            input_target = self._deliver_message(self.target_hwnd, text)
        except (BackgroundInputError, CoordinateError, OSError) as exc:
            self.log(f"Mesaj {message_number} iletilemedi: {exc}", logging.ERROR)
            self.target_hwnd = None
            self.target_title = ""
            self.update_status("Hedef bekleniyor")
            return False

        self.total_messages_sent += 1
        self.update_counters()
        self.log(
            f"Mesaj {message_number} input'u kabul edildi "
            f"(#{self.total_messages_sent}, input HWND={input_target.hwnd}): "
            f"'{text[:60]}{'…' if len(text) > 60 else ''}'"
        )
        return True

    def _interruptible_sleep(self, duration: float) -> bool:
        remaining = max(0.0, float(duration))
        last_tick = time.monotonic()
        while remaining > 0:
            if not self.is_running or self._stop_event.is_set():
                return False
            if self.is_paused:
                last_tick = time.monotonic()
                self._stop_event.wait(0.2)
                continue

            wait_for = min(0.2, remaining)
            if self._stop_event.wait(wait_for):
                return False
            now = time.monotonic()
            remaining -= now - last_tick
            last_tick = now
        return self.is_running

    def _run_loop(self) -> None:
        try:
            while self.is_running:
                if self.is_paused:
                    if not self._interruptible_sleep(0.2):
                        break
                    continue

                if not self._send_message(self.msg1, 1):
                    if not self._interruptible_sleep(3.0):
                        break
                    continue

                self.log(f"Mesajlar arasında {self.inter_delay:g} saniye bekleniyor.")
                if not self._interruptible_sleep(self.inter_delay):
                    break

                if not self._send_message(self.msg2, 2):
                    if not self._interruptible_sleep(3.0):
                        break
                    continue

                self.log(
                    f"Döngü tamamlandı; toplam {self.total_messages_sent} input kabulü. "
                    f"Sonraki döngü {self.cycle_interval:g} saniye sonra."
                )
                if not self._interruptible_sleep(self.cycle_interval):
                    break
        except Exception as exc:
            _FILE_LOGGER.exception("Beklenmeyen bot döngüsü hatası")
            self.log(f"BEKLENMEYEN BOT HATASI: {exc}", logging.ERROR)
        finally:
            self.is_running = False
            self.is_paused = False
            self._stop_event.set()
            self.update_status("Durduruldu")
