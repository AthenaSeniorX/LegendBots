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
print("\nVar Olan Hesaplardan Hesap Kurma Botu (Almanya) Powered by AthenaSenior \n\n")
print("\nKod çoğaltılamaz veya değiştirilemez. Tespit edildiği takdirde adli işlemler başlatılır. Bol Farmlar dileriz..\n")
print("\n______________________________________________________________________________________________________________________\n")
emailFirstPlace = input("- Email'in sol tarafı? \n **** : ")
print("\n\n")
if(len(emailFirstPlace) <= 8 and len(emailFirstPlace) >= 3):
    emailType = input("- Email'in sağ tarafı? \n **** : ")
    print("\n\n")
    if emailType == "hotmail.com" or emailType == "gmail.com" or emailType == "outlook.com":
        numberOfAccount = int(input("- Kaç hesap oluşturalım?: "))
        if numberOfAccount <= 130:
            print("\n\n")
            password = getpass("Şifre: ")
            print("\n\n")
            baslangicSayisi = int(input("Kaçıncı hesaptan başlansın: "))
            print("\n\n")
            for i in range(baslangicSayisi, (baslangicSayisi + numberOfAccount)):
                app =  application.Application()
                app.start("C:\Program Files (x86)\Legend Online\Legend Online.exe")
                email = emailFirstPlace + str(i) + "@" + emailType
                pyperclip.copy(email)
                time.sleep(5)
                pyautogui.click(1224,627) #Hesap geçmişini aç.
                time.sleep(0.5)
                pyautogui.click(1223,654) #Son hesabı sil
                time.sleep(0.5)
                pyautogui.click(1049,620) 
                pyautogui.hotkey('ctrl', 'v') # epostayı yapıştır
                time.sleep(0.5)
                pyperclip.copy(password)
                time.sleep(0.5)
                pyautogui.click(1051,681) 
                pyautogui.hotkey('ctrl', 'v') # şifreyi yapıştır
                time.sleep(0.5)
                pyautogui.click(1348,631) # oyuna gir
                time.sleep(10)
                pyautogui.click(1548,128) # server listesine gir
                time.sleep(3)
                pyautogui.click(407,89) # eski oyunu kapat ( son serverı )
                time.sleep(3)
                pyautogui.click(800, 816) # yeni sunucuya gir
                time.sleep(15) #Ekranın yüklenmesini bekle
                eksayi = random.randint(3, 9)    
                time.sleep(0.5)
                pyperclip.copy(eksayi) #Random sayı üret
                time.sleep(0.5)
                pyautogui.click(1395,818) # isme tıkla
                time.sleep(0.5)
                pyautogui.hotkey('ctrl', 'v') # Ismi koy
                time.sleep(0.5)
                pyautogui.click(1325,899) #Oyunu başlat
                time.sleep(35)
                app.kill()
        else:
            print("Hata! Hesap sayısı 100 den fazla olmamalı veya 0dan az olmamalıdır.")
            print("\n\n")
            os.system("PAUSE")
    else:
        print("Hata! E-posta türleri outlook.com, hotmail.com veya gmail.com olabilir.")
        print("\n\n")
        os.system("PAUSE")
else:
    print("Hata! En fazla 8 harf ve en az 3 harf girilmeli.")
    print("\n\n")
    os.system("PAUSE")

