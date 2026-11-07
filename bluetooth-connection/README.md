# PianoMan Bluetooth connection

Yamaha CLP-835 için macOS 13+ üzerinde çalışan yerel BLE MIDI giriş/çıkışı.
Objective-C ve CoreBluetooth kullanır. CoreMIDI sürücüsü oluşturmaz;
MIDI karakteristiğinin bildirimlerini doğrudan okuyup JSON olarak verir.
Xcode/Command Line Tools dışında paket gerektirmez.

## Kullanım

```sh
./piano start
./piano status
./piano stop
```

Start ön planda çalışır. Status ve stop ayrı bir terminalden çağrılır.
Ctrl+C, SIGTERM ve terminal kapanışı (SIGHUP) da aynı temiz kapanışı başlatır.
Birden fazla örnek açılamaz. Stop tamamlandığında tekrar start kullanılabilir.

`./build.sh` kaynakları derler. İlk start, derleme yoksa kendisi derler.
Kaynak değiştirdikten sonra çalışan aracı durdurup yeniden derlemek gerekir.

```sh
./piano start --timeout 90 --duration 120
./piano start --uuid <PIANO_DEVICE_UUID>
```

Varsayılan hedef `--name CLP-835`, bağlantı süresi `--timeout 60` saniyedir.
`--duration 0` kullanıcı durdurana kadar dinler; pozitif süre ready sonrasında başlar.
`--uuid` macOS'un daha önce gördüğü belirli bir cihaz kimliğine yeniden bağlanır.
Verilmezse BLE MIDI servisi yayınlayan CLP-835 / CLP-835 MIDI adlı cihaz aranır.

## Kaynak sahipliği ve güvenlik

Yalnızca uygulamanın kendi CoreBluetooth bağlantısı ve MIDI bildirim aboneliği
açılır. Stop, cancelPeripheralConnection çağrısından sonra macOS'un kopma
bildirimini bekler. Dört saniyede onay gelmezse açıkça hata bildirir; temiz
kapandığını varsaymaz. Başka uygulamaların bağlantısını veya sistem Bluetooth
durumunu değiştiren bir API çağrılmaz.

Sistem servisi, LaunchAgent, otomatik başlangıç veya zamanlanmış iş kurulmaz.
Bluetooth sıfırlanmaz; başka süreçler öldürülmez. Süreç kendisi kapanır.
Yalnızca bu kullanıcıya açık `.runtime/control.sock` üzerinden kontrol edilir;
TCP portu açılmaz. Stop, kilidin bırakılmasını ve kendisine ait kapanış kaydını bekler.
Beklenmedik süreç sonlanmasından sonra yeni start eski soketi kilidi aldıktan sonra kaldırır.

Nota verisi diske kaydedilmez. Build çıktıları `build/`, küçük kilit/soket ve
son kapanış durumu `.runtime/` içindedir. İkisi de Git dışında bırakılmıştır.

macOS'un uygulama Bluetooth izni, piyanonun cihaz kimlik doğrulamasından ayrıdır.
Piyano gerektiriyorsa işletim sisteminin eşleştirme/şifreleme akışı devreye girer;
uygulama bu adımları atlatmaz. BLE MIDI standardı tek başına piyanonun PIN veya
üzerinden fiziksel onay zorunlu tuttuğu garantisini vermez. UUID seçimi de
kriptografik cihaz kimlik doğrulaması değildir.

Piyano açık, Bluetooth On ve menzilde olmalıdır. Ses için kullanılan Bluetooth
Pairing ekranının açık kalması gerekmez. Başlangıç GATT okuması ve MIDI bildirimi
aboneliğine ek olarak, kullanıcı CLP ses çıkışını seçip Dinle'yi başlattığında
nota ve sustain CC64 mesajları gönderilir. Program değişimi, SysEx veya cihaz
ayar komutu gönderilmez.

## Dinleme çıkışı

Görünüm → Dinleme sesi, uygulamanın sentezleyicisini veya CLP'yi seçer; tercih
kaydedilir. CLP seçiliyken uygulama ses üretmez, çıkış sesi piyanonun ses düğmesinden
ayarlanır. Bu Bluetooth Audio aktarımı değildir: CLP'nin ses motoru MIDI notalarını
çalar. Kanal 1/2 sol/sağ el için kullanılır; mevcut cihaz ses/program ayarı korunur.

`piano-output.js`, seçili ellerin nota başlangıçlarını, gerçek tuş bırakma
zamanlarını, velocity ve birleşik sustain olaylarını hazırlar. `BLEMIDIOutput`
aynı CoreBluetooth bağlantısında bu olayları monotonik saatle zamanlar. Çalma
başlangıcı UI saatine bir kez eşlenir; HTTP üzerinden her notaya ayrı istek yapılmaz.
BLE-MIDI 13 bit timestamp kullanılır; yazma akış kontrolü
`canSendWriteWithoutResponse` ve `peripheralIsReadyToSendWriteWithoutResponse`
ile uygulanır. Gönderim 350 ms'den fazla geri kalırsa eski notalar topluca çalınmaz;
çalma durdurulup hata bildirilir.

Başlat/durdur/heartbeat komutları mevcut kullanıcıya özel kontrol soketinden geçer.
Dinleme soketi non-blocking kalır; Darwin'de bu bayrağı miras alan kabul edilmiş
istemci soketi ise arka plan okuyucusunda timeout ile blocking moda alınır.
Böylece parçalı gelen JSON komutu tamamlanmadan EAGAIN yüzünden kapatılmaz.
Yanıtlar tam yazılır ve BLE zamanlama kuyruğunu bloke etmez. Derleme çalışmakta olan
ikili dosyanın üzerine yazmaz; yeni dosya atomik olarak yerleştirilir. Tarayıcı
servisi her yeni kullanıcı bağlantısında kaynakların güncelliğini kontrol eder.
Sayfa 500 ms aralıkla çalma oturumunu canlı tutar; iki saniye haber alınamazsa
yerel sahip notaları ve sustain'i bırakır. Duraklatma, sarma, hız/el/çıkış değişimi,
ders değişimi, sayfanın gizlenmesi ve kapanış aynı durdurma yolunu kullanır.
Kasıtlı bağlantı kesmede nota bırakma kuyruğunun boşalması beklenir. Fiziksel radyo
bağlantısı ansızın koparsa karşı cihaza bırakma mesajı ulaşması garanti edilemez.
Uygulama başka MIDI bağlantılarını ve sistem Bluetooth durumunu değiştirmez.

Piyanoda MIDI Note On/Off ve Control Change alımının açık olması gerekir; uygulama
bu cihaz ayarlarını kendiliğinden değiştirmez. CLP alım ayarları:
https://data.yamaha.com/files/download/other_assets/3/2289433/CLP-885_RM_En_A0_web.pdf

## Çıktı

Bağlantı hataları `connection_issue` olayında yapılandırılmış `diagnostic`
verisiyle taşınır: kararlı hata kodu, bağlantı aşaması, cihazın bu denemede
görülüp görülmediği, bağlantının kurulması ve varsa macOS hata domain/kodu/metni.
İlk neden kapanışta korunur; `stopped` olayı kapanış onayını da ekler.
Python ve native host bu veriyi arayüze değiştirmeden taşır.
`bluetooth-diagnostics.js`, iki arayüzün ortak açıklama ve çözüm adımlarını tutar.
Hata paneli kendiliğinden açılır; teknik ayrıntı ayrıca açılabilir.

Mac Bluetooth kapalı, izin reddi/kısıtı/bekleyişi, desteklenmeyen donanım,
servis yeniden başlaması, piyanoya erişilememe, eşleştirme, MIDI keşfi/okuması/
bildirimi ve bağlantı kaybı ayrı ele alınır. Bağlandıktan sonra Mac Bluetooth
durumu değişirse de olay işlenir. Bir cihazın uzaktan görünmemesi onun kapalı,
Bluetooth'u kapalı, uzak veya meşgul olduğunu tek başına kanıtlamaz; arayüz bu
sınırı açıkça söyler. Genel zaman aşımı bilinen Mac/izin hatasını örtemez.
Yeni deneme önceki tanıyı temizler; kapanış bitmeden yeniden deneme açılmaz.

“Kayıtlı piyanoyu yeniden ara” yalnız PianoMan'in sakladığı UUID seçimini silip
adı/servisiyle yeniden arar. macOS eşleştirmelerini, diğer uygulamaları veya
piyanonun ayarlarını değiştirmez. Bu işlem yalnız kullanıcı düğmeye basarsa yapılır.

İzin yönlendirmesi: https://support.apple.com/guide/mac-help/mchl211c911f/mac
Mac yetkilendirme durumları: https://developer.apple.com/documentation/corebluetooth/cbmanagerauthorization
Piyano Bluetooth On/Audio Pairing ayrımı: Yamaha CLP-800 Reference Manual, sayfa 20.

```json
{"event":"note_on","note":60,"name":"C4","velocity":82,"channel":1}
{"event":"note_off","note":60,"name":"C4","velocity":64,"channel":1}
{"event":"pedal","pedal":"sustain","controller":64,"value":127,"pressed":true,"channel":1}
```

Örnekler kısaltılmıştır. `device_time_ms`, cihazın 8192 ms'de dönen BLE MIDI
saatidir; `received_monotonic_seconds` Mac'in paket alım zamanı, `time_unix`
çıktının duvar saatidir. Bu saatler birbirine eşit varsayılmaz.
Orta Do MIDI 60/C4'tür. Velocity=0 Note On, Note Off olarak çözülür.
Sustain (64), sostenuto (66), soft (67) değerleri 0–127 olarak korunur.
`pressed` 64 eşiğini kullanır. Diğer kanal/kontrol mesajları da yayımlanır.
Running status, paket içi zaman taşması ve SysEx devam paketleri ayrıştırılır.
SysEx içeriği tutulmaz; active sensing ve timing clock çıktıyı doldurmaz.

`ready`, MIDI bildirimlerine abone olunduğunu bildirir. Gerçek fiziksel giriş
ancak `note_on` / `note_off` olayları geldiğinde doğrulanmış olur.
`../server.py`, `bluetooth_bridge.py` üzerinden bu süreci başlatır ve kapatır.
`bluetooth.js`, canlı olayları mevcut `window.pianomanInput` arayüzüne aktarır.
Sayfadaki Bağlan / Bağlantıyı kes düğmeleri için ayrıca CLI açmak gerekmez.
Native CLI kendi TCP portunu açmaz; yerel HTTP/SSE servisi Python'a aittir.

Protokol: https://midi.org/midi-over-bluetooth-low-energy-ble-midi
