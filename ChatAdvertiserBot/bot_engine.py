import os
import time
import threading
import pyautogui
import pyperclip
import cv2
import numpy as np
from PIL import ImageGrab
import config

class LegendBotEngine:
    def __init__(self, log_callback=None, alert_callback=None, status_callback=None, counter_callback=None):
        self.log_cb = log_callback or print
        self.alert_cb = alert_callback or print
        self.status_cb = status_callback or print
        self.counter_cb = counter_callback or (lambda sent, bought: None)

        self.is_running = False
        self.is_paused = False
        self.purchase_count = 0
        self.total_messages_sent = 0

        self.msg1 = config.DEFAULT_MESSAGE_1
        self.msg2 = config.DEFAULT_MESSAGE_2
        self.cycle_interval = config.DEFAULT_CYCLE_INTERVAL
        self.inter_delay = config.INTER_MESSAGE_DELAY
        self.purchase_quantity = config.PURCHASE_QUANTITY

        # PyAutoGUI Safety settings
        pyautogui.FAILSAFE = True
        pyautogui.PAUSE = 0.1

        self._thread = None

    def log(self, message):
        self.log_cb(f"[{time.strftime('%H:%M:%S')}] {message}")

    def update_status(self, status_str):
        self.status_cb(status_str)

    def update_counters(self):
        self.counter_cb(self.total_messages_sent, self.purchase_count)

    def start(self, msg1=None, msg2=None, interval=None):
        if self.is_running:
            self.log("Bot zaten çalışıyor.")
            return

        if msg1: self.msg1 = msg1
        if msg2: self.msg2 = msg2
        if interval: self.cycle_interval = float(interval)

        self.is_running = True
        self.is_paused = False
        self.purchase_count = 0
        self.total_messages_sent = 0
        self.update_counters()

        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        self.log("Bot başlatıldı. Birincil Öncelik: Borazan Satın Alma Kontrolü.")
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

    def _run_loop(self):
        while self.is_running:
            if self.is_paused:
                time.sleep(0.5)
                continue

            # --- PRE-CHECK: Top Priority Check for Purchase Modal ---
            modal_status = self.check_and_handle_purchase_modal()
            if modal_status == "LIMIT_REACHED" or not self.is_running:
                break
            if modal_status == "PURCHASED":
                time.sleep(0.5)
                continue

            # --- STEP 1: Locate Chat Box ---
            chat_pos = self.locate_chat_box()
            if not chat_pos:
                self.log("Chat kutusu / Emoji ikonu alt sol bölgede bulunamadı. Bekleniyor...")
                time.sleep(1.0)
                continue

            chat_x, chat_y = chat_pos

            # --- STEP 2: Pre-check modal BEFORE sending Message 1 ---
            modal_status = self.check_and_handle_purchase_modal()
            if modal_status == "LIMIT_REACHED" or not self.is_running:
                break
            if modal_status == "PURCHASED":
                continue

            # Send Message 1
            self.log(f"Mesaj 1 gönderiliyor (#{self.total_messages_sent + 1}): '{self.msg1[:35]}...'")
            self.send_text(chat_x, chat_y, self.msg1)
            self.total_messages_sent += 1
            self.update_counters()
            
            # --- STEP 3: Post-check modal IMMEDIATELY after Message 1 ---
            time.sleep(0.2)
            modal_status = self.check_and_handle_purchase_modal()
            if modal_status == "LIMIT_REACHED" or not self.is_running:
                break

            # --- STEP 4: 1.0 Second Delay between Message 1 and Message 2 ---
            self.log(f"{self.inter_delay} saniye bekleniyor...")
            start_wait = time.time()
            while time.time() - start_wait < self.inter_delay:
                if not self.is_running:
                    break
                modal_status = self.check_and_handle_purchase_modal()
                if modal_status == "LIMIT_REACHED" or not self.is_running:
                    break
                time.sleep(0.2)

            if modal_status == "LIMIT_REACHED" or not self.is_running:
                break

            # --- STEP 5: Pre-check modal BEFORE sending Message 2 ---
            modal_status = self.check_and_handle_purchase_modal()
            if modal_status == "LIMIT_REACHED" or not self.is_running:
                break
            if modal_status == "PURCHASED":
                continue

            # Send Message 2
            self.log(f"Mesaj 2 gönderiliyor (#{self.total_messages_sent + 1}): '{self.msg2[:35]}...'")
            self.send_text(chat_x, chat_y, self.msg2)
            self.total_messages_sent += 1
            self.update_counters()

            # --- STEP 6: Post-check modal IMMEDIATELY after Message 2 ---
            time.sleep(0.2)
            modal_status = self.check_and_handle_purchase_modal()
            if modal_status == "LIMIT_REACHED" or not self.is_running:
                break

            # --- STEP 7: Cooldown Interval between rounds with continuous modal monitoring ---
            self.log(f"Döngü tamamlandı. Gönderilen Toplam Mesaj: {self.total_messages_sent}. Bekleniyor ({self.cycle_interval} sn)...")
            cooldown_start = time.time()
            while time.time() - cooldown_start < self.cycle_interval:
                if not self.is_running:
                    break
                while self.is_paused and self.is_running:
                    time.sleep(0.5)

                modal_status = self.check_and_handle_purchase_modal()
                if modal_status == "LIMIT_REACHED" or not self.is_running:
                    break
                if modal_status == "PURCHASED":
                    break

                time.sleep(0.5)

        self.update_status("Durduruldu")

    def send_text(self, click_x, click_y, text):
        """Focuses chat box and pastes text accurately via Clipboard."""
        pyautogui.click(click_x, click_y)
        time.sleep(0.15)
        pyperclip.copy(text)
        pyautogui.hotkey('ctrl', 'v')
        time.sleep(0.15)
        pyautogui.press('enter')

    def capture_screen(self):
        """Captures full screen as numpy BGR array for OpenCV."""
        screenshot = ImageGrab.grab()
        return cv2.cvtColor(np.array(screenshot), cv2.COLOR_RGB2BGR)

    def find_template(self, template_key, confidence=0.60, region_bgr=None, region_offset=(0,0)):
        """Locates template inside specified image or full screen using OpenCV."""
        template_path = config.TEMPLATE_PATHS.get(template_key)
        if not template_path or not os.path.exists(template_path):
            return None

        template = cv2.imread(template_path, cv2.IMREAD_COLOR)
        if template is None:
            return None

        if region_bgr is None:
            region_bgr = self.capture_screen()

        th, tw = template.shape[:2]
        rh, rw = region_bgr.shape[:2]

        if rh < th or rw < tw:
            return None

        res = cv2.matchTemplate(region_bgr, template, cv2.TM_CCOEFF_NORMED)
        min_val, max_val, min_loc, max_loc = cv2.minMaxLoc(res)

        if max_val >= confidence:
            ox, oy = region_offset
            center_x = ox + max_loc[0] + tw // 2
            center_y = oy + max_loc[1] + th // 2
            return {
                "center": (center_x, center_y),
                "box": (ox + max_loc[0], oy + max_loc[1], tw, th),
                "confidence": max_val
            }
        return None

    def locate_chat_box(self, screen_bgr=None):
        """
        Finds emoji icon or chat area strictly in bottom-left portion of screen.
        Returns click coordinates for chat input box.
        """
        if screen_bgr is None:
            screen_bgr = self.capture_screen()

        sh, sw = screen_bgr.shape[:2]

        crop_y1 = int(sh * 0.55)
        crop_x2 = int(sw * 0.50)
        bottom_left_region = screen_bgr[crop_y1:sh, 0:crop_x2]

        for tmpl_key in ["emoji_icon", "emoji_chat"]:
            match = self.find_template(
                tmpl_key, 
                confidence=0.55, 
                region_bgr=bottom_left_region, 
                region_offset=(0, crop_y1)
            )
            if match:
                ex, ey = match["center"]
                return (ex - 75, ey)

        dunya_match = self.find_template(
            "dunya_tab", 
            confidence=0.55, 
            region_bgr=bottom_left_region, 
            region_offset=(0, crop_y1)
        )
        if dunya_match:
            dx, dy = dunya_match["center"]
            return (dx + 120, dy + 25)

        return None

    def check_and_handle_purchase_modal(self):
        """
        TOP PRIORITY CHECK:
        Detects if the Satın Al modal is open on screen.
        If open 1st time: Focuses exact quantity input box, types 666, clicks Satın Al.
        If open 2nd time: Displays 'Haklarımız bitti' popup and halts bot immediately.
        """
        screen_bgr = self.capture_screen()

        header_match = self.find_template("satin_al_header", confidence=0.55, region_bgr=screen_bgr)
        item_match = self.find_template("borazan_item", confidence=0.55, region_bgr=screen_bgr)
        btn_match = self.find_template("satin_al_btn", confidence=0.55, region_bgr=screen_bgr)
        qty_match_check = self.find_template("quantity_box", confidence=0.55, region_bgr=screen_bgr)
        num1_match_check = self.find_template("num_1_digit", confidence=0.55, region_bgr=screen_bgr)

        is_modal_open = bool(header_match or item_match or btn_match or qty_match_check or num1_match_check)

        if not is_modal_open:
            return "NO_MODAL"

        self.purchase_count += 1
        self.update_counters()
        self.log(f"🚨 Satın Al (Borazan) ekranı algılandı! (Satın Alma Sayısı: {self.purchase_count}/2)")

        if self.purchase_count >= config.MAX_PURCHASE_COUNT:
            self.log(f"⛔ HAKLARIMIZ BİTTİ! 666 Borazan mesajı tamamlandı ({self.total_messages_sent} mesaj gönderildi). Satın Alma ekranı 2. defa geldi. Bot durduruluyor...")
            self.is_running = False
            self.alert_cb(
                "Haklarımız Bitti!", 
                f"Satın alma ekranı 2. defa geldi!\n\nToplam Gönderilen Mesaj: {self.total_messages_sent}\n666 Borazan hakkı tamamlanmıştır."
            )
            return "LIMIT_REACHED"

        # --- 1st Time Purchase Execution ---
        self.log("🛒 1. KEZ SATIN ALMA İŞLEMİ: Miktar kutusunun tam ortasına tıklanıp '666' yazılıyor...")
        
        # 1. Locate Exact Quantity Input Box Center
        qty_match = qty_match_check or num1_match_check or self.find_template("quantity_box", confidence=0.50, region_bgr=screen_bgr)
        
        if qty_match:
            qx, qy = qty_match["center"]
        elif btn_match:
            bx, by = btn_match["center"]
            # Pixel Offset: input box center is exactly 62px left, 78px above Satın Al button
            qx, qy = bx - 62, by - 78
        elif header_match:
            hx, hy = header_match["center"]
            # Pixel Offset: input box center is exactly 10px right, 172px below header center
            qx, qy = hx + 10, hy + 172
        else:
            sh, sw = screen_bgr.shape[:2]
            qx, qy = sw // 2, sh // 2

        # Double click directly inside the exact input box
        pyautogui.doubleClick(qx, qy)
        time.sleep(0.15)

        # Clear text completely
        pyautogui.hotkey('ctrl', 'a')
        time.sleep(0.1)
        pyautogui.press('backspace')
        time.sleep(0.1)

        # Type '666'
        pyperclip.copy(self.purchase_quantity)
        pyautogui.hotkey('ctrl', 'v')
        time.sleep(0.2)
        self.log(f"Miktar kutusunun tam ortasına (x={qx}, y={qy}) '{self.purchase_quantity}' yazıldı.")

        # 2. Click 'Satın Al' button
        btn_match_new = self.find_template("satin_al_btn", confidence=0.50, region_bgr=screen_bgr)
        if btn_match_new:
            bx, by = btn_match_new["center"]
        else:
            bx, by = qx + 62, qy + 78

        pyautogui.click(bx, by)
        self.log(f"'Satın Al' butonuna (x={bx}, y={by}) tıklandı. 666 Borazan mesaj hakkı başladı.")

        time.sleep(config.PAUSE_AFTER_PURCHASE)
        return "PURCHASED"
