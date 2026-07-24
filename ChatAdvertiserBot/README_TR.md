# Legend Chat Reklam Botu — Windows Server 2022

Bu sürüm, Gül botundaki çalışan HWND yaklaşımını reklam botuna uyarlar:

- Oyun penceresini HWND ile bulur ve reklam botunun kendi penceresini hedef listesinden çıkarır.
- Koordinatları ekran yerine oyun penceresinin **client alanına** göre kullanır.
- CEF/Flash render child HWND'sini bulur.
- Tıklama, metin ve Enter olaylarını `SendMessageTimeoutW` ile fiziksel fareyi ve pencere odağını almadan iletir.
- Oyun kapanıp yeniden açılırsa hedef HWND'yi yeniden arar.
- Donmuş bir oyun penceresinde sonsuza kadar takılmak yerine zaman aşımı uygular.
- İşlem geçmişini `advertiser.log` dosyasına döndürmeli olarak yazar.

## İlk kurulum ve doğrulama

1. Windows Server 2022'ye Python 3 kurun. Kurulumda `tcl/tk and IDLE` bileşeni açık olmalıdır.
2. Oyunu ve botu aynı Windows kullanıcısının aynı interaktif oturumunda açın.
3. `BASLAT_BOT.bat` dosyasını çalıştırın.
4. **Pencereyi Bul** düğmesine basın. Günlükte oyun HWND'si, client boyutu ve CEF/Flash input HWND'si görünmelidir.
5. X/Y değerleri ekran koordinatı değil, oyun penceresinin sol üst iç köşesine göre client koordinatıdır.
6. **TEST MESAJI GÖNDER** düğmesini yalnız bir kez kullanın ve mesajın oyun sohbetinde gerçekten göründüğünü elle doğrulayın.
7. Doğrulama başarılıysa reklam aralıklarını ayarlayıp botu başlatın.

Botun “input kabul edildi” kaydı, Windows'un HWND mesajını kabul ettiğini gösterir. Oyunun sohbet sunucusunun mesajı gerçekten yayımladığını ilk kurulumda ve yeniden bağlantı sonrasında oyun ekranından ayrıca doğrulayın.

## RDP bağlantısını kapatma

- Başlat menüsündeki **Sign out / Oturumu kapat** seçeneğini kullanmayın; bu işlem oyunu ve botu kapatır.
- En güvenli akış: bot çalışırken `BAGLANTIYI_KOPAR_BOT_CALISSIN.bat` dosyasını çalıştırın. Betik mevcut RDP oturum ID'sini doğrular ve yalnız o oturumu `tscon` ile console masaüstüne aktarmayı dener.
- `tscon` VPS sağlayıcısında desteklenmiyorsa RDP uygulamasını yalnız pencerenin **X** düğmesiyle kapatın. Windows varsayılan olarak bağlantısı kesilmiş oturumdaki programları çalışır durumda tutar; sunucuda farklı bir Grup İlkesi tanımlanmışsa bu ilke baskın gelir.
- Oyunu minimize etmeyin. HWND input'u odak gerektirmese de bazı CEF/Flash sürümleri minimize durumda kendi işleme/render döngüsünü yavaşlatabilir.

Windows Grup İlkesi yolu:

`Bilgisayar Yapılandırması > Yönetim Şablonları > Windows Bileşenleri > Uzak Masaüstü Hizmetleri > Uzak Masaüstü Oturumu Ana Bilgisayarı > Oturum Süresi Sınırları`

`Bağlantısı kesilmiş oturumlar için süre sınırı ayarla` değerinin **Hiçbir zaman** olduğundan emin olun. Etki alanı ilkesi kullanılıyorsa yerel ayarı geçersiz kılabilir.

Microsoft başvuruları:

- [tscon komutu — Windows Server 2022](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/tscon)
- [Remote Desktop Session Time Limits ilkeleri](https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-admx-terminalserver)

## Önemli sınır

HWND modu RDP istemcisine, fiziksel fareye ve aktif pencere odağına bağımlılığı kaldırır. Buna rağmen oyun istemcisinin kendisi bağlantısı kesilmiş oturumda çalışmayı bırakırsa, sunucu yeniden başlarsa, Windows kullanıcıyı oturumdan çıkarırsa veya oyun ağı koparsa hiçbir Win32 yöntemi tek başına yüzde yüz teslimat garantisi veremez. Sunucu yeniden başlatıldıktan sonra oyun oturumu ve bot tekrar açılmalıdır.
