# Ders motoru

## MIDI ve PDF içe aktarma

MIDI yolu `midi_score.py`'dir. Ders, kaynak dosyanın zamanlamasını, velocity ve CC64
verisini olduğu gibi çalar. Nota yazımı saniyelerden değil MIDI vuruş ızgarasından
(tick) okunur: tempo haritası yalnız ölçülerin ne zaman çalacağını belirler, her
tempo değişimi partisyona yazılmaz. Ölçü, anahtar ve tempo sözcüğü (ör. "Adagio
sostenuto") dosyadan alınır; anahtar yoksa notalardan kestirilir. Notalar beşliler
çizgisinde anahtara ve çevresine göre adlandırılır (Si♯, Fa𝄪). Her parçanın sesleri
ayrı tutulur (melodi ve eşlik tek portede iki ses), sesler okunması kolay porteye
geçebilir ve bas anahtarı gereken ölçülerde üst porte bas anahtarı alır.

El ayrımı: adı bir eli söyleyen parça ("Piano right", "left", "RH", "sağ") o eldir.
Öteki notalar çalınabilirliğe göre ellere dağıtılır: bir el, tuttuğu ve bastığı
notalarda onluyu aşmaz, eller çaprazlanmaz, bir figür aynı elde kalır. Porte adlı
parçalar ("up"/"down") yalnız ipucudur; baskıda alt portede yazılan sağ el notaları
sağ elde kalır. Bu yol Rubato çalıştırmaz.

PDF yolu Java gerektirmez: PDFium sayfaları rasterleştirir, homr 0.7.0 ONNX
modelleri MusicXML üretir, music21 sayfaları birleştirir ve çalma verisini çıkarır.
Modelin notaları elle düzeltilmez. Bu motor pedal işaretlerini desteklemez;
ölçü taşmaları saptanırsa sonuç açıkça güvenilmez olarak işaretlenir. Tanınan sesler korunur; yeniden ses icadı için
`makeNotation` uygulanmaz. OMR yanlış nota/süre üretebilir; PDF dersleri arayüzde
açıkça otomatik okuma olarak etiketlenir. Sayısal tempo bulunmadığında kullanıcının
seçtiği tempo (başlangıçta 60 BPM) uygulanır ve ders açıklamasında belirtilir.

PDF araçları yalnız PDF seçilip ders oluşturulduğunda indirilir. Model URL, boyut
ve SHA-256 değerleri `tool-models.json` içinde; tüm bağımlılıkların sabitlenmiş
kataloğu `tools.json` içindedir. `tools/prepare_omr.py` yalnız geliştirme ortamını
hazırlamak içindir; uygulama dağıtımı bu ortamı paketlemez.

## Çalışma durumunun sahipliği

`workspace-state.js` arayüz tercihlerinin tek kalıcılık sahibidir. Ayarlar, seçili
ders, ders başına konum/el/sayfa/kaydırma, bölme boyutları ve oluşturma taslağı
yerel depolamada tutulur. Çalma otomatik başlamaz, Bluetooth otomatik bağlanmaz.
Tarayıcı ve uygulama ayrı depolama kullanır. Native uygulama kalıcı WKWebView veri
deposunu ve NSWindow frame autosave'i kullanır; çıkıştan önce JS durumu kaydedilir.
Dosya seçicinin File nesnesi yeniden açılışta geri yüklenmez; dosya yeniden seçilir.

Native uygulama ve tarayıcı geliştirmesi aynı `desktop/LessonService.m` üzerinden
tek iş yönetir. Servis videoyu Jobs/UUID içine alır, özel Python sürecini başlatır,
JSON ilerleme olaylarını iletir ve süreç çıktıktan sonra sonucu yayımlar.
`worker.py` yalnızca bir işi işler; native sahip kapanınca süreç grubu kapanır.
İptal/çıkış geçici dosyaları kaldırır; sonraki açılış sahipsiz işleri temizler.

Akış: FFmpeg → isteğe bağlı Mel-Band-Roformer vokal ayrımı → Rubato score
(40 saniye pencere, 20 saniye başlangıç sahipliği) → Rubato MIDI şiddet/CC64 →
otomatik MusicXML partisyonu → Lessons/UUID.json. Modelin resmi parser düzeltmeleri provenance içinde tutulur.
Manuel nota/süre düzeltmesi ve görsel referans yoktur. Şiddetler aynı perde ve
en fazla 150 ms başlangıç farkıyla bire bir eşleştirilir; eşleşmeyen notada 80/127
kullanılır ve sayısı açıklamada belirtilir. Pedal ikilidir; fiziksel basınç değildir.

CPU dört thread ile sınırlıdır. Vokal ayırma MPS varsa kullanır; MPS süreç bütçesi
önerilen GPU belleğinin %20'sidir. Rubato CPU kullanır. Küçük Python çalışma ortamı ve işçi kaynakları app Resources/Engine içindedir.
Diğer araçlar kullanıcıya ait `Application Support/Rach3/Tools/1` altında saklanır.
Tarayıcı geliştirme servisi de aynı araç deposunu kullanır; geliştirme dersleri ve
işleri `Rach3Development` altında ayrı kalır. `LessonService` araç konumunu
başlatılırken alır; katalog durumu ve worker aynı konumu kullanır.
Python bytecode yazımı kapalıdır. Dersin geçici medya dosyaları Jobs dizinine aittir.

Uygulama öncesi geliştirme ortamındaki dosyaları çevrimdışı devralmak için
`python3 desktop/import_local_tools.py` kullanılır. Bu geliştirme aracı indirme
yapmaz: modelleri katalog SHA-256 değeriyle, kurulu Python paketlerini sürüm,
wheel etiketleri ve RECORD dosya hash'leriyle doğrular. Yerel aktarımın kaynağı ve
doğrulama yöntemi `local-import.json` içinde saklanır; doğrulanan dosyalar uygulama
deposuna kopyalanır, eski ortamlar değiştirilmez. Kurulu paket devralma, özgün
wheel arşivinin SHA-256 doğrulaması değildir. Araç uygulamayla dağıtılmaz.

## İhtiyaç anında indirme

`tools_manager.py` tek indirme/kurulum sahibidir; LessonService'in başlattığı worker
sürecinde çalışır. `lesson-tools` köprüsü aynı katalog ve tamamlanma işaretlerinden
arayüze hazır/eksik durumunu verir. Seçim yapmak indirme başlatmaz; kullanıcı
**İndir ve ders oluştur** ile başlatır. Ortak paketlerin boyutu bir kez sayılır.

- MIDI: nota yazım araçları.
- Video: nota yazım araçları, ses çözme ve Rubato; YouTube için ayrıca indirici.
- Vokal ayırma: yalnız seçiliyken ek paketler ve ayırma modeli.
- PDF: nota yazım araçları, homr/ONNX, PDFium ve başlık okuma modelleri.

Her dosya sabit HTTPS URL, boyut ve SHA-256 ile tanımlıdır. Wheel'ler PyPI'den,
modeller özgün proje dağıtımlarından alınır. TLS, uygulamadaki public CA bundle
ile doğrulanır. Çalışma anında sürüm çözümleme, kaynak derleme ve sistem kurulumu yoktur.
`pip --isolated --no-index --no-deps` yalnız doğrulanmış yerel wheel'i kurar.

İndirme gerçek byte sayısı/yüzde/hız ile bildirilir; doğrulama ve kurulum ayrı
fazlardır. `.part` dosyaları iptal/çıkışta kalır; sunucu Range destekliyorsa devam
edilir, desteklemiyorsa dosya baştan alınır. Hash uyuşmazlığında bozuk dosya silinir.
Kurulum staging dizininden atomik taşınır; `.ready` yalnız başarıdan sonra görünür.
İndirilen wheel/ZIP kurulumdan sonra silinir. Dosya kilidi aynı cache'e eşzamanlı
kurulumları engeller; süreç kapanınca kilit otomatik serbest kalır.

Paketler hash başına saklanır; PDF ayrı subprocess/PYTHONPATH kullanır, böylece
ses motoruyla farklı Pillow sürümleri karışmaz. Model profilleri büyük dosyalara
symlink verir. Güncelleme `.app` dosyasını değiştirir, bu cache'i değiştirmez.
Kaldırma menüsü uygulamaya ait cache'i ve dersleri de kaldırır.

## Paketleme ve katalog bakımı

`desktop/prepare_engine.py` yalnız Python 3.12.12'yi hazırlar. `desktop/build.py`
runtime, worker'lar, katalog, CA bundle ve küçük vendor kaynaklarını paketler;
ML paketlerini/model ağırlıklarını **paketlemez**. Mach-O dosyaları ad-hoc imzalanır.
Uygulama universal'dır: Apple Silicon `python`, Intel `python-x86_64` runtime'ını kullanır.
Dağıtım macOS 14+ içindir; Developer ID/notarization yoktur.

`desktop/lock_tools.py` sabit geliştirme ortamlarındaki metadata üzerinden
macOS 14 ARM64 ve x86_64 / CPython 3.12 wheel'lerini PyPI metadata'sından seçer; bağımlılık
kapanımlarını ve indirme boyut/hash'lerini `tools.json` (Apple Silicon) ve
`tools-x86_64.json` (Intel) içine yazar. Intel ortamlarını `desktop/prepare_intel_lock.py`
kurar: Apple Silicon kilit dosyalarından başlar, yalnız Intel wheel'i olmayan paketleri
(PyTorch 2.2.2, numpy 1.26 ve onlara bağlı birkaç paket) değiştirir. audio-separator ve
homr'un Intel'de karşılanamayan alt sınırları vardır; aynı sürümler bağımlılık
çözülmeden kurulur ve Intel uçtan uca testleriyle doğrulanır. diffq'nun vendor
`.so` dosyası iki mimarili tek binary'dir. Yalnız sürüm
bakımında separation ortamının Python'u ile çalıştırılır; uygulama build'inde
ve kullanıcı Mac'inde çalışmaz. `tool-models.json` model katalog girdisidir.

Rubato 0.3.0 kaynak revizyonu `325d90df334f7fe7e8e2c8c90a297c927e635dcc` ve
CPython 3.12 wheel'i olmayan diffq 0.2.4, küçük `vendor` dizininde lisanslarıyla
bulunur; model ağırlıkları içermez. Ayrıntılar `vendor/README.md` içindedir.
Diğer paketler indirildiklerinde `.dist-info` lisanslarıyla saklanır.

## Partisyon

`notation.py`, score pencerelerinin tam örtüşen ölçü, tonalite ve zaman kanıtını
`rhythm_window` ile toplar. `build_notation`, çevredeki vuruş süresiyle tutarlı
pencere yorumlarından ortak ritmik saat oluşturur; pencere başlangıcında önceki
ölçüyü kırpmaz. İlk tutarlı ölçü ve ilk eksik ölçü korunur. Sonraki ölçü değişimleri, en az iki
bağımsız pencerede nominal ölçü uzunluğu ve yeterli örtüşme desteği gerektirir;
çelişkili tek pencere önerileri `meterEvidence` içinde kaydedilir. Tek bir
yaklaşık başlangıç temposu yazılır; performansın rubato zamanlaması çalma verisinde
kalır ve her ölçü için yeni metronom talimatı sayılmaz.

Nota sayfası için 16'lık, kaynakta ince ritim varsa 32'lik ızgara kullanılır.
Üçleme yalnız kaynak ritimde üçleme kanıtı varsa seçilir. Aynı perdedeki yakın
tekrarlar aynı ızgaranın ayrı yuvalarına yerleştirilir; araya keyfi 64'lük eklenmez.
Bu, okunabilir bir otomatik ritmik yorumdur; özgün edisyonun kesin nota değerleri
elde edilmiş sayılmaz. Dersin perde, başlangıç, tuş bırakma, velocity, pedal ve
alıştırma eli verileri değiştirilmez.

`notation_source.py`, sabitlenmiş Rubato scanner'ın tekrar temizlerken sildiği
PL/PR bağlamını ham metnin açık el işaretlerinden geri kazanır. Yalnız belirsiz
olmayan kaynak zaman/perde eşleşmeleri aday olur. Bu düzeltmeler ancak
`provenance.model` Rubato olan ve `visualDataUsed=false` derslerin partisyonuna
uygulanır; görsel kaynaktan gelen el bilgisi korunur. Ham metnin SHA-256'sı ve
kurtarma sayıları `notation.sourceStaffRepairs` içinde kaydedilir. Kurulu Rubato
paketi değiştirilmez; kullanıcıya özgü elle nota düzeltmesi yapılmaz.

`score_writer.py`, music21 9.9.1 ile iki `PartStaff`, sabit ses kimlikleri ve
piyano `StaffGroup` oluşturur. Eş başlangıç ve bitişleri olan notalar akor olur;
çakışan bağımsız süreleri `makeVoices` ayırır. Ölçü sınırında
`splitByQuarterLengths` bağları üretir; `makeRests`, `splitAtDurations`,
`makeAccidentals`, `makeBeams` ve `makeTupletBrackets` standart nota yazımını
hazırlar. Hazırlanmış eser tek MusicXML olarak dışa aktarılır. Rubato'nun özel
engraver'ı, dört ölçülük parçalar birleştirme ve XML sembol düzeltmeleri kullanılmaz.
Tek sesli ölçülerde de ses kimliği korunur; böylece sonraki ölçüye uzanan bağ
başka sese taşınmaz. Etkin seslerin susları görünür, çok sesli bölümlerde üst ve
alt sesler karşıt sap yönleriyle gösterilir.

Her vuruş için tek ritmik ızgara seçilir. Kaynak üçleme desteği ve zamanların
belirgin daha iyi uyumu olduğunda üçleme ızgarası kullanılır. Düz/üçleme sınırını
aşan notalar bağlanır; bileşik üçleme süreleri music21 Duration/Tuplet nesneleriyle
3:2 olarak yazılır, serbest 48:29 gibi oranlar çıkarılmaz. Bu işlem gösterim
kuantizasyonudur; çalma verisini değiştirmez.

Anahtar seçimi bütün bölümün ek çizgi yükü ve değişim maliyetini birlikte
hesaplar. Nüans velocity medyanından, pedal birleşik CC64 durumundan türetilir;
music21 Dynamic ve PedalMark nesneleriyle yazılır. Verovio'nun desteklediği
standart çizgili pedal biçimi kullanılır. Basınç tahmini yoktur.

Bu motor değişimi transkripsiyonu doğrulamaz: yanlış tahmin edilmiş tuş bırakma
süresi, el veya ölçü yapısı ayrıca kaynak çözümleme problemidir. music21'in otomatik
ses ayırması da bir bestecinin ses yürüyüşü analizi değildir. Görsel dersten
notalar kopyalanarak ses dersinin hataları gizlenmez.

music21 ve bağımlılıkları `transcription/separation/requirements.lock.txt` içinde
sabittir; `tools.json` bunların doğrulanmış indirme kataloğudur.
Kullanıcıdan ayrı kurulum istenmez. `tools/update_notation.py --output-directory
build/notation-review/music21` yayınlamadan aday ders dosyaları üretir; seçenek
olmadan yerleşik Rubato Peace dersi ve kayıtlı Pervane dersleri yenilenir. Kaynak
ritim penceresi olmayan eski derslere uydurma partisyon eklenmez.

JSON `notation` alanında MusicXML, ölçülerin ders saniyeleri ve çeyrek nota
konumları/zaman eşleme noktaları bulunur. `sheet-music.js`, uygulamaya gömülü
Verovio motorunu ayrı bir Worker içinde başlatır; XML yerleşimi, zaman haritası ve
sayfa SVG'lerini orada üretir. Partisyon alanında motor hazırlığı ve tamamlanan
sayfa sayıları görünür. Ders değişimi veya sayfanın kapanması eski Worker'ı
sonlandırır; üretim bitince Worker serbest bırakılır. Hazır sayfalar bellekte tutulur.
Tarayıcıda aynı yerel kaynak sunucudan okunur, uygulamada metin olarak gömülüdür;
internet veya kullanıcının paket kurması gerekmez.

SVG nota kimlikleri dersin zaman eşleme noktalarıyla eşlenir. Sayfa, zaman çizgisi
ve renkler yalnız `player.js` saatinden güncellenir; ayrı çalma zamanlayıcısı yoktur.
Derste partisyon oluşturulamadığında `notationError`, istemci çizimi başarısızsa
çizim hatası partisyon alanında gösterilir. Lisans ve sürüm `assets/notation` altındadır.
