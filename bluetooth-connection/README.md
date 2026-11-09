# rach3 Bluetooth connection

Standart Bluetooth MIDI cihazları için macOS 13+ üzerinde çalışan yerel BLE MIDI giriş/çıkışı.
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

Varsayılan işlem markadan bağımsız taramadır; CLI süre sınırı `--timeout 60` saniyedir
(uygulama 45 saniye kullanır).
`--duration 0` kullanıcı durdurana kadar dinler; pozitif süre ready sonrasında başlar.
`--uuid` macOS'un daha önce gördüğü belirli bir cihaz kimliğine yeniden bağlanır.
Verilmezse BLE MIDI servisi yayınlayan cihazlar listelenir; bağlantı açık seçim gerektirir.

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

Piyano açık, Bluetooth MIDI etkin ve menzilde olmalıdır. Bluetooth Audio
eşleştirmesi ayrı bir işlevdir; modelin MIDI bağlantı yönergesi izlenmelidir. Başlangıç GATT okuması ve MIDI bildirimi
aboneliğine ek olarak, kullanıcı piyano ses çıkışını seçip Dinle'yi başlattığında
nota ve sustain CC64 mesajları gönderilir. Program değişimi, SysEx veya cihaz
ayar komutu gönderilmez.

## Dinleme çıkışı

Görünüm → Dinleme sesi, uygulamanın sentezleyicisini veya bağlı piyanoyu seçer; tercih
kaydedilir. Piyano seçiliyken uygulama ses üretmez, çıkış sesi piyanonun ses düğmesinden
ayarlanır. Bu Bluetooth Audio aktarımı değildir: piyanonun ses motoru MIDI notalarını
çalar. Kullanıcının cihaz başına seçtiği kanal (1–16) iki el için de kullanılır; cihazın
ses/program ayarı değiştirilmez. Genel kanal 1; Roland FP-30X/60X/90X için kanal 4 önerilir.

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

“Kayıtlı piyanoyu yeniden ara” yalnız rach3’ün sakladığı UUID seçimini silip
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
`bluetooth.js`, canlı olayları mevcut `window.rach3Input` arayüzüne aktarır.
Sayfadaki Bağlan / Bağlantıyı kes düğmeleri için ayrıca CLI açmak gerekmez.
Native CLI kendi TCP portunu açmaz; yerel HTTP/SSE servisi Python'a aittir.

Protokol: https://midi.org/midi-over-bluetooth-low-energy-ble-midi


## Genel cihaz keşfi ve sahiplik

`piano start` artık marka filtresi olmadan keşif başlatır; kendiliğinden bağlanmaz.
`piano start --uuid <UUID>` açıkça seçilmiş/kayıtlı cihazı bağlar. `--name <NAME>`
yalnız CLI'nin açık isim seçimi için korunur; ürün arayüzü adla eşleştirme yapmaz.
Tarama servisi `03B80E5A-EDE8-4B33-A751-6CE34EC4C700`, MIDI karakteristiği
`7772E5DB-3868-4112-A1A9-F2669D106BF3` kullanılır. Tüm markalar aynı yoldadır.

Tek native `PianoConnection`, bulunan periferalleri, taramayı, bağlantı aşamalarını,
izin hatalarını, decoder ve output yaşam döngüsünü sahiplenir. CoreBluetooth kuyruğu
üzerinden seri çalışır. UUID kimlik doğrulaması değildir; macOS/peripheral eşleştirmesi
aynen korunur. İşletim sisteminin Bluetooth ayarları değiştirilmez.

Kontrol soketi JSON `{"command":"scan"}` ve `{"command":"connect","uuid":"…"}`
komutlarını kabul eder. Aktif bağlantı varken başka bağlantı/tarama reddedilir.
Keşif `discovered {uuid,name,rssi?,time_unix}` olaylarıyla gelir; tekrar reklamlar cihaz
başına saniyede en çok bir kez yayımlanır. `scanning {browsing:true}` yeni listeyi açar;
45 saniye sonra `scan_complete` gelir ve süreç `idle` olarak seçimi bekler. `scan`
yeniden başlatabilir. Bağlantı denemesinde ayrı 45 saniyelik süre yeniden kurulur.
Kayıtlı UUID'de `retrievePeripheralsWithIdentifiers` sonucu fiziksel yakınlık sayılmaz.

Python ve native uygulama yalnız süreç sahipliği/olay aktarımı yapar; `status.devices`
keşif listesidir, `status.uuid/device/input_capable/output_capable` mevcut bağlantıdır.
HTTP `POST /api/bluetooth/scan`, `POST /api/bluetooth/connect {uuid}` ve `disconnect`
aynı sözleşmeyi sunar. Geçersiz UUID ve aşırı istek boyutu bağlantı başlatmadan reddedilir.

Cihaz tercihlerinin tek sahibi mevcut `WorkspaceState` içindeki `bluetooth` bölümüdür:
`{version:1, devices:{UUID:{name,originalName,channel,auto}}, defaultUUID, migrated}`.
Tarayıcı ile paketlenmiş arayüz aynı JavaScript'i kullanır; kendi çalışma alanları ayrıdır.
Eski tek CLP UUID kaydı `remembered_device` üzerinden bir kez içeri alınır; yeni bağlantılar
eski host tercihini yazmaz. Yeni kayıt yalnız başarılı MIDI aboneliğinden sonra oluşur.
Tek cihaz için 1–16 kanaldan biri kullanılır; native sender 16 kanalın tamamında sahip
olduğu notaları takip eder ve durdurmada bırakır. Program change/SysEx gönderilmez.

Otomatik bağlantı ve sınırlı yeniden deneme frontend oturumu tarafından kullanıcı
tercihine göre talep edilir. Native hostun bağımsız yeniden bağlanma döngüsü yoktur.
Sayfa yoksa Python mevcut beş saniyelik istemci gözetimiyle sahibi olduğu süreci kapatır;
native uygulama kapanışı aynı temiz bağlantı kesme yolunu kullanır. Radyo kaybında
nota bırakmanın teslim edilmesi garanti edilemez; yeniden bağlantı müziği başlatmaz.

Üretici belgelerine göre uyumluluk adayları: Yamaha CLP-835/P-525; Roland FP-10/FP-30X;
Kawai ES120/CN201/CA401; WU-BT10 ile Casio PX-S1100/S3100/S5000/S6000/S7000 ve
AP-S200/AP-300/AP-S450/AP-550/AP-750. Bu liste cihaz test sertifikası değildir ve
bağlantıda izin listesi olarak kullanılmaz. Yalnız Bluetooth Audio sunan cihazlar
bu transport ile tuş verisi sağlayamaz. USB MIDI bu değişikliğin kapsamına dahil değildir.
