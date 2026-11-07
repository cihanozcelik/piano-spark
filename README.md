# Piano Spark

Fiziksel piyanoyla, kendi hızında çalışmaya odaklanan masaüstü eğitim uygulaması.
Küçük, bağımsız uygulama paketi **Apple Silicon, macOS 14 veya sonrası** içindir.

## Uygulama ve paylaşım

**`dist/PianoSpark-Setup.dmg`** kurulum dosyasıdır. İçindeki **Piano Spark Installer**,
uygulamayı `~/Applications/Piano Spark.app` konumuna kurar. Güncellemede uygulamayı
kapatır ve kayıtlı dersleri korur. Kullanıcı Python, Rubato veya başka paket kurmaz;
küçük portable Python uygulamaya dahildir. Nota çıkarma, vokal ayırma ve PDF
araçları ilk kullanımda indirilir. Gereken boyut ilgili seçeneğin yanında görünür;
ilerleme, indirilen/toplam boyut ve hız gösterilir. İptal indirmeleri korur.
İndirilen araçlarla yerel dosyalar çevrimdışı işlenir; YouTube için internet gerekir.
Sistem Python'u, Homebrew, başlangıç öğesi veya sistem servisi kurulmaz.

**Piano Spark → Piano Spark’ı kaldır…**, onaydan sonra çalışan işlerini durdurur;
uygulamayı, indirilen araçları, `~/Library/Application Support/PianoMan/`,
uygulama tercihlerini, WebKit/önbellek ve pencere durumunu siler. Kayıtlı dersler de
silinir. Orijinal videolar, dışarı aktarılan MIDI'ler ve indirilen DMG kullanıcı
belgeleridir; korunur. Yalnızca uygulamayı Finder'dan silmek kayıtlı dersleri
silmez. Geliştirme deposu ve ayrı geliştirme verileri kaldırmaya dahil değildir.

Tam ekran için **Tam ekran** düğmesi, pencerenin yeşil düğmesi veya **Ctrl+⌘+F**
kullanılır. Piyano ve akan notalar pencerenin tüm genişliğini kullanır;
tam ekranda da sağda ve solda dış boşluk bırakılmaz.
`Pianoman.command` da derlenmiş uygulamayı açar.

Paket yerel (ad-hoc) imzalıdır; Developer ID ile imzalanmış/noterlenmiş değildir.
İnternetten alınan kopyanın ilk açılışında macOS güvenlik onayı gerekebilir.
Bu, paylaşım paketinin mevcut dağıtım sınırlamasıdır.

## Otomatik güncellemeler

Uygulama yeni sürümü küçük imzalı ZIP veya uygun olduğunda delta olarak indirir;
araçlar Application Support altında tutulur ve uygulama güncellemesinde tekrar indirilmez. Üst çubuktaki güncelleme lambası
yeni sürümü ve değişikliklerini gösterir. Paket doğrulanınca ders sürse de çalışma
konumunu kaydedip otomatik yeniden açılır. Devam eden dönüştürme işi iptal edilir.
Yeni sürüm yüklendi bildirimi ve sürüm notları üst çubukta kalır. İndirme ve güncelleme
için GitHub hesabı veya erişim anahtarı gerekmez.
Yayın, imzalama ve ilk kurulum: [Güncelleme sistemi](desktop/UPDATES.md).

## Kaynaktan paketleme

Geliştirici bilgisayarında Python 3 ve Xcode Command Line Tools gerekir.
Önce `python3 desktop/prepare_engine.py` küçük Python ortamını hazırlar (uv gerekir).
`./build-app.command` native uygulamayı ve bu ortamı paketler, ad-hoc imzalar ve `dist/PianoSpark-Setup.dmg` üretir.
`python3 desktop/build.py --app-only` yalnızca uygulamayı;
`--installer-only` mevcut uygulamadan kurulum dosyasını üretir.
Paketleme girdileri ve motor yaşam döngüsü `lesson-engine/README.md` içindedir.
`build/` ve `dist/` üretilen dosyalardır ve Git dışında tutulur.
Günlük arayüz geliştirmesinde paketleme gerekmez; aşağıdaki tarayıcı akışı kullanılır.

## Dil seçimi

Üst çubuktaki **English / Türkçe** seçimi çalışma ekranını, ders oluşturmayı,
uygulama menülerini ve durum mesajlarını anında değiştirir; açık ders ve konumu
korunur. Masaüstünde tercih native uygulama ayarlarında, tarayıcıda yerel depolamada
saklanır. Ders adları ve kullanıcı içeriği çevrilmez. macOS ve Sparkle’ın kendi
sistem pencereleri işletim sistemi dilini kullanır. Web sitesi ekran görüntüleri
izole yakalama sürümünde İngilizce arayüzden alınır.

## Uygulamanın yapısı

**Görünüm → Dinleme sesi** ile **Uygulama sentezleyicisi** veya
**Yamaha CLP · Bluetooth** seçilir. CLP çıkışı, mevcut piyano bağlantısından MIDI
nota/şiddet/sustain gönderir; uygulamanın sentezleyicisi aynı anda çalmaz. Ses düzeyi
piyanodan ayarlanır. Bağlantı hazır değilse Dinle açıklayıcı hata verir; kendiliğinden
başka çıkışa geçmez. Seçim kalıcıdır. Çıkış değişimi çalmayı durdurur; hız ve sarma
nota/pedal kuyruğunu yeni konumdan kurar. Çalış modunun fiziksel tuş girişi değişmez.
Tarayıcı ve `.app` aynı yerel BLE göndericisini kullanır; kullanıcıya ek paket gerekmez.

Kayıtlı derslerin yanındaki **Sil**, dersi ve uygulamanın kaynak kopyasını kaldırır;
özgün dosya korunur. **Create a Lesson → MIDI / PDF** veya ders menüsündeki
**MIDI / Nota PDF’si içe aktar…** ile dosyalar kalıcı ders olarak eklenir.
MIDI zamanlama/şiddet/CC64 verisini doğrudan korur. PDF okuma homr/ONNX ile
Java kullanmadan yapılır, ilerleme ve iptal desteklenir. Bu yol deneyseldir:
pedal sembollerini aktaramaz, nota ve ritim hataları üretebilir; saptanan ritim
tutarsızlıkları partisyon durumunda açıkça gösterilir. Sayısal tempo yoksa seçilen
tempo kullanılır. Örnekler ve lisanslar `assets/example-lessons/README.md` içindedir.

Ayarlar, seçili ders ve konumu, partisyon sayfası, yatay kaydırma ve panel boyutları
saklanır. Masaüstü pencere boyutu/konumu da korunur. Açılışta otomatik çalma veya
Bluetooth bağlantısı başlatılmaz. Tarayıcı ve masaüstü kendi durumlarını ayrı tutar.
PDF motorunun geliştirme girdilerini hazırlamak için `python3 tools/prepare_omr.py`
kullanılır; son kullanıcı bu adımı çalıştırmaz.

**Çalış** sekmesinde tek ders başlığı, kısa oynatma araç çubuğu ve pencerenin
kalanını kullanan nota alanı/klavye bulunur. Sol el mavi, sağ el mercandır.
Bluetooth ayrıntıları üst çubuktaki piyano kontrolünde; nota görünümü, yakınlık,
tekrar ve dinleme ses düzeyi **Görünüm** panelindedir. Ders başlığının yanındaki
menüden dosya içe aktarılır, kayıtlı dersler veya yerleşik
**A Small Measure of Peace · Rubato** seçilir. Dersin MIDI'sini indirme seçili dersi aktarır.
Video ve Transkun V2 sürümleri ders menüsünden ve uygulama paketinden kaldırılmıştır.
Önceki seçim bu derslerden biriyse açılışta Rubato seçilir.

Uygulama şu anda inceleme için **Rubato** dersi seçili açılır. Bu deneysel ders,
Rubato'nun sesten ürettiği nota modunun örtüşen 40 saniyelik çözümlemesinden gelen
636 notayı içerir. Süreler değiştirilmez; yalnızca ilk model notasından önceki
5.64 saniyelik boşluk çıkarılır. Sol/sağ el modelin PL/PR partilerinden gelir;
görsel dersten bilgi alınmaz. Aynı sesin Rubato MIDI çıktısındaki note-on olayları,
perde ve en fazla 150 ms başlangıç farkıyla bire bir eşleştirilerek 636 notanın
tamamına şiddet eklenir (38–84). Sustain aynı çıktının CC64 olaylarından gelir;
model neredeyse tüm parçada basılı tahmin ettiği için bu bilgi doğrulanmış pedal
hareketi olarak sunulmaz. Kabul edilen ilk
derse göre 129 notada 250 ms'den büyük süre hatası kaldığı için sonuç deneme
olarak etiketlidir. Veriyi yeniden gömmek için
`transcription/rubato/.venv/bin/python transcription/rubato/embed_lesson.py`,
ardından paketleme çalıştırılır.
İşitsel/görsel kabul testlerini kullanıcı yapar.

Üst çubukta çalma kontrolleri ortalanır; uygulama sekmeleri ve ders seçimi solda,
Bluetooth sağdadır. Sayfa kontrolleri partisyon alanının sağ üstünde, Görünüm
düğmesi piyano alanının sağ üstünde yüzer; alan kaydırılırken konumları korunur. Partisyon/akan notalar ve akan notalar/klavye arasındaki
iki yatay ayırıcı sürüklenerek alanların yüksekliği değiştirilir. Ayırıcılar
klavyeyle de kullanılabilir; boyutlar bu tarayıcıda/uygulamada saklanır. Pencere
küçüldüğünde alanlar mevcut yüksekliğe sığdırılır. Yerleşimin sahibi
`app-shell.js`, boyut değişimlerini izleyen çizicinin sahibi `player.js` olur.

Sustain pedalı klavyenin sağında bitişik mor bir şerittir. Basılı tutulacak
aralıklar nota çubuklarıyla aynı altı saniyelik görünümde yukarıdan aşağı iner;
klavye hizasındaki pedal simgesi BASILI / BIRAKILMIŞ durumunu gösterir. Şerit
seçili partilerin CC64 aralıklarını birleştirir; sarma, hız değişimi ve alıştırma
beklemesinde aynı ders saatini kullanır. Yatay pedal zaman çizelgesi yoktur.
Nota alanının üstünde hafif dokulu beyaz kâğıt üzerinde siyah klasik piyano
partisyonu bulunur. Sol/fa anahtarı, ölçüler, ritmik nota değerleri, suslar, bağlar,
nüans ve sustain işaretleri music21 ile MusicXML'e yazılır, Verovio ile çizilir. Sayfa düğmeleri ve
Büyüt seçeneği partisyonu okumayı sağlar. Çalma sırasında kırmızı zaman çizgisi iki
dizeği kapsar, etkin notalar renklendirilir ve görünüm mevcut sisteme geçer.
Çizgi ve renkler oynatıcının saatinden türetilir; alıştırma beklerken durur,
sarmayla güncellenir. Çalma durduğunda sayfalar elle incelenebilir. İlk açılışta
partisyon alanında motor hazırlığı, zaman eşleme ve çizilen sayfa sayısı görünür.
Nota yazımı ayrı bir Worker üzerinde çalışır; ders değişince eski iş sonlandırılır.

Dinle/Başlat, başa dön ve hız kontrolleri zaman çizgisinin solundadır; mod ve el
seçimi üst çubuğun ortasında kalır. Açılır menüler aynı metin ve ok hizasını kullanır.

Ölçü/ritim/tonalite Rubato tahminidir; şiddetlerden nüans, CC64'ten pedal yazılır.
Örtüşen kaynak pencereleri ortak ritmik saatte birleştirilir; ölçü değişimleri
bağımsız pencerelerin uyuşmasını gerektirir. Yalnız başlangıçta
yaklaşık tempo verilir. Mikro zaman farkları okunabilir 16'lık/32'lik değerlere
yansıtılır; kaynakta olmayan üçlemeler sırf hassas zamanlama için üretilmez.
Ham Rubato metninde kanıtlanan el işareti kayıpları yalnız Rubato dersinin nota
sayfasında otomatik düzeltilir; görsel dersin el bilgisi korunur.
Standart yazım motoru, modelin yanlış tahmin ettiği nota süresini veya eli kendiliğinden
düzeltmez. Bu, doğrulanmış basılı edisyon değildir. Nota yazımı için ritmik ızgaraya yansıtma
oynatıcının gerçek nota başlangıç/bırakma zamanlarını değiştirmez. Mevcut Peace
dersleri saklanan Peace Rubato ölçüleriyle, mevcut Pervane dersi saklanan ham ses
Rubato ölçüleriyle yazılır; Pervane'nin kabul edilmiş ayrıştırılmış ses notaları
korunur. Yeni video dersleri kendi çözümlemelerinin ölçülerini kullanır.
`transcription/separation/.venv/bin/python tools/update_notation.py` mevcut
partisyonları kaynak pencerelerden yeniden üretir. Partisyon içermeyen eski dersler
nota çubuklarıyla çalışır; uydurma partisyon
sunulmaz. Görünüm menüsünde tutulan/sıradaki notaların şiddetleri (1–127),
nota çubuklarında küçük şiddet göstergeleri bulunur.
Bu bilgiler Çalış modunda isteğe bağlıdır: şiddet/pedal farklılığı alıştırmayı
durdurmaz. Dinle modunda şiddet ses düzeyini ve tını parlaklığını, sustain ise
tuş bırakıldıktan sonra sesin sönümlenmeden sürmesini etkiler. Tellerin doğal
azalması devam eder; duyulmaz hale gelen sesler pedal basılı olsa da kapatılır.
Sarma, duraklatma ve parti değişimi aynı nota/pedal zaman çizgisini kullanır.
Dersin MIDI indirmesi, özgün tuş bırakma süreleriyle birlikte şiddetleri ve her
elin kanalındaki CC64 mesajlarını içerir. İçe aktarılan MIDI'lerde de seçilen
kanalların sustain bilgisi gösterilir ve Dinle modunda uygulanır.

**Create a Lesson**, yerel video veya YouTube bağlantısından yeni ders oluşturur.
Başlık ve isteğe bağlı vokal ayırma seçildikten sonra **Ders oluştur** ile işlem
başlar. İlerleme ve iptal aynı ekrandadır. Sonuç kalıcı ders kütüphanesine kaydolur;
hem bu sekmeden hem ders başlığının yanındaki menüden açılabilir.
Vokal ayırma eşlikteki diğer çalgıları da bırakır; çıkan notalar piyano transkripsiyon
modelinin tahminidir. Görsel referans veya elle süre düzeltmesi kullanılmaz.
Şiddet ve pedal tahminleri Dinle modunu etkiler, alıştırmada zorunlu değildir.
Şiddet eşleşmeyen notaların sayısı ders açıklamasında belirtilir.

`app-shell.js` sekmelerin ve açılır araç panellerinin sahibidir.
`create-lesson.js` seçilen videonun bellekteki dosyasını, önizleme URL'sini ve
YouTube bağlantısı taslağını yönetir. Çalış sekmesinden çıkış oynatmayı durdurur;
ders konumu, ayarlar ve Bluetooth bağlantısı korunur. Create sekmesinden çıkış
video önizlemesini duraklatır. Gizli çalışma alanı ölçülmez/çizilmez; dönüşte
yeniden boyutlandırılır. Kısayollar ve MIDI sürükleme yalnızca Çalış'ta etkindir.

`desktop/main.m`, AppKit penceresi ve WKWebView'ın sahibidir. `desktop/build.py`
oynatıcının JavaScript modüllerini ve gömülü nota verisini tek çevrimdışı HTML
kaynağında birleştirir. Ses ve animasyon WebKit içinde çalışır. `LessonService` tek çözümleme işini yönetir;
`lesson-engine/worker.py` paketlenmiş Python ile ayrı süreçte modelleri çalıştırır.
Dosya açma/kaydetme ve tam ekran native pencereyle bütünleşir.
Yerel dosyalar ve içe aktarılan notalar dışarı gönderilmez.

Bluetooth süreç sahibi native uygulamadır. Aynı çalıştırılabilir dosyanın özel
`--bluetooth` giriş noktası mevcut CoreBluetooth uygulamasını çalıştırır;
ayrı kurulum, derleyici veya Python aracı kullanılmaz. JSON olayları uygulama
üzerinden sayfadaki giriş arayüzüne iletilir. Native çalışma verileri
`~/Library/Application Support/PianoMan/Bluetooth/` altında, son başarılı cihaz
kimliği uygulama tercihlerinde saklanır; nota akışı kaydedilmez.

## Bluetooth bağlantısı

Üstteki piyano kontrolünün içindeki **Bağlan** düğmesi Yamaha CLP-835 bağlantısını başlatır.
İlk kullanımda macOS Bluetooth izni isteyebilir. Piyano açık, Bluetooth etkin
ve menzilde olmalıdır. Başarı, MIDI bildirim aboneliği doğrulandıktan sonra
gösterilir. Panel son nota, basış şiddeti, basış sayısı ve sustain durumunu gösterir.
Tek giriş fiziksel Bluetooth piyanodur; fiziksel piyano sesi tekrar üretilmez.
Panel Dinle modunda da görünür.

**Bağlantıyı kes**, **Vazgeç** ve uygulamadan çıkış, uygulamanın başlattığı
Bluetooth sürecinin temiz kapanışını ister. Normal çıkış bağlantının kapanmasını
bekler. WebKit süreci kapanırsa Bluetooth durdurulur ve arayüz yeniden yüklenir.
Uygulama süreci beklenmedik şekilde kapanırsa yardımcı süreç de kapanış ister;
zorla öldürmede işletim sistemi seviyesinde temiz kapanış garantisi yoktur.
Başka uygulamaların Bluetooth süreçleri devralınmaz veya kapatılmaz.

## Tarayıcıda hızlı geliştirme

`./dev.command` veya `python3 server.py --dev --open --port 8784`,
<http://127.0.0.1:8784> adresini açar. HTML/JS ve font değişiklikleri yaklaşık
bir saniyede sayfayı yeniler; uygulama veya modeller yeniden paketlenmez.
Yenileme oynatma konumunu ve henüz gönderilmemiş kaynak seçimini sıfırlar.
Video aktarımı sırasında yenileme bekler; başlamış çözümleme ve Bluetooth
bağlantısı sayfa yenilenirken devam eder.

Tarayıcı da gerçek ders oluşturma, kayıtlı dersler ve Bluetooth arayüzünü kullanır.
`/api/lessons/command` yalnızca yerel HTTP taşımasıdır: native uygulamanın aynı
`LessonService.m` sahibi küçük `LessonHost` sürecinde çalışır. Model kodu tek
`lesson-engine/worker.py` dosyasıdır. Motor bağlantıları `build/browser/Engine/`
altındadır; mevcut yerel Python/paket/model dosyaları yeniden kopyalanmaz.
Geliştirme dersleri `~/Library/Application Support/PianoManDevelopment/` içindedir;
kurulu uygulamanın derslerine yazılmaz.

LessonService/Host değişince küçük yardımcı süreç boşta yeniden derlenir; devam
eden çözümleme bitmeden değiştirilmez. Worker değişikliği sonraki derste kullanılır.
`server.py` değişiklikleri servisin yeniden başlatılmasını, native pencere/menü ve
kurulum değişiklikleri ise uygulama derlemesini gerektirir. Ctrl+C/SIGTERM geliştirme
servisini, sahip olduğu çözümlemeyi ve Bluetooth bağlantısını kapatır.
`python3 server.py --open` otomatik yenilemesiz akışı 8783 portunda açar.

Bu akışta Bluetooth süreç sahibi Python `BluetoothBridge` sınıfıdır. Native
JSON olayları `/api/bluetooth/events` SSE akışından gelir; durum
`/api/bluetooth/status`, komutlar POST `/api/bluetooth/connect` ve
`/api/bluetooth/disconnect` üzerindendir. Komutlar aynı yerel kaynaktan JSON ve
`X-PianoMan: 1` başlığıyla kabul edilir. Servis loopback üzerinde dinler;
farklı Host/Origin reddedilir ve CORS açılmaz. Son canlı sayfa bağlantısı
kaybolduktan sonra beş saniye beklenip Bluetooth kapatılır. Sayfa yenileme ve
başka açık sekmeler bağlantıyı korur. Son cihaz `.runtime/last-device.json`
içinde saklanır. Akış yeniden açıldığında durum ve basılı tuşlar tekrar iletilir.

## Alıştırma

**Çubuklarda porte** seçeneği varsayılan olarak açıktır. Akan her notada beş çizgili küçük
porte, sol/fa anahtarı, nota başı, gerektiğinde ek çizgiler ve diyez görünür.
Do4 altı fa, Do4 ve üstü sol anahtarında yazılır; en uç oktavlar açıkça
`8vb`, `8va` veya `15ma` ile gösterilir. Siyah tuşlar mevcut nota adlarıyla
uyumlu olarak diyezle yazılır; kaynak tonalite/enarmonik yazım bilgisi içermez.
Nota adları seçimi porteden bağımsızdır. **Yakınlık** ile görünüm büyütülebilir;
büyütülen klavye yatay kaydırılır.

Bu görünüm perde okumaya yöneliktir. Video aktarımında ölçü, vuruş ve nota
değeri bilgisi bulunmadığından dörtlük/sekizlik gibi ritmik değerler tahmin
edilmez; gövdesiz nota başı perdeyi, çubuğun uzunluğu gerçek tutma süresini
gösterir. Aynı gösterim içe aktarılan MIDI dosyalarında da kullanılır.
Bravura müzik yazı tipi ve OFL lisansı uygulamaya gömülüdür;
semboller için internet veya sistemde kurulu bir müzik fontu gerekmez.

Varsayılan **Çalış** modu, seçilen partinin fiziksel tuş
basışlarını takip eder. Nota çizgiye geldiğinde akorun tüm tuşları doğru
olana kadar zaman durur. Eksik/yanlış tuş veya bırakma toleransının aşılması
akışı durdurur. Doğru durum geri geldiğinde
kalan süre devam eder; beklerken geçen gerçek süre parça süresine eklenmez.
Aynı notanın yeni basışı için tekrar note-on gerekir. Üst üste binen aynı
perdedeki notalar, ortak fiziksel tuş tutulması olarak değerlendirilir.

Yaklaşan notalarda 150 ms gerçek zamanlık erken basış payı vardır. Doğru
basılmış tuşu 100 ms erken bırakmak veya bitişinden sonra 100 ms daha tutmak
akışı durdurmaz; bu pay seçilen çalma hızına göre nota zamanına çevrilir.
Kısa aralıkla tekrarlanan notaya hazırlık için bu son 100 ms içinde yapılan
yeni basış, yaklaşan tekrar için geçerli kalır. Hiç basılmayan nota bu payla
atlanmaz; aynı notayı sürekli tutmak yeni basış yerine geçmez. Geciken
basışlarda zaman bekler. Akorun bir parçası doğru basıldıktan sonra diğer
tuşu beklemek, o basışın geçerliliğini kaybettirmez. Süreler seçilen hıza
göre ilerler. Pedal tuşu basılı tutmanın yerine geçmez; alıştırma `end`,
otomatik dinleme ise pedal uygulanmış `soundEnd` alanını kullanır.

**Dinle** modu önceki otomatik çalmayı korur. Alıştırmada otomatik eşlik
çalmaz; fiziksel piyanonun sesi yeniden sentezlenmez. Mavi çerçeve hedef tuşları, renkli dolgu basılı tuşları,
kırmızı dolgu yanlış/fazla tuşları gösterir.

Alttaki klavye yalnızca fiziksel tuşları ve hedef notaları gösterir; fare,
dokunmatik veya bilgisayar klavyesiyle nota girişi yoktur. Uygulama odağı kaybolunca
oynatma duraklar. Mod değişimi duraklatır; sarma ve parti değişiminde hedef notalar
yeniden hazırlanır. Görünümün boyutlandırılması fiziksel basılı tuşları sıfırlamaz.

## Nota giriş arayüzü

`piano-input.js` kaynak başına basılı tuşları ve yeni basış kimliklerini tutar.
`practice-clock.js` Bluetooth kaynağının durumunu kullanır ve alıştırma
zamanının tek sahibidir. `player.js` görünümü ve sesi bu duruma bağlar.
Ekran klavyesi giriş kaynağı yoktur.

`bluetooth-connection/bluetooth.js`, `window.pianomanInput` arayüzünü kullanır.
Arayüz hazır olduğunda `pianoman-input-ready` olayı yayımlanır. Bu bir
bağlantı simülasyonu değildir; adaptör gerçek bağlantı durumunu bildirmelidir:

```js
// Native araç gerçekten hazır olduğunda:
window.pianomanInput.connect('bluetooth', 'Yamaha CLP-835');
// Native JSON satırı çözüldüğünde:
window.pianomanInput.receive({event: 'note_on', note: 60, velocity: 82, channel: 1});
window.pianomanInput.receive({event: 'note_off', note: 60, velocity: 0, channel: 1});
// Akış kesildiğinde veya bağlantı sonlandığında:
window.pianomanInput.disconnect('bluetooth');
```

`receive` ayrıca `ready`, `disconnected`, `stopped`, `error` ve
`all_notes_off` olaylarını kabul eder. `note_on` velocity=0 bırakmadır.
`input_id`, `group` ve `channel` tuş kimliğini ayırır; note-off aynı kimlikle
gelmelidir. Pedal ve diğer olaylar şimdilik değerlendirmeye alınmaz.
Kaynak bağlantısızken gelen notalar kabul edilmez. Yeniden bağlantı eski
basılı tuşları temizler. `reset(source)` bağlantıyı koruyarak notaları temizler.
Native zaman damgaları alıştırma saatini değiştirmez; girişlerin yerel
varış sırası ve monoton tarayıcı saati kullanılır.

Native araçta gerçek tuş/pedal alımı ve piyanoya dokunmadan yeniden bağlantı
daha önce doğrulandı. Standalone uygulamanın gerçek piyano ile uçtan uca etkileşim
testlerini kullanıcı yapar. Bu değişiklik otomatik test eklemez.

## Tanıtım ve indirme

https://cihanozcelik.github.io/piano-spark/

`site/` tanıtım kaynağı, `.github/workflows/pages.yml` Pages yayın akışıdır.
İndirme bağlantısı en son yayımlanmış sürümü gösterir.

Native product screenshots: `python3 desktop/build.py --capture-assets site/assets` builds a development-only capture executable, exports the actual application renderer using an isolated WebKit store and preferences, then removes that executable. No personal lessons or workspace state are used.

## Public website

The English GitHub Pages website lives in `site/`. `site/build.py` builds only the
explicit public asset list into `build/site`; download buttons use an actual
published release asset. The real application screenshots can be refreshed with
`python3 desktop/build.py --capture-assets site/assets`. This uses an isolated,
development-only capture build and does not alter the user’s library or preferences.
Generated artwork provenance is recorded in `site/IMAGEGEN.md`.
