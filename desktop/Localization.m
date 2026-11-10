#import "Localization.h"

NSString *PianoLanguage(void) {
    NSString *saved = [NSUserDefaults.standardUserDefaults stringForKey:@"Rach3Language"];
    if ([saved isEqual:@"en"] || [saved isEqual:@"tr"]) return saved;
    return [NSLocale.preferredLanguages.firstObject.lowercaseString hasPrefix:@"tr"] ? @"tr" : @"en";
}

void PianoSetLanguage(NSString *language) {
    [NSUserDefaults.standardUserDefaults setObject:language forKey:@"Rach3Language"];
}

NSString *PianoText(NSString *text) {
    if (!text) return nil;
    static NSDictionary<NSString *, NSString *> *english;
    static NSDictionary<NSString *, NSString *> *turkish;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        english = @{
            @"MIDI bağlantısı hazır":@"MIDI connection ready",
            @"Tarama tamamlandı. Listeden bir piyano seç veya yeniden tara.":@"Scan complete. Select a piano or scan again.",
            @"Seçilen piyanoya bağlanılıyor…":@"Connecting to the selected piano…",
            @"Yakındaki Bluetooth MIDI cihazları aranıyor…":@"Scanning for nearby Bluetooth MIDI devices…",
            @"Seçilen piyano aranıyor…":@"Looking for the selected piano…",
            @"Listeden bir MIDI cihazı seç.":@"Select a MIDI device from the list.",
            @"Önce mevcut bağlantıyı kes.":@"Disconnect the current device first.",
            @"Bağlantı kapanıyor; tamamlanmasını bekle.":@"The connection is closing; wait for it to finish.",
            @"Yeni tarama için önce mevcut bağlantıyı kes.":@"Disconnect the current device before scanning again.",
            @"Mac’in Bluetooth servisi hazır değil.":@"The Mac’s Bluetooth service is not ready.",
            @"Tamam":@"OK",
            @"Geçersiz çalma oturumu.":@"Invalid playback session.",
            @"Geçersiz MIDI çıkış komutu.":@"Invalid MIDI output command.",
            @"Önce mevcut piyano çalmasını durdur.":@"Stop the current piano playback first.",
            @"Bu bağlantıda MIDI gönderimi hazır değil.":@"MIDI output is not ready on this connection.",
            @"Ders MIDI çıkışı için çok büyük veya geçersiz.":@"The lesson is too large or invalid for MIDI output.",
            @"Geçersiz MIDI olayı.":@"Invalid MIDI event.",
            @"Geçersiz MIDI değeri.":@"Invalid MIDI value.",
            @"Desteklenmeyen MIDI olayı.":@"Unsupported MIDI event.",
            @"Çalma sayfasıyla iletişim kesildi; piyano çalması durduruldu.":@"Playback lost its connection to the app and was stopped.",
            @"Bluetooth MIDI gönderimi gecikti; çalma durduruldu.":@"Bluetooth MIDI output was delayed. Playback has stopped.",
            @"Piyano çalma komutuna yanıt alınamadı.":@"The piano did not respond to the playback command.",
            @"Nota bırakma gönderimi tamamlanmadan bağlantı kapanıyor.":@"The connection is closing before all note releases were sent.",
            @"Piyano bağlı değil":@"Piano not connected",
            @"Piyano bağlı değil.":@"Piano is not connected.",
            @"rach3 Hakkında":@"About rach3",
            @"Güncellemeleri denetle…":@"Check for Updates…",
            @"rach3’ü Gizle":@"Hide rach3",
            @"rach3’ü değiştir…":@"Customize rach3…",
            @"Orijinal tasarıma dön":@"Back to the Original Design",
            @"rach3’ü kaldır…":@"Uninstall rach3…",
            @"rach3’ten Çık":@"Quit rach3",
            @"Düzenle":@"Edit",
            @"Kopyala":@"Copy",
            @"Yapıştır":@"Paste",
            @"Tümünü Seç":@"Select All",
            @"Görünüm":@"View",
            @"Tam Ekran":@"Full Screen",
            @"Mac’in Bluetooth erişimi kontrol ediliyor… macOS izin sorarsa onayla.":@"Checking Bluetooth access… Allow access if macOS asks.",
            @"Bluetooth bağlantı servisi kapandı.":@"The Bluetooth connection service stopped.",
            @"Piyano bağlantısı kapalı":@"Piano disconnected",
            @"Bluetooth bağlantısı tamamlanamadı.":@"Bluetooth could not connect.",
            @"Bluetooth bağlantısında hata oluştu":@"A Bluetooth connection error occurred",
            @"macOS bağlantının kapandığını doğrulamadı.":@"macOS has not confirmed the disconnection.",
            @"Yamaha CLP-835 bağlı · tuşlar dinleniyor":@"Yamaha CLP-835 connected · listening for notes",
            @"Piyanoya ulaşılamadı. Piyanonun açık ve Bluetooth’un etkin olduğunu kontrol et.":@"Could not reach your piano. Make sure it is on and Bluetooth is enabled.",
            @"Piyano bağlantısı kesildi":@"Piano disconnected",
            @"Mac’in Bluetooth’u açık. Yakındaki CLP-835 MIDI bağlantısı aranıyor…":@"Bluetooth is on. Looking for a nearby CLP-835…",
            @"Mac’in Bluetooth servisi hazırlanıyor; henüz piyanoya bağlantı kurulmadı.":@"Preparing Bluetooth. Your piano is not connected yet.",
            @"Piyanoya Bluetooth bağlantısı kuruldu. MIDI hizmeti kontrol ediliyor…":@"Bluetooth connected. Checking the MIDI service…",
            @"Yamaha CLP-835 bağlantısı kuruluyor…":@"Connecting to Yamaha CLP-835…",
            @"MIDI bağlantısı hazırlanıyor… macOS eşleştirme onayı sorarsa onayla.":@"Preparing MIDI… Confirm pairing if macOS asks.",
            @"Bağlantı kapatılıyor…":@"Disconnecting…",
            @"Önce mevcut bağlantının kapanmasını bekle.":@"Wait for the current connection to close.",
            @"rach3’ün kayıtlı piyano kimliği temizlendi; yeniden arayabilirsin.":@"Your saved piano connection has been cleared. You can search again.",
            @"rach3 kaldırılsın mı?":@"Uninstall rach3?",
            @"Uygulama, modeller, kayıtlı dersler ve rach3’ün geçici verileri kalıcı olarak silinecek. Orijinal videolar ve dışarı aktardığın MIDI dosyaları korunacak.":@"The app, models, saved lessons, and temporary rach3 data will be permanently deleted. Your original videos and exported MIDI files will be kept.",
            @"Vazgeç":@"Cancel",
            @"rach3’ü kaldır":@"Uninstall rach3",
            @"İşlem tamamlanamadı.":@"The operation could not be completed.",
            @"rach3 açılamadı":@"rach3 could not open",
            @"Dosya kaydedilemedi":@"The file could not be saved",
            @"Bazı rach3 dosyaları silinemedi":@"Some rach3 files could not be deleted",
            @"Aç":@"Open",
            @"Kaydet":@"Save",
            @"Güncellemeler otomatik denetlenir.":@"Updates are checked automatically.",
            @"Yeni sürüm aranıyor…":@"Checking for updates…",
            @"Yeni sürüm yükleniyor; çalışma konumu kaydedilip rach3 yeniden açılacak…":@"Installing the update. Your place will be saved and rach3 will reopen…",
            @"Yeni sürüm bulundu. Arka planda hazırlanıyor…":@"An update is available. Preparing it in the background…",
            @"Yeni sürüm arka planda indiriliyor…":@"Downloading the update in the background…",
            @"En güncel sürüm yüklü.":@"You’re up to date.",
            @"Güncelleme tamamlanamadı. İnternet bağlantısını kontrol et; mevcut sürümle devam edebilirsin.":@"The update could not finish. Check your internet connection; you can continue with the current version.",
            @"Yeni sürüm var. Güncelleme menüsünden ayrıntıları açabilirsin.":@"An update is available. Open Check for Updates for details.",
            @"Geçersiz ders kimliği":@"Invalid lesson ID",
            @"Önce mevcut işlemi tamamla veya iptal et.":@"Finish or cancel the current task first.",
            @"Geçerli bir YouTube bağlantısı seç.":@"Choose a valid YouTube link.",
            @"En fazla 4 GB video seçebilirsin.":@"Choose a video no larger than 4 GB.",
            @"Dosya hazırlanıyor…":@"Preparing your file…",
            @"Video aktarımı kapalı.":@"The video transfer is closed.",
            @"Video aktarım boyutu geçersiz.":@"The video transfer size is invalid.",
            @"Ders işlemi bulunamadı.":@"The lesson task could not be found.",
            @"Video aktarımı tamamlanmadı.":@"The video transfer is incomplete.",
            @"Ders motoru başlatılıyor…":@"Starting the lesson engine…",
            @"İşlem iptal edildi":@"Cancelled",
            @"Ders oluşturulamadı. İşlem beklenmedik şekilde kapandı.":@"The lesson could not be created. The process stopped unexpectedly.",
            @"İşlem durduruluyor…":@"Cancelling…",
            @"Piyano notaları çıkarılıyor…":@"Transcribing piano notes…",
            @"Basma şiddeti ve pedal tahmin ediliyor…":@"Estimating dynamics and pedal…",
            @"Ders kaydediliyor…":@"Saving your lesson…",
            @"Ders hazır":@"Your lesson is ready",
            @"Video indiriliyor…":@"Downloading video…",
            @"Videonun sesi hazırlanıyor…":@"Preparing the video’s audio…",
            @"Vokal ve eşlik ayrılıyor…":@"Separating vocals and accompaniment…",
            @"Partisyon hazırlanıyor…":@"Preparing the score…",
            @"PDF sayfalarındaki notalar okunuyor…":@"Reading notes from the PDF…",
            @"MIDI notaları ve ritimleri okunuyor…":@"Reading MIDI notes and rhythms…",
            @"Ders ve partisyon eşleniyor…":@"Matching your lesson to the score…",
            @"Bu kayıttan çalınabilir piyano notası çıkarılamadı.":@"No playable piano notes could be transcribed from this recording.",
            @"Vuruş tabanlı, eşzamanlı standart MIDI gerekiyor (tip 0 veya 1).":@"A standard MIDI file with beat-based, synchronized tracks is required (type 0 or 1).",
            @"Dosyada çalınabilir piyano notası bulunamadı.":@"No playable piano notes were found in this file.",
            @"PDF sayfalarında farklı sayıda porte okundu; sayfalar güvenilir biçimde birleştirilemedi.":@"Different staff counts were detected across PDF pages, so they could not be reliably combined.",
            @"Dosyada okunabilir bir nota partisi bulunamadı.":@"No readable score part was found in this file.",
            @"Nota okuyucu sıfır uzunlukta ölçü üretti; PDF’den güvenilir ders çıkarılamadı.":@"The score reader produced an empty measure. A reliable lesson could not be created from this PDF.",
            @"Desteklenmeyen dil.":@"Unsupported language."
        };
        NSMutableDictionary *reverse = [NSMutableDictionary new];
        [english enumerateKeysAndObjectsUsingBlock:^(NSString *tr, NSString *en, BOOL *stop) {
            (void)stop; reverse[en] = tr;
        }];
        turkish = [reverse copy];
    });
    BOOL useTurkish = [PianoLanguage() isEqual:@"tr"];
    NSString *translated = (useTurkish ? turkish : english)[text];
    if (translated) return translated;
    // The worker emits a count after this app-owned progress prefix.
    NSString *source = useTurkish ? @"Preparing note sections: " : @"Nota bölümleri hazırlanıyor: ";
    NSString *target = useTurkish ? @"Nota bölümleri hazırlanıyor: " : @"Preparing note sections: ";
    if ([text hasPrefix:source]) return [target stringByAppendingString:[text substringFromIndex:source.length]];
    return text;
}

NSDictionary *PianoLocalizedStatus(NSDictionary *status) {
    NSMutableDictionary *localized = [status mutableCopy];
    for (NSString *key in @[@"message", @"detail", @"error"])
        if ([status[key] isKindOfClass:NSString.class]) localized[key] = PianoText(status[key]);
    if ([status[@"diagnostic"] isKindOfClass:NSDictionary.class])
        localized[@"diagnostic"] = PianoLocalizedStatus(status[@"diagnostic"]);
    return localized;
}
