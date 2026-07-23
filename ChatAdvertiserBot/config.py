import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")

# Default Messages
DEFAULT_MESSAGE_1 = "TÜM YOKLAMA KODLARI SATILIR | BİNEK, VIP | legendonlinecodes.com #38#38"
DEFAULT_MESSAGE_2 = "LEGENDTR20 kodu ile ilk ürünü %20 indirimle alın #38"

# Timings (in seconds)
INTER_MESSAGE_DELAY = 1.0     # 1 second between Message 1 and Message 2
DEFAULT_CYCLE_INTERVAL = 30.0 # Delay between advertising cycles (anti-timeout)
PAUSE_AFTER_PURCHASE = 1.5    # Pause after clicking Satın Al

# Purchase Settings
PURCHASE_QUANTITY = "666"
MAX_PURCHASE_COUNT = 2        # 2nd appearance triggers "Haklarımız bitti" warning

# Template File Paths
TEMPLATE_PATHS = {
    "emoji_icon": os.path.join(TEMPLATES_DIR, "emoji_icon.png"),
    "emoji_chat": os.path.join(TEMPLATES_DIR, "emoji_btn_in_chat.png"),
    "satin_al_header": os.path.join(TEMPLATES_DIR, "satin_al_header.png"),
    "borazan_item": os.path.join(TEMPLATES_DIR, "borazan_item.png"),
    "quantity_box": os.path.join(TEMPLATES_DIR, "exact_input_box.png"),
    "num_1_digit": os.path.join(TEMPLATES_DIR, "num_1_digit.png"),
    "satin_al_btn": os.path.join(TEMPLATES_DIR, "satin_al_btn.png"),
    "dunya_tab": os.path.join(TEMPLATES_DIR, "dunya_tab.png"),
}
