from __future__ import annotations

import argparse
import ctypes
import json
import logging
import os
import random
import shutil
import string
import subprocess
import sys
import tempfile
import time
import warnings
from dataclasses import dataclass
from datetime import datetime
from getpass import getpass
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Callable

import cv2
import numpy as np
import pyautogui
import pyperclip
from PIL import Image
from pywinauto import Application


BASE_DIR = Path(__file__).resolve().parent
LOGGER = logging.getLogger("legendbots")

WEB_URL = "https://lotr.creaction-network.com/serverlist/s1411"
WEB_EMAIL_IMAGE = BASE_DIR / "web_email.png"
WEB_PASSWORD_IMAGE = BASE_DIR / "web_password.png"
WEB_LOGIN_IMAGE = BASE_DIR / "web_login_btn.png"
CLIENT_ENTER_IMAGE = BASE_DIR / "giris1.png"
CLIENT_DICE_IMAGE = BASE_DIR / "character_dice.png"
PROGRESS_FILE = BASE_DIR / "completed_accounts.json"

DEFAULT_EMAIL_PREFIX = "hadestxz"
DEFAULT_EMAIL_DOMAIN = "outlook.com"
DEFAULT_START_INDEX = 1
DEFAULT_ACCOUNT_COUNT = 4

# PyAutoGUI'nun acil durdurma mekanizması açık kalır. Fareyi ekranın sol üst
# köşesine götürmek veya Ctrl+C kullanmak otomasyonu güvenli biçimde keser.
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.08


class AutomationError(RuntimeError):
    """Kurtarılabilir bir otomasyon adımı tamamlanamadığında kullanılır."""


class ImageTimeoutError(AutomationError):
    """Beklenen ekran görseli süre içinde bulunamadığında kullanılır."""


@dataclass(frozen=True)
class WebLoginConfig:
    url: str = WEB_URL
    confidence: float = 0.8
    page_timeout: float = 30.0
    poll_interval: float = 0.75
    initial_wait: float = 5.0
    alert_duration: float = 5.0
    field_x_offset: int = 100


@dataclass(frozen=True)
class ClientConfig:
    image_timeout: float = 45.0
    # Canlı istemcide mevcut Oyuna Gir kırpıntısının ölçekli eşleşmesi 0.687
    # verdi. Arama yalnızca aynı PID'nin pencere bölgesinde yapıldığı için 0.65
    # hem güvenli hem de DPI/Flash render farklarına dayanıklıdır.
    confidence: float = 0.65
    startup_wait: float = 6.0
    character_wait: float = 3.0
    blue_bar_timeout: float = 35.0
    post_verification_wait: float = 0.75

    # Legend Online penceresi içindeki sabit oranlar. Mutlak ekran koordinatı
    # kullanılmadığı için pencere farklı bir konumda açılsa da geçerlidir.
    email_position: tuple[float, float] = (0.583, 0.647)
    password_position: tuple[float, float] = (0.585, 0.728)
    login_position: tuple[float, float] = (0.865, 0.661)


class ProgressStore:
    """Kurulmuş hesapları atomik bir JSON dosyasında kalıcı olarak tutar."""

    def __init__(
        self,
        path: Path,
        accounts: dict[str, dict[str, Any]],
        pending_verification: dict[str, dict[str, Any]] | None = None,
        failed_attempts: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        self.path = path
        self.accounts = accounts
        self.pending_verification = pending_verification or {}
        self.failed_attempts = failed_attempts or {}

    @classmethod
    def load(cls, path: Path = PROGRESS_FILE) -> "ProgressStore":
        if not path.exists():
            return cls(path, {})

        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise AutomationError(
                f"İlerleme dosyası okunamıyor; hesapları tekrar çalıştırmamak için duruldu: {path}"
            ) from exc

        if not isinstance(raw, dict) or raw.get("version") != 1:
            raise AutomationError(f"İlerleme dosyası biçimi geçersiz: {path}")
        raw_accounts = raw.get("completed_accounts")
        if not isinstance(raw_accounts, dict):
            raise AutomationError(f"İlerleme dosyasında completed_accounts bulunamadı: {path}")

        accounts: dict[str, dict[str, Any]] = {}
        for email, details in raw_accounts.items():
            if not isinstance(email, str) or not isinstance(details, dict):
                raise AutomationError(f"İlerleme dosyasında geçersiz hesap kaydı var: {path}")
            accounts[email.strip().lower()] = dict(details)

        pending = raw.get("pending_verification", {})
        failures = raw.get("failed_attempts", {})
        if not isinstance(pending, dict) or not isinstance(failures, dict):
            raise AutomationError(f"İlerleme dosyasındaki deneme kayıtları geçersiz: {path}")
        normalized_pending = {
            str(email).strip().lower(): dict(details)
            for email, details in pending.items()
            if isinstance(details, dict)
        }
        normalized_failures = {
            str(email).strip().lower(): dict(details)
            for email, details in failures.items()
            if isinstance(details, dict)
        }
        return cls(path, accounts, normalized_pending, normalized_failures)

    def is_completed(self, email: str) -> bool:
        return email.strip().lower() in self.accounts

    def details(self, email: str) -> dict[str, Any] | None:
        return self.accounts.get(email.strip().lower())

    def pending_details(self, email: str) -> dict[str, Any] | None:
        return self.pending_verification.get(email.strip().lower())

    def _persist(self) -> None:
        payload = {
            "version": 1,
            "completed_accounts": dict(sorted(self.accounts.items())),
            "pending_verification": dict(sorted(self.pending_verification.items())),
            "failed_attempts": dict(sorted(self.failed_attempts.items())),
        }
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        try:
            with temporary.open("w", encoding="utf-8", newline="\n") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        except OSError as exc:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            raise AutomationError(f"İlerleme kaydı atomik olarak yazılamadı: {self.path}") from exc

    def mark_submitted(self, email: str, nickname: str) -> None:
        normalized_email = email.strip().lower()
        self.pending_verification[normalized_email] = {
            "nickname": nickname,
            "submitted_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        }
        self._persist()
        LOGGER.info("Karakter gönderimi doğrulama bekliyor: %s | karakter=%s", email, nickname)

    def mark_completed(self, email: str, nickname: str) -> None:
        normalized_email = email.strip().lower()
        self.accounts[normalized_email] = {
            "nickname": nickname,
            "completed_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "verification": {
                "email_progress_key": normalized_email,
                "two_blue_loading_bars": True,
            },
        }
        self.pending_verification.pop(normalized_email, None)
        self.failed_attempts.pop(normalized_email, None)
        self._persist()
        LOGGER.info(
            "Hesap çift doğrulamayla tamamlandı: %s | e-posta=OK | iki_mavi_bar=OK",
            email,
        )

    def mark_manually_verified(self, email: str, nickname: str) -> None:
        """Kullanıcının açıkça doğruladığı eski hesapları güvenli biçimde işler."""
        normalized_email = email.strip().lower()
        self.accounts[normalized_email] = {
            "nickname": nickname,
            "completed_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "verification": {
                "email_progress_key": normalized_email,
                "manual_user_confirmation": True,
            },
        }
        self.pending_verification.pop(normalized_email, None)
        self.failed_attempts.pop(normalized_email, None)
        self._persist()
        LOGGER.info("Hesap kullanıcı onayıyla tamamlandı: %s", email)

    def record_failure(self, email: str, error: str) -> int:
        normalized_email = email.strip().lower()
        previous = self.failed_attempts.get(normalized_email, {})
        count = int(previous.get("count", 0)) + 1
        self.failed_attempts[normalized_email] = {
            "count": count,
            "last_error": error[:1000],
            "last_attempt_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        }
        self._persist()
        return count


def setup_logging() -> None:
    LOGGER.setLevel(logging.DEBUG)
    LOGGER.handlers.clear()

    console = logging.StreamHandler()
    console.setLevel(logging.INFO)
    console.setFormatter(logging.Formatter("%(asctime)s | %(levelname)s | %(message)s", "%H:%M:%S"))

    log_file = RotatingFileHandler(
        BASE_DIR / "automation.log",
        maxBytes=1_000_000,
        backupCount=3,
        encoding="utf-8",
    )
    log_file.setLevel(logging.DEBUG)
    log_file.setFormatter(
        logging.Formatter("%(asctime)s | %(levelname)s | %(name)s | %(message)s")
    )

    LOGGER.addHandler(console)
    LOGGER.addHandler(log_file)


def generate_nickname(length: int = 12) -> str:
    """Yalnızca A-Z ve 1-9 karakterlerinden oluşan oyun adını üretir."""
    alphabet = string.ascii_uppercase + "123456789"
    return "".join(random.choices(alphabet, k=length))


def _registry_app_path(executable: str) -> Path | None:
    if sys.platform != "win32":
        return None

    try:
        import winreg
    except ImportError:
        return None

    key_name = rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{executable}"
    roots = (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE)
    views = (0, getattr(winreg, "KEY_WOW64_64KEY", 0), getattr(winreg, "KEY_WOW64_32KEY", 0))

    for root in roots:
        for view in views:
            try:
                with winreg.OpenKey(root, key_name, 0, winreg.KEY_READ | view) as key:
                    value, _ = winreg.QueryValueEx(key, None)
                    candidate = Path(os.path.expandvars(str(value))).expanduser()
                    if candidate.is_file():
                        return candidate.resolve()
            except OSError:
                continue
    return None


def get_chrome_path(explicit_path: str | Path | None = None) -> Path | None:
    """Chrome'u açık bir kullanıcı penceresine dokunmadan bulur."""
    candidates: list[Path] = []
    if explicit_path:
        candidates.append(Path(explicit_path).expanduser())

    registry_path = _registry_app_path("chrome.exe")
    if registry_path:
        candidates.append(registry_path)

    candidates.extend(
        [
            Path(os.environ.get("PROGRAMFILES", r"C:\Program Files"))
            / "Google/Chrome/Application/chrome.exe",
            Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"))
            / "Google/Chrome/Application/chrome.exe",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
        ]
    )

    from_path = shutil.which("chrome.exe") or shutil.which("chrome")
    if from_path:
        candidates.append(Path(from_path))

    seen: set[str] = set()
    for candidate in candidates:
        normalized = os.path.normcase(os.path.abspath(os.path.expandvars(str(candidate))))
        if normalized in seen:
            continue
        seen.add(normalized)
        path = Path(normalized)
        if path.is_file():
            return path.resolve()
    return None


def get_client_path(explicit_path: str | Path | None = None) -> Path | None:
    candidates: list[Path] = []
    if explicit_path:
        candidates.append(Path(explicit_path).expanduser())

    candidates.extend(
        [
            Path(r"C:\Program Files (x86)\Legend Online\Legend Online.exe"),
            Path(r"C:\Program Files\Legend Online Client by Brov (64-bit)\LegendOnline.exe"),
            Path(r"C:\Program Files (x86)\Legend Online Client by Brov (64-bit)\LegendOnline.exe"),
        ]
    )

    for candidate in candidates:
        expanded = Path(os.path.expandvars(str(candidate))).expanduser()
        if expanded.is_file():
            return expanded.resolve()
    return None


def _validate_image(path: Path) -> None:
    if not path.is_file():
        raise AutomationError(f"Görsel dosyası bulunamadı: {path}")
    try:
        with Image.open(path) as image:
            image.verify()
    except Exception as exc:
        raise AutomationError(f"Görsel dosyası okunamıyor: {path}") from exc


def preflight(
    chrome_path: str | Path | None = None,
    client_path: str | Path | None = None,
) -> tuple[Path, Path]:
    if sys.platform != "win32":
        raise AutomationError("Bu otomasyon yalnızca Windows üzerinde çalışır.")

    for image_path in (
        WEB_EMAIL_IMAGE,
        WEB_PASSWORD_IMAGE,
        WEB_LOGIN_IMAGE,
        CLIENT_ENTER_IMAGE,
        CLIENT_DICE_IMAGE,
    ):
        _validate_image(image_path)

    chrome = get_chrome_path(chrome_path)
    if chrome is None:
        raise AutomationError("Google Chrome bulunamadı. --chrome ile chrome.exe yolunu verin.")

    client = get_client_path(client_path)
    if client is None:
        raise AutomationError("Legend Online istemcisi bulunamadı. --client ile exe yolunu verin.")

    screen = pyautogui.size()
    if screen.width < 800 or screen.height < 600:
        raise AutomationError(f"Ekran çözünürlüğü otomasyon için çok düşük: {screen.width}x{screen.height}")

    LOGGER.info("Ön kontrol başarılı | ekran=%sx%s", screen.width, screen.height)
    LOGGER.info("Chrome: %s", chrome)
    LOGGER.info("İstemci: %s", client)
    return chrome, client


def _locate_image(
    image_path: Path,
    *,
    confidence: float,
    timeout: float,
    poll_interval: float,
    description: str,
) -> Any:
    _validate_image(image_path)
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None

    LOGGER.info("%s aranıyor...", description)
    while time.monotonic() < deadline:
        try:
            location = pyautogui.locateOnScreen(str(image_path), confidence=confidence)
            if location is not None:
                LOGGER.debug("%s bulundu: %s", description, location)
                return location
        except pyautogui.ImageNotFoundException as exc:
            last_error = exc
        except (OSError, ValueError) as exc:
            raise AutomationError(f"{description} aranırken görsel işlenemedi: {exc}") from exc
        time.sleep(poll_interval)

    message = f"{description} {timeout:.0f} saniye içinde bulunamadı ({image_path.name})."
    if last_error:
        LOGGER.debug("Son ekran eşleştirme hatası: %r", last_error)
    raise ImageTimeoutError(message)


def _click_location(
    location: Any,
    *,
    x_offset: int = 0,
    y_offset: int = 0,
    clicks: int = 1,
) -> tuple[int, int]:
    center = pyautogui.center(location)
    x = int(center.x + x_offset)
    y = int(center.y + y_offset)
    pyautogui.click(x=x, y=y, clicks=clicks, interval=0.08)
    return x, y


def _paste_into_focused_field(value: str, *, secret: bool = False) -> None:
    """Klavye düzeninden bağımsız yapıştırır ve parolayı panoda bırakmaz."""
    previous_clipboard: str | None = None
    try:
        previous_clipboard = pyperclip.paste()
    except pyperclip.PyperclipException:
        LOGGER.debug("Mevcut pano içeriği okunamadı.", exc_info=True)

    try:
        pyperclip.copy(value)
        pyautogui.hotkey("ctrl", "a")
        pyautogui.press("backspace")
        pyautogui.hotkey("ctrl", "v")
        time.sleep(0.35)
    finally:
        try:
            if previous_clipboard is not None:
                pyperclip.copy(previous_clipboard)
            elif secret:
                pyperclip.copy("")
        except pyperclip.PyperclipException:
            LOGGER.debug("Pano geri yüklenemedi.", exc_info=True)


def _type_verified_nickname(
    nickname: str,
    dice_location: tuple[int, int, int, int],
) -> tuple[int, int]:
    """Zar simgesini sabit referans alır, adı yazar ve piksel değişimini ölçer."""
    left, top, width, height = dice_location
    dice_center_x = left + width * 0.5
    dice_center_y = top + height * 0.5

    # Zar ve isim kutusu her çözünürlükte aynı satırdadır. Kutunun sağ iç kısmı
    # zarın sol kenarından yaklaşık bir zar genişliği soldadır. Böylece kutu
    # genişliğini veya butonun yükleme sırasında kayan konumunu tahmin etmeyiz.
    x_factors = (1.0, 1.5, 2.0)
    last_changed_ratio = 0.0
    for attempt, x_factor in enumerate(x_factors, start=1):
        field_x = round(left - width * x_factor)
        field_y = round(dice_center_y)

        verify_left = round(dice_center_x - width * 4.7)
        verify_top = round(dice_center_y - height * 0.28)
        verify_width = max(20, round(width * 3.7))
        verify_height = max(12, round(height * 0.56))
        verify_region = (verify_left, verify_top, verify_width, verify_height)
        before = cv2.cvtColor(
            np.asarray(pyautogui.screenshot(region=verify_region)),
            cv2.COLOR_RGB2GRAY,
        )

        pyautogui.moveTo(field_x, field_y, duration=0.2)
        pyautogui.click(field_x, field_y)
        time.sleep(0.35)
        pyautogui.hotkey("ctrl", "a")
        pyautogui.press("backspace")
        # Nickname yalnızca A-Z/1-9 içerdiği için Flash alanında doğrudan tuş
        # gönderimi, bu kontrolün desteklemediği pano yapıştırmasından güvenlidir.
        pyautogui.write(nickname, interval=0.05)
        time.sleep(0.6)

        after = cv2.cvtColor(
            np.asarray(pyautogui.screenshot(region=verify_region)),
            cv2.COLOR_RGB2GRAY,
        )
        difference = cv2.absdiff(before, after)
        changed_ratio = float(np.count_nonzero(difference > 12) / difference.size)
        last_changed_ratio = max(last_changed_ratio, changed_ratio)
        if changed_ratio >= 0.10:
            LOGGER.info(
                "Karakter adı görsel değişimle doğrulandı | deneme=%s | "
                "konum=(%s,%s) | değişen_piksel=%.1f%%",
                attempt,
                field_x,
                field_y,
                changed_ratio * 100,
            )
            return field_x, field_y

        LOGGER.warning(
            "Karakter adı bölgesinde yeterli değişim görülmedi; yedek X noktası "
            "denenecek (deneme=%s, değişen_piksel=%.1f%%).",
            attempt,
            changed_ratio * 100,
        )

    raise AutomationError(
        "Karakter adı kutusunun değiştiği doğrulanamadı; Oyuna Gir düğmesine "
        f"basılmadı (en yüksek değişen piksel={last_changed_ratio:.1%})."
    )


def _wait_for_process_exit(process: subprocess.Popen[Any], timeout: float) -> bool:
    try:
        process.wait(timeout=timeout)
        return True
    except subprocess.TimeoutExpired:
        return False


def _focus_window_for_pid(pid: int) -> bool:
    """Yalnızca verilen PID'ye ait görünür pencereyi öne getirir."""
    if sys.platform != "win32":
        return False

    user32 = ctypes.windll.user32
    handles: list[int] = []
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def enum_callback(hwnd: int, _lparam: int) -> bool:
        window_pid = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(window_pid))
        if window_pid.value == pid and user32.IsWindowVisible(hwnd):
            handles.append(hwnd)
        return True

    user32.EnumWindows(callback_type(enum_callback), 0)
    if not handles:
        return False

    hwnd = handles[0]
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    focused = bool(user32.SetForegroundWindow(hwnd))
    time.sleep(0.25)
    return focused or user32.GetForegroundWindow() == hwnd


def _close_chrome(process: subprocess.Popen[Any]) -> bool:
    """WM_CLOSE -> Alt+F4 -> PID ağaç sonlandırma sırasını uygular."""
    if process.poll() is not None:
        return True

    pid = process.pid
    LOGGER.info("Chrome kapatılıyor (PID %s)...", pid)

    # 1) pywinauto ile yalnızca bu çalıştırmaya ait Chrome penceresini kapat.
    try:
        chrome_app = Application(backend="uia").connect(process=pid, timeout=2)
        windows = [window for window in chrome_app.windows() if window.is_visible()]
        window = windows[0] if windows else chrome_app.top_window()
        try:
            window.set_focus()
        except Exception:
            LOGGER.debug("Chrome penceresine pywinauto ile odaklanılamadı.", exc_info=True)
        window.close()
        if _wait_for_process_exit(process, 1.5):
            LOGGER.info("Chrome pywinauto ile kapatıldı.")
            return True
    except Exception:
        LOGGER.debug("Chrome pywinauto ile kapatılamadı; Alt+F4 denenecek.", exc_info=True)

    # 2) Yanlış pencereyi kapatmamak için Alt+F4 yalnızca PID penceresi odaktaysa gönderilir.
    try:
        if _focus_window_for_pid(pid):
            pyautogui.hotkey("alt", "f4")
            if _wait_for_process_exit(process, 1.5):
                LOGGER.info("Chrome Alt+F4 ile kapatıldı.")
                return True
        else:
            LOGGER.debug("PID %s için odaklanabilir Chrome penceresi bulunamadı.", pid)
    except Exception:
        LOGGER.debug("Chrome Alt+F4 ile kapatılamadı.", exc_info=True)

    # 3) Son çare: yalnızca saklanan PID ve onun çocuk süreçlerini sonlandır.
    LOGGER.warning("Chrome süreç ağacı taskkill ile zorla kapatılıyor (PID %s).", pid)
    try:
        result = subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        LOGGER.debug(
            "taskkill dönüş kodu=%s stdout=%r stderr=%r",
            result.returncode,
            result.stdout.strip(),
            result.stderr.strip(),
        )
    except (OSError, subprocess.SubprocessError):
        LOGGER.exception("taskkill çalıştırılamadı.")

    closed = _wait_for_process_exit(process, 3.0) or process.poll() is not None
    if not closed:
        LOGGER.error("Chrome PID %s kapatılamadı.", pid)
    return closed


def _cleanup_profile(profile_dir: Path, browser_closed: bool) -> None:
    if not browser_closed:
        LOGGER.warning("Chrome açık kalmış olabileceği için geçici profil korunuyor: %s", profile_dir)
        return

    for attempt in range(3):
        try:
            shutil.rmtree(profile_dir)
            return
        except FileNotFoundError:
            return
        except OSError:
            if attempt == 2:
                LOGGER.warning("Geçici Chrome profili silinemedi: %s", profile_dir, exc_info=True)
                return
            time.sleep(0.5)


def _dismiss_javascript_alerts(duration: float) -> None:
    LOGGER.info("Olası JavaScript uyarıları %.1f saniye boyunca kapatılıyor...", duration)
    deadline = time.monotonic() + max(5.0, duration)
    while time.monotonic() < deadline:
        pyautogui.press("enter")
        time.sleep(0.18)
        pyautogui.press("esc")
        time.sleep(0.18)


def web_login(
    email: str,
    password: str,
    *,
    chrome_path: str | Path | None = None,
    config: WebLoginConfig | None = None,
) -> bool:
    """
    Normal Chrome'u izole bir gizli pencere olarak açar ve ekran görselleriyle
    giriş yapar. Selenium, WebDriver veya DOM enjeksiyonu kullanmaz.

    True yalnızca giriş tıklaması tamamlanıp bu fonksiyonun açtığı Chrome süreç
    ağacı kapatıldığında döner.
    """
    config = config or WebLoginConfig()
    chrome = get_chrome_path(chrome_path)
    if chrome is None:
        LOGGER.error("Google Chrome bulunamadı.")
        return False

    for image_path in (WEB_EMAIL_IMAGE, WEB_PASSWORD_IMAGE, WEB_LOGIN_IMAGE):
        try:
            _validate_image(image_path)
        except AutomationError as exc:
            LOGGER.error("%s", exc)
            return False

    profile_dir = Path(tempfile.mkdtemp(prefix="legendbots-chrome-"))
    process: subprocess.Popen[Any] | None = None
    action_completed = False
    browser_closed = False

    try:
        command = [
            str(chrome),
            "--incognito",
            "--start-maximized",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-mode",
            f"--user-data-dir={profile_dir}",
            config.url,
        ]
        LOGGER.info("Chrome gizli pencerede başlatılıyor...")
        process = subprocess.Popen(
            command,
            cwd=str(profile_dir),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            shell=False,
            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )
        LOGGER.debug("Chrome PID=%s profil=%s", process.pid, profile_dir)

        time.sleep(config.initial_wait)
        if process.poll() is not None:
            raise AutomationError(f"Chrome beklenmedik biçimde kapandı (kod {process.returncode}).")

        _focus_window_for_pid(process.pid)

        email_location = _locate_image(
            WEB_EMAIL_IMAGE,
            confidence=config.confidence,
            timeout=config.page_timeout,
            poll_interval=config.poll_interval,
            description="Web e-posta alanı",
        )
        _click_location(email_location, x_offset=config.field_x_offset)
        _paste_into_focused_field(email)

        password_location = _locate_image(
            WEB_PASSWORD_IMAGE,
            confidence=config.confidence,
            timeout=12.0,
            poll_interval=config.poll_interval,
            description="Web şifre alanı",
        )
        _click_location(password_location, x_offset=config.field_x_offset)
        _paste_into_focused_field(password, secret=True)

        login_location = _locate_image(
            WEB_LOGIN_IMAGE,
            confidence=config.confidence,
            timeout=12.0,
            poll_interval=config.poll_interval,
            description="Web Giriş butonu",
        )
        _click_location(login_location)
        LOGGER.info("Web Giriş butonuna tıklandı: %s", email)

        _dismiss_javascript_alerts(config.alert_duration)
        action_completed = True
    except KeyboardInterrupt:
        LOGGER.warning("Web girişi kullanıcı tarafından durduruldu.")
        raise
    except pyautogui.FailSafeException:
        LOGGER.error("PyAutoGUI acil durdurma tetiklendi.")
    except Exception as exc:
        LOGGER.error("Web girişi tamamlanamadı (%s): %s", email, exc)
        LOGGER.debug("Web giriş hata ayrıntısı", exc_info=True)
    finally:
        if process is not None:
            browser_closed = _close_chrome(process)
        else:
            browser_closed = True
        _cleanup_profile(profile_dir, browser_closed)

    if action_completed and browser_closed:
        LOGGER.info("Web giriş adımı tamamlandı ve Chrome kapatıldı: %s", email)
        return True

    if action_completed:
        LOGGER.error("Giriş tıklandı ancak Chrome'un kapandığı doğrulanamadı: %s", email)
    return False


def _locate_image_multiscale(
    image_path: Path,
    *,
    description: str,
    confidence: float,
    timeout: float,
    region: tuple[int, int, int, int] | None = None,
) -> tuple[int, int, int, int]:
    """DPI farkları için şablonu birden fazla ölçekte eşleştirir."""
    _validate_image(image_path)
    template = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if template is None:
        raise AutomationError(f"Görsel OpenCV ile okunamadı: {image_path}")

    scales = tuple(value / 100 for value in range(70, 151, 5))
    deadline = time.monotonic() + timeout
    best_seen = 0.0
    LOGGER.info("%s çoklu ölçekte aranıyor...", description)

    while time.monotonic() < deadline:
        screenshot = np.asarray(pyautogui.screenshot())
        screenshot = cv2.cvtColor(screenshot, cv2.COLOR_RGB2BGR)
        origin_x = 0
        origin_y = 0
        if region is not None:
            origin_x, origin_y, width, height = region
            screenshot = screenshot[origin_y : origin_y + height, origin_x : origin_x + width]

        best_result: tuple[float, tuple[int, int], tuple[int, int]] | None = None
        for scale in scales:
            interpolation = cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA
            scaled = cv2.resize(template, None, fx=scale, fy=scale, interpolation=interpolation)
            template_height, template_width = scaled.shape[:2]
            if (
                template_height >= screenshot.shape[0]
                or template_width >= screenshot.shape[1]
            ):
                continue

            result = cv2.matchTemplate(screenshot, scaled, cv2.TM_CCOEFF_NORMED)
            _, score, _, location = cv2.minMaxLoc(result)
            if best_result is None or score > best_result[0]:
                best_result = (score, location, (template_width, template_height))

        if best_result is not None:
            score, location, size = best_result
            best_seen = max(best_seen, score)
            if score >= confidence:
                left = origin_x + location[0]
                top = origin_y + location[1]
                LOGGER.info(
                    "%s bulundu | güven=%.3f | konum=(%s,%s) | boyut=%sx%s",
                    description,
                    score,
                    left,
                    top,
                    size[0],
                    size[1],
                )
                return left, top, size[0], size[1]
        time.sleep(0.75)

    raise ImageTimeoutError(
        f"{description} {timeout:.0f} saniye içinde bulunamadı "
        f"({image_path.name}, en iyi eşleşme={best_seen:.3f})."
    )


def _get_client_window(app: Application, timeout: float = 20.0) -> Any:
    """İstemci penceresini bulur, küçültülmüşse geri yükler ve odaklar."""
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None

    while time.monotonic() < deadline:
        try:
            windows = app.windows()
            titled = [window for window in windows if "Legend Online" in window.window_text()]
            candidates = titled or [window for window in windows if window.is_visible()]
            for window in candidates:
                try:
                    if window.is_minimized():
                        window.restore()
                        time.sleep(0.75)
                    rectangle = window.rectangle()
                    if rectangle.width() < 800 or rectangle.height() < 550:
                        continue
                    window.set_focus()
                    time.sleep(0.25)
                    return window
                except Exception as exc:
                    last_error = exc
        except Exception as exc:
            last_error = exc
        time.sleep(0.5)

    if last_error:
        LOGGER.debug("Son istemci pencere hatası: %r", last_error)
    raise AutomationError("Legend Online penceresi bulunamadı veya geri yüklenemedi.")


def _click_client_position(
    window: Any,
    position: tuple[float, float],
    *,
    clicks: int = 1,
) -> tuple[int, int]:
    rectangle = window.rectangle()
    x = round(rectangle.left + rectangle.width() * position[0])
    y = round(rectangle.top + rectangle.height() * position[1])
    pyautogui.click(x=x, y=y, clicks=clicks, interval=0.08)
    return x, y


def _client_region(window: Any) -> tuple[int, int, int, int]:
    rectangle = window.rectangle()
    screen = pyautogui.size()
    left = max(0, rectangle.left)
    top = max(0, rectangle.top)
    right = min(screen.width, rectangle.right)
    bottom = min(screen.height, rectangle.bottom)
    if right <= left or bottom <= top:
        raise AutomationError("Legend Online pencere bölgesi ekran dışında kaldı.")
    return left, top, right - left, bottom - top


def _detect_two_blue_loading_bars(
    screenshot: Image.Image,
) -> tuple[tuple[int, int, int, int], tuple[int, int, int, int]] | None:
    """İstemcinin alt kısmındaki iki ayrı camgöbeği-mavi yatay barı bulur."""
    rgb = np.asarray(screenshot)
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    height, width = hsv.shape[:2]

    # Canlı örneklerde bar dolgusu H=102-107 aralığında. Aralığı DPI ve parlama
    # farkları için biraz geniş tutup yalnızca pencerenin alt %32'sini inceleriz.
    mask = cv2.inRange(hsv, np.array([80, 90, 80]), np.array([115, 255, 255]))
    mask[: round(height * 0.68), :] = 0

    component_count, _, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    candidates: list[tuple[int, int, int, int, int]] = []
    minimum_width = max(180, round(width * 0.24))
    for x, y, component_width, component_height, area in stats[1:component_count]:
        if (
            component_width >= minimum_width
            and 4 <= component_height <= max(50, round(height * 0.06))
            and area >= component_width * 4
        ):
            candidates.append(
                (
                    int(x),
                    int(y),
                    int(component_width),
                    int(component_height),
                    int(area),
                )
            )

    candidates.sort(key=lambda item: item[1])
    for index, first in enumerate(candidates):
        for second in candidates[index + 1 :]:
            first_center_y = first[1] + first[3] / 2
            second_center_y = second[1] + second[3] / 2
            vertical_gap = second_center_y - first_center_y
            width_ratio = min(first[2], second[2]) / max(first[2], second[2])
            if (
                height * 0.025 <= vertical_gap <= height * 0.12
                and abs(first[0] - second[0]) <= width * 0.06
                and width_ratio >= 0.65
            ):
                return first[:4], second[:4]
    return None


def _wait_for_two_blue_loading_bars(
    app: Application,
    *,
    timeout: float,
    required_consecutive_frames: int = 2,
) -> tuple[tuple[int, int, int, int], tuple[int, int, int, int]]:
    """İki barı art arda karelerde görmeden hesabı doğrulanmış saymaz."""
    deadline = time.monotonic() + timeout
    consecutive = 0
    last_pair: tuple[tuple[int, int, int, int], tuple[int, int, int, int]] | None = None

    LOGGER.info("İki mavi yükleme çubuğu doğrulanıyor...")
    while time.monotonic() < deadline:
        window = _get_client_window(app, timeout=3.0)
        region = _client_region(window)
        screenshot = pyautogui.screenshot(region=region)
        pair = _detect_two_blue_loading_bars(screenshot)
        if pair is not None:
            consecutive += 1
            last_pair = pair
            LOGGER.info(
                "Mavi bar karesi doğrulandı %s/%s | üst=%s | alt=%s",
                consecutive,
                required_consecutive_frames,
                pair[0],
                pair[1],
            )
            if consecutive >= required_consecutive_frames:
                return pair
        else:
            consecutive = 0
        time.sleep(0.5)

    raise AutomationError(
        "İki mavi yükleme çubuğu süre içinde art arda doğrulanamadı "
        f"(son eşleşme={last_pair})."
    )


def _wait_for_character_or_existing_account(
    app: Application,
    *,
    timeout: float,
) -> tuple[str, tuple[int, int, int, int] | None]:
    """Karakter ekranını veya doğrudan oyuna geçen mevcut hesabı ayırt eder."""
    deadline = time.monotonic() + timeout
    blue_bar_frames = 0
    while time.monotonic() < deadline:
        window = _get_client_window(app, timeout=3.0)
        region = _client_region(window)
        screenshot = pyautogui.screenshot(region=region)
        if _detect_two_blue_loading_bars(screenshot) is not None:
            blue_bar_frames += 1
            if blue_bar_frames >= 2:
                LOGGER.info("Hesap karakter ekranını atlayıp doğrudan oyun yüklemesine geçti.")
                return "existing_verified", None
        else:
            blue_bar_frames = 0

        try:
            dice = pyautogui.locateOnScreen(
                str(CLIENT_DICE_IMAGE),
                confidence=0.72,
                region=region,
            )
            if dice is not None:
                return "character_screen", tuple(int(value) for value in dice)
        except pyautogui.ImageNotFoundException:
            pass
        time.sleep(0.5)

    raise AutomationError("Girişten sonra karakter ekranı veya iki mavi bar görünmedi.")


def _normalize_character_screen(window: Any) -> None:
    """Flash ekranındaki geçici scrollbar'ı wheel hareketiyle kaldırır."""
    left, top, width, height = _client_region(window)
    target_x = round(left + width * 0.5)
    target_y = round(top + height * 0.55)
    window.set_focus()
    pyautogui.moveTo(target_x, target_y, duration=0.2)
    pyautogui.scroll(-8)
    LOGGER.info("Karakter ekranı aşağı kaydırma hareketiyle ölçeğe sabitleniyor...")
    time.sleep(2.0)


def _kill_application(app: Application | None) -> None:
    if app is None:
        return

    pid = getattr(app, "process", None)
    try:
        if app.is_process_running():
            app.kill(soft=False)
            time.sleep(1.0)
    except Exception:
        LOGGER.debug("İstemci pywinauto ile kapatılamadı.", exc_info=True)

    if isinstance(pid, int):
        try:
            result = subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                capture_output=True,
                text=True,
                timeout=8,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            LOGGER.debug(
                "İstemci taskkill dönüş kodu=%s stdout=%r stderr=%r",
                result.returncode,
                result.stdout.strip(),
                result.stderr.strip(),
            )
        except (OSError, subprocess.SubprocessError):
            LOGGER.exception("İstemci süreç ağacı kapatılamadı (PID %s).", pid)

    try:
        if app.is_process_running():
            LOGGER.error("Legend Online istemci PID %s kapatılamadı.", pid)
        else:
            LOGGER.info("Legend Online istemcisi kapatıldı (PID %s).", pid)
    except Exception:
        LOGGER.info("Legend Online istemci kapatma işlemi tamamlandı (PID %s).", pid)


def run_desktop_client(
    email: str,
    password: str,
    *,
    client_path: Path,
    config: ClientConfig | None = None,
    on_character_submitted: Callable[[str], None] | None = None,
    on_account_verified: Callable[[str], None] | None = None,
    known_nickname: str | None = None,
) -> str:
    """Mevcut hesapla istemci girişini ve karakter oluşturma adımını yürütür."""
    config = config or ClientConfig()
    app: Application | None = None

    try:
        LOGGER.info("Legend Online istemcisi başlatılıyor: %s", client_path)
        with warnings.catch_warnings():
            warnings.filterwarnings(
                "ignore",
                message="32-bit application should be automated using 32-bit Python.*",
                category=UserWarning,
            )
            app = Application(backend="win32").start(str(client_path), timeout=20)
        time.sleep(config.startup_wait)

        window = _get_client_window(app)

        # Kaydedilmiş adres bulunabileceği için alan her hesapta mutlaka tamamen
        # seçilir, silinir ve ancak bundan sonra yeni adres yapıştırılır.
        _click_client_position(window, config.email_position, clicks=3)
        _paste_into_focused_field(email)
        LOGGER.info("Kaydedilmiş e-posta temizlenip yeni adres yapıştırıldı.")

        _click_client_position(window, config.password_position, clicks=3)
        _paste_into_focused_field(password, secret=True)
        LOGGER.info("İstemci şifre alanı temizlenip dolduruldu.")

        _click_client_position(window, config.login_position)
        LOGGER.info("İstemci Giriş Yap butonuna tıklandı.")

        # Çökme/yeniden başlama sonrasında hesap aslında kurulmuş olabilir. Bu
        # durumda karakter ekranı yerine iki mavi yükleme barı görünür ve hesap
        # tekrar oluşturulmaya çalışılmadan doğrulanır.
        post_login_state, initial_dice = _wait_for_character_or_existing_account(
            app,
            timeout=config.image_timeout,
        )
        if post_login_state == "existing_verified":
            nickname = known_nickname or "existing_account"
            if on_account_verified is not None:
                on_account_verified(nickname)
            LOGGER.info("Mevcut hesap iki mavi barla doğrulandı: %s", email)
            time.sleep(config.post_verification_wait)
            return nickname

        # "7roll" benzeri yükleme ekranının bittiğini zar simgesi kanıtladı.
        # Ardından scrollbar'ı kaldırıp Flash ölçeğini oturtan aşağı wheel
        # hareketini gönder ve bütün koordinatları yeniden hesapla.
        LOGGER.debug("Ölçek sabitleme öncesi zar konumu: %s", initial_dice)
        window = _get_client_window(app, timeout=10.0)
        _normalize_character_screen(window)

        window = _get_client_window(app, timeout=10.0)
        region = _client_region(window)
        dice_location = _locate_image_multiscale(
            CLIENT_DICE_IMAGE,
            description="Ölçek sabitleme sonrası zar simgesi",
            confidence=0.72,
            timeout=15.0,
            region=region,
        )
        enter_location = _locate_image_multiscale(
            CLIENT_ENTER_IMAGE,
            description="Ölçek sabitleme sonrası Oyuna Gir butonu",
            confidence=config.confidence,
            timeout=15.0,
            region=region,
        )

        nickname = generate_nickname()
        _type_verified_nickname(nickname, dice_location)
        LOGGER.info("Karakter adı hazırlandı ve doğrulandı: %s", nickname)
        time.sleep(config.character_wait)

        # Buton yükleme boyunca aynı yerde kalır; yine de ekran değiştiyse
        # yanlış konuma tıklamamak için son kez eşleşme doğrulanır.
        enter_location = _locate_image_multiscale(
            CLIENT_ENTER_IMAGE,
            description="Oyuna Gir butonu son kontrolü",
            confidence=config.confidence,
            timeout=10.0,
            region=region,
        )
        _click_location(enter_location)
        LOGGER.info("Oyuna Gir butonuna tıklandı.")
        # Tıklama önce "doğrulama bekliyor" olarak yazılır. Kalıcı tamamlanma
        # yalnızca aşağıdaki iki mavi bar doğrulamasından sonra kaydedilir.
        if on_character_submitted is not None:
            on_character_submitted(nickname)
        _wait_for_two_blue_loading_bars(app, timeout=config.blue_bar_timeout)
        if on_account_verified is not None:
            on_account_verified(nickname)
        LOGGER.info("Hesap çift doğrulamayı geçti: %s | karakter=%s", email, nickname)
        time.sleep(config.post_verification_wait)
        return nickname
    except KeyboardInterrupt:
        raise
    except pyautogui.FailSafeException as exc:
        raise AutomationError("PyAutoGUI acil durdurma tetiklendi.") from exc
    finally:
        _kill_application(app)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Var olan Legend Online hesaplarıyla web ve masaüstü giriş otomasyonu."
    )
    parser.add_argument("--prefix", default=DEFAULT_EMAIL_PREFIX, help="E-posta kullanıcı adı öneki")
    parser.add_argument("--domain", default=DEFAULT_EMAIL_DOMAIN, help="E-posta alan adı")
    parser.add_argument("--start", type=int, default=DEFAULT_START_INDEX, help="Başlangıç hesap numarası")
    parser.add_argument("--count", type=int, default=DEFAULT_ACCOUNT_COUNT, help="İşlenecek hesap sayısı")
    parser.add_argument("--chrome", type=Path, help="chrome.exe için özel yol")
    parser.add_argument("--client", type=Path, help="Legend Online.exe için özel yol")
    parser.add_argument(
        "--post-web-wait",
        type=float,
        default=7.0,
        help="Chrome kapandıktan sonraki bekleme (minimum 7 saniye)",
    )
    parser.add_argument("--web-retries", type=int, default=2, help="Hesap başına web giriş denemesi")
    parser.add_argument(
        "--retry-delay",
        type=float,
        default=10.0,
        help="Doğrulanmayan hesap için ilk yeniden deneme gecikmesi",
    )
    parser.add_argument(
        "--max-account-attempts",
        type=int,
        default=0,
        help="Hesap başına üst sınır; 0 doğrulanana kadar sınırsız deneme",
    )
    parser.add_argument(
        "--password",
        help="Hesap parolası; verilmezse LEGEND_PASSWORD veya güvenli istem kullanılır",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Tarayıcı/istemci açmadan bağımlılıkları ve dosyaları kontrol et",
    )
    return parser


def _validate_arguments(args: argparse.Namespace) -> None:
    if not args.prefix or "@" in args.prefix:
        raise AutomationError("--prefix boş olamaz ve @ içeremez.")
    if not args.domain or "@" in args.domain or "." not in args.domain:
        raise AutomationError("--domain geçerli bir e-posta alan adı olmalıdır.")
    if args.start < 0:
        raise AutomationError("--start sıfırdan küçük olamaz.")
    if args.count < 1:
        raise AutomationError("--count en az 1 olmalıdır.")
    if args.web_retries < 1:
        raise AutomationError("--web-retries en az 1 olmalıdır.")
    if args.retry_delay < 1:
        raise AutomationError("--retry-delay en az 1 saniye olmalıdır.")
    if args.max_account_attempts < 0:
        raise AutomationError("--max-account-attempts negatif olamaz.")


def main(argv: list[str] | None = None) -> int:
    setup_logging()
    parser = _build_parser()
    args = parser.parse_args(argv)

    print("\nVar Olan Hesaplardan Hesap Kurma Botu (BROV)\n")

    try:
        _validate_arguments(args)
        chrome_path, client_path = preflight(args.chrome, args.client)
        progress = ProgressStore.load()
    except AutomationError as exc:
        LOGGER.error("Ön kontrol başarısız: %s", exc)
        return 2

    if args.check:
        LOGGER.info(
            "Kontrol modu tamamlandı; kayıtlı tamamlanmış hesap=%s; "
            "hiçbir tarayıcı veya istemci açılmadı.",
            len(progress.accounts),
        )
        return 0

    selected_emails = [
        f"{args.prefix}{args.start + offset}@{args.domain}" for offset in range(args.count)
    ]
    pending_emails = [email for email in selected_emails if not progress.is_completed(email)]
    if not pending_emails:
        LOGGER.info(
            "Seçilen aralıktaki %s hesabın tamamı daha önce kurulmuş; "
            "şifre istenmeden ve pencere açılmadan çıkılıyor.",
            len(selected_emails),
        )
        return 0
    LOGGER.info(
        "İlerleme kaydı | seçilen=%s | önceden kurulmuş=%s | işlenecek=%s",
        len(selected_emails),
        len(selected_emails) - len(pending_emails),
        len(pending_emails),
    )

    password = args.password or os.environ.get("LEGEND_PASSWORD")
    if not password:
        password = getpass("Mevcut hesapların ortak şifresi: ")
    if not password:
        LOGGER.error("Şifre boş olamaz.")
        return 2

    post_web_wait = max(7.0, args.post_web_wait)
    successful: list[str] = []
    failed: list[str] = []
    skipped: list[str] = []

    try:
        for offset in range(args.count):
            account_number = args.start + offset
            email = f"{args.prefix}{account_number}@{args.domain}"
            LOGGER.info("=" * 68)
            LOGGER.info("Hesap işleniyor (%s/%s): %s", offset + 1, args.count, email)

            if progress.is_completed(email):
                details = progress.details(email) or {}
                LOGGER.info(
                    "Hesap daha önce çift doğrulanmış; tamamen atlanıyor: %s | karakter=%s",
                    email,
                    details.get("nickname") or "bilinmiyor",
                )
                skipped.append(email)
                continue

            account_attempt = 0
            while not progress.is_completed(email):
                account_attempt += 1
                LOGGER.info(
                    "Hesap denetimli denemesi %s%s: %s",
                    account_attempt,
                    (
                        f"/{args.max_account_attempts}"
                        if args.max_account_attempts > 0
                        else "/sınırsız"
                    ),
                    email,
                )
                try:
                    web_ok = False
                    for web_attempt in range(1, args.web_retries + 1):
                        LOGGER.info("Web giriş denemesi %s/%s", web_attempt, args.web_retries)
                        web_ok = web_login(email, password, chrome_path=chrome_path)
                        if web_ok:
                            break
                        if web_attempt < args.web_retries:
                            LOGGER.warning("Web girişi yeniden denenecek; 3 saniye bekleniyor.")
                            time.sleep(3.0)
                    if not web_ok:
                        raise AutomationError("Web girişi bütün iç denemelerde başarısız oldu.")

                    LOGGER.info(
                        "Chrome kapandı. İstemci başlatılmadan önce %.1f saniye bekleniyor...",
                        post_web_wait,
                    )
                    time.sleep(post_web_wait)

                    pending_details = progress.pending_details(email) or {}
                    known_nickname = str(pending_details.get("nickname", "")) or None
                    nickname = run_desktop_client(
                        email,
                        password,
                        client_path=client_path,
                        known_nickname=known_nickname,
                        on_character_submitted=lambda submitted_nickname, account=email: (
                            progress.mark_submitted(account, submitted_nickname)
                        ),
                        on_account_verified=lambda verified_nickname, account=email: (
                            progress.mark_completed(account, verified_nickname)
                        ),
                    )
                    if not progress.is_completed(email):
                        raise AutomationError("İstemci döndü ancak çift doğrulama kaydı oluşmadı.")
                    successful.append(email)
                    LOGGER.info("Hesap kesin tamamlandı: %s | karakter=%s", email, nickname)
                    break
                except KeyboardInterrupt:
                    raise
                except Exception as exc:
                    if progress.is_completed(email):
                        successful.append(email)
                        LOGGER.warning(
                            "Doğrulama kaydı yazıldıktan sonra ek hata oluştu; hesap yeniden "
                            "çalıştırılmayacak (%s): %s",
                            email,
                            exc,
                        )
                        break

                    LOGGER.error("Hesap denemesi başarısız (%s): %s", email, exc)
                    LOGGER.debug("Hesap deneme hata ayrıntısı", exc_info=True)
                    try:
                        persisted_failure_count = progress.record_failure(email, str(exc))
                    except AutomationError as state_error:
                        LOGGER.critical("İlerleme kaydı yazılamadı: %s", state_error)
                        return 2

                    if (
                        args.max_account_attempts > 0
                        and account_attempt >= args.max_account_attempts
                    ):
                        failed.append(email)
                        LOGGER.error(
                            "Hesap için kullanıcı tanımlı deneme sınırına ulaşıldı: %s",
                            email,
                        )
                        break

                    retry_delay = min(
                        args.retry_delay * (2 ** min(account_attempt - 1, 3)),
                        60.0,
                    )
                    LOGGER.warning(
                        "Hesap doğrulanmadı; %.1f saniye sonra aynı hesaba dönülecek "
                        "(bu çalışma denemesi=%s, kalıcı hata sayacı=%s).",
                        retry_delay,
                        account_attempt,
                        persisted_failure_count,
                    )
                    time.sleep(retry_delay)
    except KeyboardInterrupt:
        LOGGER.warning("Otomasyon kullanıcı tarafından durduruldu.")
        return 130

    LOGGER.info("=" * 68)
    LOGGER.info(
        "Döngü tamamlandı | yeni başarılı=%s | önceden kurulmuş/atlanan=%s | başarısız=%s",
        len(successful),
        len(skipped),
        len(failed),
    )
    if failed:
        LOGGER.error("Başarısız hesaplar: %s", ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
