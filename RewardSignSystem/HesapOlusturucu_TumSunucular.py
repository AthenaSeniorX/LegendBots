from getpass import getpass
import os
import random
import time
from selenium import webdriver
from selenium.webdriver.common.by import By
from pywinauto import application
import pyautogui
import pyperclip
## Legend Online Helper için özel olarak geliştirilmiştir Bot 1
## Otomatik hesap(lar) kurmak için yapılmıştır.
legendOnlineFlag = False
print("\n")
print("█░░ █▀▀ █▀▀ █▀▀ █▄░█ █▀▄   █▀█ █▄░█ █░░ █ █▄░█ █▀▀   █░█ █▀▀ █░░ █▀█ █▀▀ █▀█")
print("█▄▄ ██▄ █▄█ ██▄ █░▀█ █▄▀   █▄█ █░▀█ █▄▄ █ █░▀█ ██▄   █▀█ ██▄ █▄▄ █▀▀ ██▄ █▀▄")
print("\nHesap Kurma Botu Powered by AthenaSenior \n\n")
print("\nKod çoğaltılamaz veya değiştirilemez. Tespit edildiği takdirde adli işlemler başlatılır. Bol Farmlar dileriz..\n")
print("\n______________________________________________________________________________________________________________________\n")
emailFirstPlace = input("- Email'in sol tarafı? \n Örnek: ****1@gmail.com, ****2@gmail.com ... şeklinde hesaplar açılacak.\n Bu e-posta kullanılabilir o yüzden mümkün olduğunca farklı şeyler girin. \n En az 3, en fazla 8 harflik kombinasyonlar olmalıdır. \n **** : ")
print("\n\n")
if(len(emailFirstPlace) <= 8 and len(emailFirstPlace) >= 3):
    emailType = input("- Email'in sağ tarafı? \n Örnek: "+ emailFirstPlace +"@****** şeklinde hesaplar açılacak. \n İzin verilen türler: gmail.com veya hotmail.com veya outlook.com \n **** : ")
    print("\n\n")
    if emailType == "hotmail.com" or emailType == "gmail.com" or emailType == "outlook.com":
        numberOfAccount = int(input("- Kaç hesap kurulacak? 4'ün katlarını yazın. \n Bir kerede max 100 hesap açılabilir: "))
        for i in range(1, numberOfAccount + 1):
            email = emailFirstPlace + str(i) + "@" + emailType
            print(email)
        print("Hesapları kurulacaktır.")
        print("\n\n")
        password = getpass("Şifre: ")
        print("\n\n")
        for i in range(1, numberOfAccount + 1):
            app =  application.Application()
            app.start("C:\Program Files (x86)\Legend Online\Legend Online.exe")
            email = emailFirstPlace + str(i) + "@" + emailType
            pyperclip.copy(email)
            time.sleep(5)
            pyautogui.click(1347,702) #Kaydol'a bas
            time.sleep(1)
            pyautogui.click(1033,628) 
            pyautogui.hotkey('ctrl', 'v') #Epostayı yapıştır
            time.sleep(1)
            pyperclip.copy(password)
            time.sleep(1)
            pyautogui.click(1022,684)
            pyautogui.hotkey('ctrl', 'v')#Şifreyi yapıştır
            time.sleep(1)
            pyautogui.click(1028,736)
            pyautogui.hotkey('ctrl', 'v')#Şifre tekrarını yapıştır
            time.sleep(1)
            pyautogui.click(1270,697) # Kullanıcı sözleşmesini kabul et
            time.sleep(1)
            pyautogui.click(1349,626) # Kaydol.
            time.sleep(15) #Ekranın yüklenmesini bekle
            eksayi = random.randint(3, 9)    
            time.sleep(0.5)
            pyperclip.copy(str(eksayi))
            time.sleep(0.5)
            pyautogui.click(1533,820) # Yeniden random isim üret
            time.sleep(0.5)
            pyautogui.click(1395,818) # Sayıyı koymak için isme tıkla
            time.sleep(0.5)
            pyautogui.hotkey('ctrl', 'v') # Ismi koy
            time.sleep(0.5)
            pyautogui.click(1325,899) #Oyunu başlat
            time.sleep(12)
            app.kill()
    else:
        print("Hata! E-posta türleri outlook.com, hotmail.com veya gmail.com olabilir.")
        print("\n\n")
        os.system("PAUSE")
else:
    print("Hata! En fazla 8 harf ve en az 3 harf girilmeli.")
    print("\n\n")
    os.system("PAUSE")

