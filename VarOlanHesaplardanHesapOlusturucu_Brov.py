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
emailFirstPlace = 'hadestxz'
emailType = 'outlook.com'
numberOfAccount = 4
baslangicSayisi = 1

for i in range(baslangicSayisi, (baslangicSayisi + numberOfAccount)):
    app =  application.Application()
    app.start("C:\Program Files\Legend Online Client by Brov (64-bit)\LegendOnline.exe")
    email = emailFirstPlace + str(i) + "@" + emailType
    pyperclip.copy(email)
    time.sleep(3)
    pyautogui.hotkey('ctrl', 'v') # epostayı yapıştır
    time.sleep(0.5)
    pyautogui.click(707, 636) #gir
    time.sleep(3)
    pyautogui.click(1174,263) #tam ekran yap
    time.sleep(14.5)
    eksayi = random.randint(3, 9)
    time.sleep(0.5)
    pyautogui.click(1310,734) # isme tıkla
    time.sleep(0.5)
    pyautogui.click(1310,734) # isme tıkla
    time.sleep(1)
    pyautogui.hotkey(str(eksayi)) # Ismi koy
    time.sleep(0.5)
    pyautogui.click(1239,795) #Oyunu başlat
    time.sleep(8)
    app.kill()
print("\nBot döngüsü tamamlandı.\n")
