import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Default Messages
DEFAULT_MESSAGE_1 = "TÜM YOKLAMA KODLARI SATILIR | BİNEK, VIP | legendonlinecodes.com #38#38"
DEFAULT_MESSAGE_2 = "LEGENDTR20 kodu ile ilk ürünü %20 indirimle alın #38"

# Timings (in seconds)
INTER_MESSAGE_DELAY = 1.0     # 1 second between Message 1 and Message 2
DEFAULT_CYCLE_INTERVAL = 30.0 # Delay between advertising cycles (anti-timeout)

# Win32 Background Click Settings
DEFAULT_CLICK_X = 329         # Chat box click X coordinate (screen-absolute)
DEFAULT_CLICK_Y = 944         # Chat box click Y coordinate (screen-absolute)

# Window targeting - oyun istemcisini bulmak için pencere başlığında aranacak kelime
WINDOW_TITLE_KEYWORD = "Legend Online"
