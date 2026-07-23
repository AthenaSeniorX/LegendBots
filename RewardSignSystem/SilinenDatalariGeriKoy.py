import time
import pyautogui
import pyperclip

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

# Text dosyasını oku
with open(BASE_DIR / "BackUpData.txt", "r", encoding="utf-8") as file:
    lines = file.readlines()

# Verileri işlemek için bir sözlük oluştur
data = {}

# Veriyi döngüyle işleme
for i in range(0, len(lines), 5):  # Her veri 3 satırdan oluşuyor
    if i + 1 < len(lines):  # Veri tam olduğundan emin olmak için kontrol
        key = int(lines[i].strip())  # Anahtar: ilk satır (numara)
        value = lines[i + 1].strip().strip('"')  # Değer: ikinci satır (string)
        pyperclip.copy(value)
        pyautogui.click(1718, 657) 
        time.sleep(1)
        pyautogui.click(1368,766) 
        time.sleep(0.5)
        pyautogui.hotkey('ctrl', 'v')
        time.sleep(0.5)
        pyautogui.click(1751,830)
        time.sleep(1)


