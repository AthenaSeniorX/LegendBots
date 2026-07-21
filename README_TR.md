# LegendBots mevcut hesap giriş otomasyonu

Bu sürüm hesap kaydı oluşturmaz. Belirtilen mevcut hesaplarla sırasıyla normal
Chrome gizli penceresinde ve Legend Online masaüstü istemcisinde giriş yapar.
Selenium/WebDriver kullanılmaz.

İstemci her hesapta kaydedilmiş eski e-postayı ve şifreyi önce tamamen temizler,
ardından yeni değerleri panodan yapıştırır. Giriş ekranı istemci penceresine göre
oransal koordinatlarla, karakter ekranı ise DPI uyumlu çoklu ölçekli görsel
eşleştirmeyle yönetilir.

Karakter türü/seçimi değiştirilmez. Karakter ekranında yalnızca `A-Z` ve `1-9`
karakterlerinden oluşan 12 karakterlik rastgele bir ad girilir ve altındaki
`Oyuna Gir` düğmesiyle oyun içine geçilir. İsim kutusu, yükleme sırasında yeri
değişebilen butona göre değil aynı satırdaki zar simgesine göre bulunur. Ad
yazıldıktan sonra kutunun içindeki piksel değişimi doğrulanır; yeterli değişim
yoksa otomasyon giriş düğmesine basmaz ve yanlış adla karakter oluşturmaz.

Karakter ekranı zar simgesiyle doğrulandıktan sonra oyun alanında aşağı mouse
wheel hareketi gönderilir. Bu hareket geçici scrollbar'ı kaldırıp Flash
çözünürlüğünü sabitler; zar, isim alanı ve giriş düğmesi bu işlemden sonra
yeniden aranır.

## Kurulmuş hesapları atlama

`Oyuna Gir` tıklanan hesap önce `pending_verification` olarak
`completed_accounts.json` dosyasına yazılır. Hesap ancak istemci penceresinin alt
kısmındaki iki ayrı mavi yükleme çubuğu iki ardışık ekran karesinde doğrulanırsa
`completed_accounts` listesine taşınır. Böylece e-posta ilerleme anahtarı ve
görsel mavi-bar kanıtı birlikte kullanılır. Çift doğrulamadan sonra istemci hemen
kapatılır ve sıradaki hesaba geçilir.

Program daha sonra elle veya otomatik yeniden başlatıldığında tamamlanmış
e-postaları web/istemci açmadan tamamen atlar ve verilen aralıktaki ilk
kurulmamış hesapla devam eder. Dosya bozuk veya okunamaz durumdaysa aynı hesabı
yanlışlıkla tekrar kullanmamak için program güvenli biçimde durur.

## Kesintisiz denetim ve yeniden deneme

Varsayılan `--max-account-attempts 0` değeri sınırsız denetim anlamına gelir.
Web, görsel eşleştirme, istemci veya mavi-bar doğrulamasından biri başarısızsa
istemci/tarayıcı temizlenir, hata ve deneme sayısı ilerleme dosyasına yazılır ve
aynı hesap 10, 20, 40 ve en fazla 60 saniyelik kontrollü gecikmeyle tekrar
denenir. Hesap kesin doğrulanmadan sonraki hesaba geçilmez. Böylece örneğin 37.
hesapta geçici sunucu hatası oluşursa sistem 37'yi tamamlar ve 38'den devam eder.

İsteğe bağlı sınırlı deneme:

```powershell
python .\VarOlanHesaplardanHesapOlusturucu_Brov.py --start 1 --count 100 --max-account-attempts 5 --retry-delay 10
```

## Kurulum

```powershell
cd C:\Users\huigf\LegendBots
python -m pip install -r requirements.txt
python .\VarOlanHesaplardanHesapOlusturucu_Brov.py --check
```

## Çalıştırma

Varsayılan olarak `hadestxz1@outlook.com` adresinden başlayarak 4 hesap işler.
Şifre ekranda görünmeyen güvenli istemle sorulur:

```powershell
python .\VarOlanHesaplardanHesapOlusturucu_Brov.py
```

Farklı hesap serisi:

```powershell
python .\VarOlanHesaplardanHesapOlusturucu_Brov.py --prefix kullanici --domain outlook.com --start 10 --count 5
```

Katılımsız çalıştırma gerekiyorsa parolayı komut satırına yazmak yerine yalnızca
o PowerShell oturumu için ortam değişkeni kullanın:

```powershell
$env:LEGEND_PASSWORD = Read-Host "Şifre"
python .\VarOlanHesaplardanHesapOlusturucu_Brov.py
Remove-Item Env:\LEGEND_PASSWORD
```

Fareyi ekranın sol üst köşesine götürmek veya terminalde `Ctrl+C` kullanmak
otomasyonu güvenli biçimde durdurur. Ayrıntılı kayıt `automation.log` dosyasına
yazılır. Otomasyon sırasında ekran kilitlenmemeli ve Chrome/istemci pencereleri
başka bir pencereyle kapatılmamalıdır.

## Doğrulanmış hesapları dörtlü gruplara ayırma

`grupla.js`, yalnızca `completed_accounts.json` içindeki kesin doğrulanmış
hesapları kullanır. Hesap numaralarına göre her dört hesap bir gruptur:

- 1. grup: 1, 2, 3, 4; lider 1
- 2. grup: 5, 6, 7, 8; lider 5
- 3. grup: 9, 10, 11, 12; lider 9

Eksik dörtlüler işlenmez. Program başlarken hangi gruptan ve o grubun hangi üye
konumundan devam edeceğini sorar. Seçilen grubun lideri davet linkini üretmek için
her durumda açılır; seçilen üye konumundan itibaren aynı grubun üyeleri, ardından
sonraki hazır gruplar sırayla işlenir.

```powershell
node .\grupla.js
```

Terminalden en kolay başlatma komutu:

```powershell
.\baslat-grupla.cmd
```

Her lider linki oluşturulduğunda tam URL terminalde `TAM DAVET LİNKİ` etiketiyle
gösterilir ve `grupla.log` dosyasına zaman, grup, lider hesabı/rolü ve tam URL
içeren tek satırlık JSON kaydı eklenir. URL içindeki `um` özel oturum verisi
olduğundan `grupla.log` Git'e eklenmez ve başkalarıyla paylaşılmamalıdır.

Önce yalnızca oluşacak sırayı görmek için güvenli plan modu kullanılabilir. Bu
mod tarayıcı açmaz, istek göndermez ve kayıt dosyasını değiştirmez:

```powershell
node .\grupla.js --plan
```

Her grupta önce 1. üye/lider ayrı gerçek gizli Chrome oturumunda açılır. Lider
oturumundan tek takım linki üretilir ve yalnızca o grup tamamlanana kadar çalışma
belleğinde tutulur. Ardından her katılımcı kendi yeni gizli oturumunda ilk sekmede
giriş yapar; aynı gizli oturumun ikinci sekmesinde lider linki açılır. E-posta ve
şifre görünür alanlara normal tıklama ve klavye olaylarıyla yazılır; Selenium
kullanılmaz. F12 açıldığında oluşan görünüm daralması ve yeniden yerleşim etkisi
otomatik olarak taklit edilir. `Kabul Et` alanı ekranda ortalanır, güncel koordinatı
ölçülür ve normal mouse hareketi ile `mouse down/up` gönderilir. Ekran kapanmaz ve
istek oluşmazsa bu işlem kontrollü olarak en fazla beş kez tekrarlanır. Oluşan
gerçek `POST /agreeTeam` isteğinin alanları ve yanıtı dinlenir. Sonraki hesaba ancak
üye sunucu takım listesinde görüldüğünde ve davet ekranının iki ardışık yüklemede
kapalı kaldığı doğrulandığında geçilir. Grup bittiğinde lider linki çalışma
belleğinden de kaldırılır; sonraki grup kendi liderinden yeni link üretir.

Canlı çalışma başladığında `onaylanmis_gruplar.json` atomik olarak oluşturulur ve
her denemeden sonra güncellenir. Dosyada grup/üye durumları, kaynak karakter
doğrulaması, deneme geçmişi, API sonucu, sunucu kadrosu ve çift UI doğrulaması
ayrıntılı tutulur. Parola, `um` değeri ve tam davet URL'si yazılmaz; davet linki
yalnızca SHA-256 iziyle kaydedilir.

### CloudFront 403 koruması

Gruplama otomasyonu Puppeteer ile gelen test tarayıcısını değil, Windows'ta
kurulu gerçek Google Chrome'u kullanır. Tüm üst seviye sayfa açma/yenileme ve
`/binding` istekleri tek bir hız sınırı kuyruğundan geçer. Varsayılan güvenli
aralıklar şunlardır:

- sayfa ve kritik API istekleri arasında en az 15 saniye,
- hesaplar arasında 60 saniye,
- gruplar arasında 180 saniye,
- CloudFront 403 görülürse aynı oturumu koruyarak önce 10, sonra 20, sonra en
  fazla 30 dakika bekleme.

403 sayfası HTTP durum koduna ek olarak `The request could not be satisfied`,
`Generated by cloudfront` ve `Request ID` gövde imzalarından da tanınır. Böyle
bir sayfa normal etkinlik/giriş sayfası veya başarılı takım doğrulaması olarak
kabul edilmez. Program yeni hesapla hızlı tekrar yapmaz; aynı gizli oturumu
korur, devre kesiciyi çalıştırır ve kaldığı isteği yeniden dener. Dört kontrollü
denemeden sonra dış servis hâlâ engelliyse mevcut JSON durumunu bozmadan durur.

Süreler gerekirse yalnızca ilgili PowerShell oturumunda değiştirilebilir:

```powershell
$env:LEGEND_NAVIGATION_INTERVAL_MS = '15000'
$env:LEGEND_ACCOUNT_COOLDOWN_MS = '60000'
$env:LEGEND_GROUP_COOLDOWN_MS = '180000'
$env:LEGEND_CLOUDFRONT_BACKOFF_MS = '600000'
$env:LEGEND_CLOUDFRONT_MAX_ATTEMPTS = '4'
node .\grupla.js
```

Kurulu Chrome farklı bir yerdeyse `LEGEND_CHROME_PATH` tam `chrome.exe` yolu
olarak verilebilir. CloudFront dış bir servis olduğu için 403'ün hiç oluşmaması
program tarafından garanti edilemez; bu koruma istek yoğunluğunu düşürür, 403'ü
başarı saymayı engeller ve güvenli/otomatik toparlanma sağlar.
