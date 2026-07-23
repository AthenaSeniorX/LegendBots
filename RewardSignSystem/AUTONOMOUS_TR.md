# LegendBots otonom dört worker + Bot 0 Manager v2.0 sistemi

Bu sistem beş mantıksal bot rolünde çalışır. Operatöre yalnız BOT 0 Manager'ın
PowerShell ekranı gösterilir; dört çalışma botu Manager'ın sahibi olduğu gizli
worker hostlarında çalışır:

1. **BOT 1 / HESAP** — `VarOlanHesaplardanHesapOlusturucu_Brov.py` dosyasını her seferinde tek hesap için çalıştırır. İki mavi yükleme çubuğunu öncelikli başarı kanıtı sayar; çubuklar kaçırılırsa oyun içindeki `Hemen Dene` ekranını iki ardışık karede doğrular. Kanıttan sonra istemciyi en az 12 saniye açık tutarak OAS rol yazımına süre verir. Bot 2 yine de boş rol kaydı görürse aynı hesabı, nickname'i değiştirmeden Bot 1'in kalıcı yeniden doğrulama kuyruğuna gönderir.
2. **BOT 2 / GRUPLA** — hazır havuzda en az dört hesap olduğunda eskiden yeniye ilk dört hesabı atomik olarak claim eder. Claim anında bu hesaplar hazır havuzdan düşer. `grupla.js` dört hesabı doğrular, gruplar ve kesin onaylı paketi sign havuzuna taşır.
3. **BOT 3 / SIGN** — yalnızca tam dört hesaplı paketi claim eder. `sign.js` her hesabı iki aşamalı doğrular. Kesinti olursa daha önce doğrulanan hesapları tekrar çalıştırmadan aynı pakete devam eder.
4. **BOT 4 / REWARD** — Bot 3'ün ilk dört kesin sign'ından sonra takımın 24 saatlik döngüsünü izler. Süre dolunca dört hesabı Bot 3 ile aynı gerçek `/sign` doğrulamasıyla yeniden işler. Takımdaki her hesabın kendi `/userGiftCode` listesini nihai kanıt sayar ve açılmış takım ödülünü o hesap adına `/signGetCode` üzerinden bir kez alır. Kodlar takım içinde ortaktır varsayılmaz: örneğin 5 takımın ilk eşiği tamamlandığında 5 × 4 = 20 ayrı hesap kodu saklanır. Her hesap ve ödül başarısı anında kalıcılaştırıldığı için kesintide tamamlanan uzak işlem tekrarlanmaz. Kodlar ayrıca Firestore hedefinde `arrayUnion` ile idempotent yazılır, belge geri okunup her kod görülmeden teslim edilmiş sayılmaz; başarısız teslimatlar kalıcı backoff kaydıyla yeniden denenir. 100 sign eşiği ve dokuz ödülün dört hesabın tamamında tamamlanmasından sonra gereksiz günlük sign döngüsü otomatik biter.
5. **BOT 0 / MANAGER v2.0** — Sistemdeki tek ana kontrol merkezi ve muhataptır. Ayrı web veya masaüstü arayüzü açmaz; tek PowerShell ekranında canlı TUI sunar. Botların PID/heartbeat sağlığını, aktif işi ve yüzdesini, kuyruk baskısını, dakikalık işlem hızını, 403 riskini, dinamik beklemeleri ve kendi müdahale kararını gösterir. Havuzlardan biri orantısız büyüdüğünde süreli odak açar; diğer botlar aktif uzak işlemlerini yarıda kesmeden güvenli duruşa geçer. Bağımsız Windows supervisor yalnız Manager'ı geri getirir; çalışma botlarını başlatma/yenileme ve otomatik dengeleme yetkisi yalnız Manager'dadır.

BOT 2, BOT 3 ve BOT 4, CloudFront'un headless tarayıcı parmak izi engeline takılmamak için kurulu gerçek Chrome'u headful fakat minimize/off-screen arka plan modunda kullanır. Sabit 1366x900 viewport ve ayrı gizli bağlamlar sayesinde BOT 1'in görünür web/Legend istemcisiyle odak paylaşmaz. Sanal sunucu oturumu kilitlenmemeli ve ekran çözünürlüğü çalışma sırasında değiştirilmemelidir.

## İlk kurulum

`pipeline.config.json` yalnızca başlangıçta gösterilecek varsayılan hesap planını tutar:

```json
{
  "account": {
    "prefix": "hadestxz",
    "domain": "outlook.com",
    "start": 1,
    "end": 200
  }
}
```

Her başlatmada sihirbaz bu planın ilk/son e-postasını ve hesap sayısını gösterip mutlaka onay ister. Reddederseniz e-posta öneki, alan adı, başlangıç ve bitiş numarası elle alınır. Seçim yalnızca o çalışma için ortam değişkenleriyle worker süreçlerine aktarılır; kaynak koddaki sabit hesap bilgileri kullanılmaz.

Ardından iki şifre modu sunulur:

- Bütün hesaplar ortak şifre kullanıyorsa şifre bir kez maskeli alınır.
- Şifreler farklıysa mevcut plan ve eski grup kayıtlarındaki her benzersiz e-posta için şifre maskeli olarak tek tek alınır.

Parolalar hiçbir JSON'a veya komut satırına yazılmaz. Yalnızca açılan worker süreçlerinin ortamında tutulur; hesap bazlı şifre planı süreçler arası aktarım için UTF-8 JSON'un Base64 gösterimi olarak ortamda bulunur (Base64 şifreleme değildir).

Bağımlılıklar:

```powershell
python -m pip install -r .\requirements.txt
npm install
```

## Daha önce yapılmış işlemleri otomatik algılama

Normal durumda elle kayıt girmeniz gerekmez. Her worker turunda ve her ön kontrolde şu kaynaklar otomatik uzlaştırılır:

- `completed_accounts.json` içinde mavi bar veya `Hemen Dene` oyun ekranıyla doğrulanmış hesaplar kurulmuş hesap olarak algılanır.
- `onaylanmis_gruplar.json` içindeki dört üyeli kesin gruplar doğrudan sign havuzuna alınır.
- Yarım kalmış dört üyeli grup kaydı varsa aynı paket korunarak gruplama retry kuyruğuna alınır.
- Yerel grup kaydı mevcut pipeline paketiyle eşleştirilir; aynı hesaplardan ikinci paket oluşturulmaz.
- Pipeline'da sign tamamlanmış bir kayıt daha düşük aşamaya geri düşürülmez.

İsterseniz yalnızca yerel dosyaları taratıp sonucu görebilirsiniz; bu komut web veya istemci açmaz:

```powershell
node .\automation.js --reconcile
```

Eski sign işlemleri için güvenilir bir yerel geçmiş yoksa sistem tahmin yapmaz. Sign botu hesabın `/sign` sonucunu kontrollü biçimde açar: “zaten yapılmış” yanıtını başarı kanıtı olarak kaydeder, yapılmamışsa işlemi tamamlar. Böylece manuel sign listesi gerekmez.

## Yerel kanıtı bulunmayan istisnaları tanıtma

Yalnızca eski işlem `completed_accounts.json` veya `onaylanmis_gruplar.json` içinde bulunmuyorsa `pipeline.seed.json` dosyasını doldurun. Dosyanın sonundaki `_example_shapes` yalnızca örnektir ve işleme alınmaz.

- Yalnızca kurulmuş, henüz gruplanmamış hesaplar `created_accounts` dizisine eklenir.
- Gruplanmış ama sign yapılmamış her tam dörtlü `grouped_packages` dizisine eklenir.
- Sign işlemi de tamamlanmış her tam dörtlü `signed_packages` dizisine eklenir.
- Her hesap için gerçek e-posta, sayısal `index` ve oyundaki gerçek `nickname` gerekir.
- Paket `id` değerleri benzersiz olmalıdır. Aynı hesap iki ayrı pakete yazılamaz.
- `sequence` isteğe bağlıdır; yazılırsa mevcut `onaylanmis_gruplar.json` grup numarasıyla çakışmamalıdır. Emin değilseniz alanı kaldırın.

Örnek kurulmuş hesap:

```json
"created_accounts": [
  {
    "email": "hadestxz21@outlook.com",
    "index": 21,
    "nickname": "GERCEK_KARAKTER_ADI",
    "created_at": "2026-07-21T12:00:00+03:00"
  }
]
```

Örnek gruplanmış paket:

```json
"grouped_packages": [
  {
    "id": "manual-group-001",
    "grouped_at": "2026-07-21T12:30:00+03:00",
    "accounts": [
      { "email": "hadestxz1@outlook.com", "index": 1, "nickname": "NICK1", "created_at": "2026-07-21T10:00:00+03:00" },
      { "email": "hadestxz2@outlook.com", "index": 2, "nickname": "NICK2", "created_at": "2026-07-21T10:05:00+03:00" },
      { "email": "hadestxz3@outlook.com", "index": 3, "nickname": "NICK3", "created_at": "2026-07-21T10:10:00+03:00" },
      { "email": "hadestxz4@outlook.com", "index": 4, "nickname": "NICK4", "created_at": "2026-07-21T10:15:00+03:00" }
    ]
  }
]
```

Sign yapılmış paket aynı biçimde `signed_packages` içine yazılır ve ek olarak `signed_at` eklenir.

Workerlar otomatik tespitleri ve kendi sonuçlarını `pipeline-runtime/pipeline-state.json` dosyasına kilitli ve atomik olarak ekler. Bu üretilen dosyayı elle değiştirmeyin; yerel kanıtı olmayan eski kayıt eklemek gerekirse `pipeline.seed.json` dosyasını genişletin. Kaynaklar her turda idempotent olarak birleştirilir ve tamamlanmış aşamalar geriye düşürülmez.

Başlangıçta onaylanan dinamik hesap aralığı kalıcı oturum ayarı olarak saklanır.
Şifre düz metin değildir; Windows DPAPI ile mevcut Windows kullanıcısına bağlı
olarak korunur. Bağımsız Windows supervisor görevi manager terminali de kapanırsa
manager'ı, manager da istenen Bot 1/2/3/4 hostlarını otomatik geri getirir.

## Tek komutla başlatma

PowerShell'de:

```powershell
.\start-autonomous.ps1
```

Başlatıcıdaki **Control Center v3.0** terminal genişliğine göre 72-118 sütun
arasında otomatik uyarlanır. Worker seçimiyle gerçekten çalışan süreci ayrı
gösterir; hesap/imza ilerlemesini, kuyrukları, heartbeat yaşını, 403 güvenli
beklemelerini, son olay ve son hata sinyalini tek ekranda toplar. Yeni kısayollar:

```text
1-4 / A / P     Worker operatör niyetini değiştir / hepsini aç / güvenli kapat
H / M / K       Hesap planı / çalışma modu / maskeli parola girişi
D               Bağımlılık, state, DPAPI, host ve supervisor tanılaması
O               Ayrıntılı canlı operasyon özeti ve son beş olay
L               Seçilen worker logunu salt okunur ayrı pencerede aç
R / ?           Canlı veriyi yenile / hızlı yardımı aç
S / Q           Onay kapısıyla güvenli başlat / değişiklik yapmadan çık
```

Çalışan bir worker tespit edildiğinde `S` otomatik kilitlenir; ikinci oturum
açılmaz. Buna karşılık `1-4`, `A` ve onaylı `P` komutları canlı sistemde kalıcı
worker kontrolüne dönüşür; Manager workerı aktif iş sınırında güvenle açar veya
durdurur. Ekranı hiçbir worker başlatmadan farklı terminal genişliklerinde kontrol
etmek için:

```powershell
.\start-autonomous.ps1 -Preview -Width 80
.\start-autonomous.ps1 -Preview -Width 118
```

Komut önce ikinci bir pipeline kopyası olmadığını; ardından Node, Python, Chrome, Legend istemcisi, görseller, JSON şemaları, credential planı ve bağımlılıkları kontrol eder. Kontrol başarılıysa yalnız zorunlu Manager ekranını açar; Manager kalıcı kontrol dosyasına göre seçilen dört worker hostunu gizli süreçler olarak ve tek süreç sahibi sıfatıyla başlatır. Böylece tek operatör ekranı korunur ve başlangıç/manager sahiplik yarışı yaşanmaz. Worker kontrol durumu ancak tüm ön kontroller geçtikten sonra değiştirilir. Alternatif giriş:

```powershell
node .\automation.js
```

Durum özeti:

```powershell
node .\automation.js --summary
```

## Bot 0 Manager v2.0 PowerShell komutları

Manager ekranı terminal geçmişini aşağı kaydırmadan, sabit bir kontrol paneli olarak
yaklaşık üç saniyede bir canlı yenilenir. Worker olay ve log satırları sade ana
panelde gösterilmez; yalnız istendiğinde ayrı bir PowerShell penceresinde açılır.
`%100` bir ölçüm hedefidir;
ekranda sağlık, akış dengesi, 403 güvenliği ve üretken kullanım bileşenlerinden
hesaplanan gerçek skor ayrıca gösterilir. Dış servisin gecikmesi veya 403 yanıtı
nedeniyle hiçbir yazılım sürekli gerçek `%100` verim garanti edemez; Bot 0 skoru
mümkün olan en yüksek güvenli düzeyde tutmaya çalışır.

```text
1 / 2 / 3 / 4              Botu aç veya güvenli duruşa al
start sign / stop sign     Belirli botun operatör çalışma niyetini değiştir
auto on / auto off         Otomatik havuz dengelemesini aç veya kapat
focus sign                 Bot 3'e operatör odak kilidi ver
focus off                  Odak kilidini kaldır, otomatik yönetime dön
wait                       Etkin dinamik süreleri göster
wait network 25            Ortak ağ aralığını canlı olarak 25 saniyeye sabitle
wait group 30              Gruplama hesap aralığını 30 saniyeye sabitle
wait sign auto             Sign aralığını yeniden otomatik yönetime bırak
wait auto                  Bütün manuel süre sabitlemelerini kaldır
restart reward             Bot 4'ü aktif iş sınırında güvenli yeniden başlat
log 1 / log 2 / log 3 / log 4
                            Seçilen botun canlı logunu ayrı PowerShell'de aç
status / help / q           Yenile, yardım veya Manager'ı güvenli kapat
```

Operatörün bir bot için verdiği açık/kapalı kararı
`pipeline-runtime/worker-control.json` içinde kalıcıdır. Bot 0'ın odak amacıyla
verdiği geçici bekletme ayrı alanda tutulur; Manager operatörün kapattığı botu
kendiliğinden açamaz. Dinamik/manuel zamanlayıcılar
`pipeline-runtime/manager-settings.json`, ölçümler ve karar geçmişi ise
`pipeline-runtime/manager-v2-state.json` içinde atomik olarak saklanır.

## Kesinti, retry ve 403 davranışı

- JSON değişiklikleri dosya kilidi altında ve geçici dosyadan atomik rename ile yazılır.
- Salt-okunur manager/snapshot turları state dosyasını yeniden yazmaz; disk ve kilit kullanımı yalnız gerçek durum değişikliklerinde oluşur.
- Grup, sign ve reward paketleri claim token ile korunur. Worker kapanırsa aynı paket kurtarılır; canlı ve heartbeat üreten bir workerın paketi yalnız lease süresi doldu diye ikinci workera verilmez.
- Her hesap sign başarısından hemen sonra kalıcı yazılır. Dördüncü hesapta kesinti olsa ilk üç hesap yeniden denenmez.
- Bot 4'ün günlük sign döngüsü de hesap bazında kalıcıdır. Ödül claim'i başarılı olup state yazımından önce kesinti olursa sonraki tur aynı hesabın `/userGiftCode` listesindeki `sign1..sign9` kaydını uzlaştırır ve `/signGetCode` isteğini tekrarlamaz. Bir ödül eşiği ancak takımın dört hesabının da ayrı kodu state'te bulunduğunda tamamlanmış sayılır.
- Uzak kod uzlaştırması yalnız pasif listeleme yapmaz: yerel sign sayısına göre açılmış veya takımın bir üyesinde kısmen görülmüş eşiklerde eksik hesapların `/signGetCode` işlemini idempotent biçimde tamamlar. Eski Bot 4 sürümünde uzak sign başarılı olup yerel callback kaybolmuşsa yalnız sıradaki eşik bir kez güvenli kurtarma yoklamasına alınır; henüz açılmamış eşik normal sonuç olarak kaydedilir ve altı saat içinde tekrar zorlanmaz.
- `ToplananKodlar.txt` elle düzenlenen bir kaynak değildir; Bot 4 bu görünümü yalnız kalıcı state içindeki doğrulanmış `reward_codes` kayıtlarından, tam hesap e-postalarıyla yeniden üretir. Eski seri, takma ad veya state dışı satırlar başlangıçta otomatik temizlenir.
- Bot 4 worker başlangıcında, her uzak uzlaştırmadan ve her reward paketinden sonra bekleyen kodları Firestore'a teslim eder. Yazma sonrası aynı belge geri okunur; yalnız uzak dizide görülen ve SHA-256 izi yerel kodla eşleşen kayıt `delivered` olur. Boşta beklerken teslimat kuyruğunu dakikada bir yeniden denetler.
- Bot 4 etkinlik kullanıcı kaydı eksikse state'teki tam hesap e-postası ve doğrulanmış nickname ile doğru OAS rolünü `/binding` üzerinden bağlar ve `ud` alanını geri okuyarak doğrular. `/signGetCode` geçerli oturumda geçici `ERR901: user is null` döndürürse ortak hız kapısını koruyarak aynı oturumda en fazla sekiz kez dener; kodu ancak `/userGiftCode` listesinden gördükten sonra kalıcılaştırır.
- Bot 2 OAS'ta bütün rol alanlarını boş görürse aynı login'i tekrar tekrar zorlamaz. Hesabı Bot 1 yeniden doğrulama kuyruğuna alır; Bot 0 geçici odağı Bot 1'e çevirir, onarım tamamlanınca eski account odağını bırakıp aynı grup paketini kaldığı yerden sürdürür.
- Manager'daki “ödül kodu” sayacı tekil hesap kodlarını gösterir. Dört hesabı da tamamlanan takım eşiği ayrıca `total_claimed_chests` olarak tutulur; bu iki metrik birbirinin yerine kullanılmaz.
- `/signGetCode` alanı ödül eşiği değildir: 5/10/15/20/30/40/60/80/100 eşikleri sırasıyla `sign_level=1..9` olarak gönderilir. İstekte `user_id`, `um` ve `sign_level` zorunludur.
- Grup ve sign kuyrukları katı FIFO çalışır. En eski paket retry/403 soğumasındaysa daha yeni paket claim edilmez.
- Normal hatalarda 30 saniyeden başlayıp en çok 15 dakikaya çıkan jitter'lı exponential backoff uygulanır.
- BOT 1, BOT 2, BOT 3 ve BOT 4'ün tüm OAS/oyun navigasyonları ve kritik API çağrıları tek bir makine hız kapısından geçer; minimum aralık 15 saniyedir. Login gönderimleri ayrıca kapıdan geçirilir.
- Sign hesapları arasında en az 15 saniye beklenir. Aynı oturumdaki geçici `ERR901` tekrarlarında ikinci bir sabit sleep uygulanmaz; ortak ağ kapısı tek başına güvenli aralığı sağlar.
- Miras kalan ortam değişkenleri güvenli tabanların altına inemez: ağ kapısı ve sign hesap geçişi 15 saniye, ilk 403 geri çekilmesi 120 saniyedir. Daha büyük kullanıcı değerleri korunur.
- CloudFront 403 durumunda `Retry-After` başlığına uyulur. Başlık yoksa yaklaşık 2, 4 ve 8 dakikalık adaptif bekleme uygulanır; yerel geri çekilme 15 dakikayı aşmaz. Sunucu daha uzun bir `Retry-After` bildirirse bu süre güvenlik gereği korunur.
- Normal OAS/oyun istekleri, çakışmayı önlemek için bütün botların paylaştığı hız sırasından geçer. Bir bot 403 gördüğünde devre kesici önce yalnız o botu soğumaya alır. Manager v2 ayrıca son 15 dakikadaki 403 yoğunluğu, etkin bot sayısı ve havuz baskısına göre ortak süreleri yükseltebilir veya tek bota süreli odak ayırarak diğer çalışma botlarını aktif iş sınırında güvenli bekletebilir.

Hiçbir yazılım dış servisin 403 vermeyeceğini garanti edemez. Bu sistem engeli aşmaya çalışmaz; istek yoğunluğunu sınırlar, sunucu talimatına uyar ve kalıcı durumu bozmadan bekler.

## Önemli çalışma koşulları

- BOT 1 çalışırken Windows oturumu açık ve ekran kilidi kapalı olmalıdır.
- Uzak masaüstü bağlantısını kapatınca ekran çözünürlüğünü değiştiren bir sunucu yapılandırması kullanılmamalıdır.
- Aynı worker türünden ikinci kopya başlatılsa singleton kilidi onu engeller.
- Worker child süreci beklenmedik biçimde kapanırsa kendi gizli hostu 5 saniyeden başlayıp en fazla 120 saniyeye çıkan crash-loop geri çekilmesiyle yeniden başlatır. Beş dakika sağlıklı çalışan süreçten sonra gecikme tekrar 5 saniyeye sıfırlanır.
- Worker hostu tamamen kapanırsa manager 75 saniyelik kararlılık kontrolünden sonra yeni host açar. Hostun kendi 5–30 saniyelik normal toparlanma penceresinde ikinci host açılmaz.
- Bir workerı bilinçli kapatmak için önce `node .\automation.js --disable-worker account|group|sign|reward` kullanın. Worker güvenli işlem sınırında durur ve manager onu geri getirmez. Yeniden açmak için `--enable-worker` kullanın. Durum `node .\automation.js --worker-status` veya `--dashboard` ile görülür.
- Manager ekranındaki `Q`, dört çalışma botunun istenen durumunu değiştirmeden Manager'ı kalıcı olarak kapatır; supervisor bu bilinçli kapatmayı geri çevirmez. Sistemi yeniden başlatmak için `start-autonomous.ps1` kullanın.
- Ayrıntılı worker hataları `pipeline-runtime/logs/` altındadır; parolalar loglanmaz.
