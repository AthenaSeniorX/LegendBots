from getpass import getpass
import os
import random
import time
from pywinauto import application
import pyautogui
import pyperclip
import string
## Legend Online Helper için özel olarak geliştirilmiştir Bot 1
## Otomatik hesap(lar) kurmak için yapılmıştır.
def generateNickname():
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=7))

legendOnlineFlag = False
print("\n")
print("█░░ █▀▀ █▀▀ █▀▀ █▄░█ █▀▄   █▀█ █▄░█ █░░ █ █▄░█ █▀▀   █░█ █▀▀ █░░ █▀█ █▀▀ █▀█")
print("█▄▄ ██▄ █▄█ ██▄ █░▀█ █▄▀   █▄█ █░▀█ █▄▄ █ █░▀█ ██▄   █▀█ ██▄ █▄▄ █▀▀ ██▄ █▀▄")
print("\nVar Olan Hesaplardan Hesap Kurma Botu (BROV) Powered by AthenaSenior \n\n")
print("\nBot çalışıyor.\n")
print("\n______________________________________________________________________________________________________________________\n")
emailFirstPlace = 'junikros'
emailType = 'outlook.com'
numberOfAccount = 100
baslangicSayisi = 1
time.sleep(3)
for i in range(baslangicSayisi, (baslangicSayisi + numberOfAccount)):
    email = emailFirstPlace + str(i) + "@" + emailType
    pyperclip.copy(email)
    time.sleep(2)
    pyautogui.click(1588, 127)
    time.sleep(0.5)
    pyautogui.click(757,618)
    time.sleep(0.5)
    pyautogui.click(844,455)
    pyautogui.hotkey('ctrl', 'v') # epostayı yapıştır
    time.sleep(0.5)
    pyperclip.copy('123321')
    time.sleep(0.5)
    pyautogui.click(861,543)
    time.sleep(0.5)
    pyautogui.hotkey('ctrl', 'v') # şif
    time.sleep(0.5)
    pyautogui.click(921,684)
    time.sleep(5)
    pyautogui.click(1905,978)
    pyautogui.click(1905,978)
    time.sleep(0.5)
    pyautogui.click(1748,258)
    time.sleep(2)
    pyautogui.hotkey('alt', 'f4') 
    time.sleep(0.5)
    pyautogui.click(570,523)
    time.sleep(6)
    pyautogui.click(936,596)
    pyautogui.click(936,596)
    time.sleep(0.5)
    pyautogui.hotkey('ctrl', 'c') 
    time.sleep(0.5)
    pyautogui.click(503,15)
    time.sleep(0.5)
    pyautogui.click(1693,461)
    time.sleep(0.5)
    pyautogui.click(1386,558)
    time.sleep(0.5)
    pyautogui.hotkey('ctrl', 'v')
    time.sleep(0.5)
    pyautogui.click(1730,629)
    time.sleep(0.5)
    pyautogui.click(217,23)
    time.sleep(0.5)
    pyautogui.click(120,70)
    time.sleep(4)
    pyautogui.click(1594,133)
    time.sleep(0.5)
    pyautogui.click(1597,164)
print("\nBot döngüsü tamamlandı.\n")
