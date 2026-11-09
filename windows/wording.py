"""Windows wording for page strings that name the Mac or macOS.

The page translates by Turkish source string (i18n.js). On Windows the build
injects this table as window.PianoPlatformText: source -> [Turkish, English].
build.py fails if any page string still mentions the Mac, so a new Mac-specific
message cannot ship to Windows unnoticed.
"""

SETTINGS_TR = 'Ayarlar → Bluetooth ve cihazlar'
SETTINGS_EN = 'Settings → Bluetooth & devices'

TEXT = {
    'Video bu Mac’te işlenir. Notlar, şiddet ve pedal otomatik tahmindir.':
        ('Video bu bilgisayarda işlenir. Notlar, şiddet ve pedal otomatik tahmindir.',
         'Video is processed on this PC. Notes, dynamics, and pedal are automatic estimates.'),
    'Bu Mac’te hazır. Yeniden indirilmez.':
        ('Bu bilgisayarda hazır. Yeniden indirilmez.', 'Ready on this PC. No download needed.'),
    'İlk kullanımda indirilir. Bu Mac’te saklanır.':
        ('İlk kullanımda indirilir. Bu bilgisayarda saklanır.', 'Download once. Keep on this PC.'),
    'Bu video açılamadı. H.264 biçiminde bir MP4 veya bu cihazda oynatılabilen başka bir video seç.':
        ('Bu video açılamadı. H.264 biçiminde bir MP4 veya bu cihazda oynatılabilen başka bir video seç.',
         'This video could not be opened. Choose an H.264 MP4 or another video this PC can play.'),
    'Piyanonun açık olduğundan emin ol ve Mac’i piyanonun yakınına getir.':
        ('Piyanonun açık olduğundan emin ol ve bilgisayarı piyanonun yakınına getir.',
         'Make sure your piano is on and move your PC closer to it.'),
    'macOS eşleştirme onayı gösteriyorsa isteği onayla.':
        ('Windows eşleştirme onayı gösteriyorsa isteği onayla.', 'Approve the pairing request if Windows shows one.'),
    'Mac’in Bluetooth’u kapalı':
        ('Bilgisayarın Bluetooth’u kapalı', 'Bluetooth is off on this PC'),
    'Mac bunu doğrudan bildirdi. Piyanonun Bluetooth ayarını bu durumda okuyamıyoruz.':
        ('Windows bunu doğrudan bildirdi. Piyanonun Bluetooth ayarını bu durumda okuyamıyoruz.',
         'Windows reported this directly. The piano’s Bluetooth setting cannot be checked in this state.'),
    'Mac’te Sistem Ayarları → Bluetooth bölümünü aç ve Bluetooth’u etkinleştir.':
        (f'Windows’ta {SETTINGS_TR} bölümünü aç ve Bluetooth’u etkinleştir.',
         f'Open {SETTINGS_EN} in Windows and turn Bluetooth on.'),
    'Mac’te Bluetooth erişim izni yok':
        ('Bu bilgisayarda Bluetooth erişim izni yok', 'Bluetooth access is not allowed on this PC'),
    'Bu, uygulamanın macOS izniyle ilgili; piyanonun kapalı olduğu anlamına gelmez.':
        ('Bu, uygulamanın Windows izniyle ilgili; piyanonun kapalı olduğu anlamına gelmez.',
         'This concerns the app’s Windows permission. It does not mean your piano is off.'),
    'Mac’te Sistem Ayarları → Gizlilik ve Güvenlik → Bluetooth bölümünü aç.':
        ('Windows’ta Ayarlar → Gizlilik ve güvenlik → Radyolar bölümünü aç.',
         'Open Settings → Privacy & security → Radios in Windows.'),
    'Rach3 Bluetooth için erişimi aç. macOS izin penceresinde farklı bir başlatıcı adı gösterdiyse o uygulamanın iznini kontrol et.':
        ('Masaüstü uygulamalarının radyolara erişmesine izin ver.',
         'Allow desktop apps to access your radios.'),
    'macOS uygulamayı yeniden açmanı isterse Rach3’ü yeniden aç.':
        ('İzni değiştirdikten sonra Rach3’ü yeniden aç.', 'Reopen Rach3 after changing the permission.'),
    'Mac Bluetooth erişimini kısıtlıyor':
        ('Windows Bluetooth erişimini kısıtlıyor', 'Windows restricts Bluetooth access'),
    'macOS bu erişimi kısıtlanmış olarak bildirdi. Yalnız Bluetooth düğmesini açmak bunu çözmez.':
        ('Windows bu erişimi kısıtlanmış olarak bildirdi. Yalnız Bluetooth düğmesini açmak bunu çözmez.',
         'Windows reported restricted access. Turning Bluetooth on alone will not resolve this.'),
    'Yönetilen bir Mac kullanıyorsan Bluetooth erişim kısıtını cihaz yöneticinle kontrol et.':
        ('Yönetilen bir bilgisayar kullanıyorsan Bluetooth erişim kısıtını cihaz yöneticinle kontrol et.',
         'If this is a managed PC, ask its administrator about Bluetooth restrictions.'),
    'macOS henüz uygulamanın Bluetooth erişimi için bir karar bildirmedi.':
        ('Windows henüz uygulamanın Bluetooth erişimi için bir karar bildirmedi.',
         'Windows has not yet reported a decision about the app’s Bluetooth access.'),
    'Mac’te açık kalan Bluetooth izin penceresini kontrol et ve erişimi onayla.':
        ('Açık kalan Bluetooth izin penceresini kontrol et ve erişimi onayla.',
         'Check for an open Bluetooth permission dialog and allow access.'),
    'Mac’te gerekli Bluetooth desteği bulunamadı':
        ('Bu bilgisayarda Bluetooth LE desteği bulunamadı', 'This PC has no Bluetooth LE support'),
    'macOS bu Bluetooth bağlantı yöntemini desteklenmiyor olarak bildirdi.':
        ('Windows bu bilgisayarda Bluetooth Low Energy bağlantısının desteklenmediğini bildirdi.',
         'Windows reported that Bluetooth Low Energy is not supported on this PC.'),
    'Mac’in Bluetooth donanımının kullanılabilir olduğunu Sistem Ayarları’ndan kontrol et.':
        (f'{SETTINGS_TR} bölümünden bilgisayarın Bluetooth donanımını kontrol et. Bluetooth 4.0 veya üstü bir USB adaptör de kullanabilirsin.',
         f'Check this PC’s Bluetooth hardware in {SETTINGS_EN}. A Bluetooth 4.0 or newer USB adapter also works.'),
    'Sorun sürerse bu Mac’te kablosuz piyano bağlantısı kullanılamıyor; uygulama sentezleyicisiyle dinleyebilirsin.':
        ('Sorun sürerse bu bilgisayarda kablosuz piyano bağlantısı kullanılamıyor; uygulama sentezleyicisiyle dinleyebilirsin.',
         'If this continues, wireless piano connection is unavailable on this PC. You can listen using the app synthesizer.'),
    'Mac’in Bluetooth servisi yeniden başladı':
        ('Bilgisayarın Bluetooth’u kapandı veya yeniden başladı', 'Bluetooth on this PC turned off or restarted'),
    'Mac’te Bluetooth’un tekrar açık ve hazır olmasını bekle.':
        ('Bluetooth’un tekrar açık ve hazır olmasını bekle.', 'Wait for Bluetooth to turn on and become ready again.'),
    'Mac’in Bluetooth servisi hazır değil':
        ('Bilgisayarın Bluetooth servisi hazır değil', 'This PC’s Bluetooth service is not ready'),
    'Mac henüz kullanılabilir bir Bluetooth durumu bildirmedi; piyanonun durumunu doğrulayamadık.':
        ('Windows henüz kullanılabilir bir Bluetooth durumu bildirmedi; piyanonun durumunu doğrulayamadık.',
         'Windows has not reported an available Bluetooth state. The piano’s status could not be confirmed.'),
    'Sistem Ayarları → Bluetooth bölümünde Mac’in Bluetooth durumunu kontrol et.':
        (f'{SETTINGS_TR} bölümünde Bluetooth durumunu kontrol et.', f'Check the Bluetooth status in {SETTINGS_EN}.'),
    'Mac’in Bluetooth’u açık; piyanoyla bağlantı kurulamadı. Piyano kapalı, Bluetooth’u kapalı, menzil dışında veya başka bir bağlantıda olabilir. Hangisi olduğunu uzaktan ayıramıyoruz.':
        ('Bilgisayarın Bluetooth’u açık; piyanoyla bağlantı kurulamadı. Piyano kapalı, Bluetooth’u kapalı, menzil dışında veya başka bir bağlantıda olabilir. Hangisi olduğunu uzaktan ayıramıyoruz.',
         'Bluetooth is on, but the piano could not be reached. The piano or its Bluetooth may be off, out of range, or connected elsewhere. These possibilities cannot be distinguished remotely.'),
    'macOS bağlantı denemesini tamamlayamadı. Bu bilgi piyanonun Bluetooth’unun kapalı olduğunu kanıtlamaz.':
        ('Windows bağlantı denemesini tamamlayamadı. Bu bilgi piyanonun Bluetooth’unun kapalı olduğunu kanıtlamaz.',
         'Windows could not complete the connection. This does not establish that the piano’s Bluetooth is off.'),
    'macOS bu bağlantıda kimlik doğrulama, şifreleme veya eşleştirme kaydı sorunu bildirdi.':
        (f'Windows bu bağlantıda eşleştirme veya şifreleme sorunu bildirdi. {SETTINGS_TR} bölümünde piyanoyu kaldırıp yeniden dene.',
         f'Windows reported a pairing or encryption issue. Remove the piano in {SETTINGS_EN} and try again.'),
    'MIDI kanalının ilk okuması başarısız oldu. macOS bir izin/eşleştirme hatası belirtmediyse sebebini kesin olarak söyleyemiyoruz.':
        ('MIDI kanalının ilk okuması başarısız oldu. Windows bir izin/eşleştirme hatası belirtmediyse sebebini kesin olarak söyleyemiyoruz.',
         'The initial MIDI-channel read failed. Without a permission or pairing error from Windows, the cause cannot be confirmed.'),
    'Rach3 kapatma istedi; macOS kapanışı onaylamadı. Bağlantı kesin kapandı diyemiyoruz.':
        ('Rach3 kapatma istedi; Windows kapanışı onaylamadı. Bağlantı kesin kapandı diyemiyoruz.',
         'Rach3 requested disconnection, but Windows did not confirm it. The connection may still be open.'),
    'Sorun Mac’teki uygulama bağlantı servisinde. Bu hata piyanonun Bluetooth ayarını göstermez.':
        ('Sorun bilgisayardaki uygulama bağlantı servisinde. Bu hata piyanonun Bluetooth ayarını göstermez.',
         'The issue is in the app’s connection service on this PC. This error does not indicate the piano’s Bluetooth setting.'),
    'Şu anda Mac’in veya piyanonun Bluetooth durumunu sorgulayamıyoruz.':
        ('Şu anda bilgisayarın veya piyanonun Bluetooth durumunu sorgulayamıyoruz.',
         'The Bluetooth status of this PC and the piano cannot currently be checked.'),
    'Bu hatanın kesin nedeni belirlenemedi; piyanonun veya Mac’in Bluetooth’u kapalı diye varsaymıyoruz.':
        ('Bu hatanın kesin nedeni belirlenemedi; piyanonun veya bilgisayarın Bluetooth’u kapalı diye varsaymıyoruz.',
         'The exact cause is unknown. This does not establish that Bluetooth is off on the piano or PC.'),
    'Mac’in Bluetooth erişimi kontrol ediliyor… macOS izin sorarsa onayla.':
        ('Bilgisayarın Bluetooth erişimi kontrol ediliyor…', 'Checking Bluetooth access…'),
    'Mac’in Bluetooth’u açık. Yakındaki CLP-835 MIDI bağlantısı aranıyor…':
        ('Bluetooth açık. Yakındaki MIDI piyano aranıyor…', 'Bluetooth is on. Looking for a nearby MIDI piano…'),
    'Mac’in Bluetooth servisi hazırlanıyor; henüz piyanoya bağlantı kurulmadı.':
        ('Bilgisayarın Bluetooth servisi hazırlanıyor; henüz piyanoya bağlantı kurulmadı.',
         'Preparing Bluetooth. The piano is not connected yet.'),
    'MIDI bağlantısı hazırlanıyor… Gerekirse macOS onayını ver.':
        ('MIDI bağlantısı hazırlanıyor… Gerekirse Windows onayını ver.', 'Preparing the MIDI connection… Approve the Windows request if needed.'),
    'macOS bağlantının kapandığını doğrulamadı.':
        ('Windows bağlantının kapandığını doğrulamadı.', 'Windows did not confirm disconnection.'),
    'Mac’in Bluetooth servisi hazır değil.':
        ('Bilgisayarın Bluetooth servisi hazır değil.', 'This PC’s Bluetooth service is not ready.'),
    'Kayıtlı cihaz artık çalışmıyorsa yeniden tara ve görünen cihazı seç. “Bu cihazı unut” yalnız uygulamadaki kaydı kaldırır; macOS eşleştirmesini değiştirmez.':
        ('Kayıtlı cihaz artık çalışmıyorsa yeniden tara ve görünen cihazı seç. “Bu cihazı unut” yalnız uygulamadaki kaydı kaldırır; Windows eşleştirmesini değiştirmez.',
         'If the saved device no longer connects, scan again and select the discovered device. “Forget this device” only removes the app’s record; it does not change Windows pairing.'),
}


def mentions_mac(text):
    import re
    return bool(re.search(r'\bMac\b|Mac’|macOS', text))
