#import "Localization.h"
#import <AppKit/AppKit.h>
#import <unistd.h>

@interface PianoInstaller : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property (nonatomic, strong) NSWindow *window;
@property (nonatomic, strong) NSTextField *status;
@property (nonatomic, strong) NSButton *install;
@property (nonatomic, strong) NSButton *cancel;
@property (nonatomic, strong) NSProgressIndicator *progress;
@property (nonatomic, strong) NSURL *destination;
@property (atomic) BOOL cancelled;
@property (nonatomic) BOOL working;
@property (nonatomic) BOOL installed;
@end

@implementation PianoInstaller
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    self.destination = [NSURL fileURLWithPath:[NSHomeDirectory() stringByAppendingPathComponent:@"Applications/Piano Spark.app"]];
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,540,290)
        styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
    self.window.title = PianoText(@"Piano Spark Kurulumu"); self.window.delegate = self;
    self.window.releasedWhenClosed = NO;
    NSTextField *heading = [NSTextField labelWithString:PianoText(@"Piano Spark’ı yükle")];
    heading.font = [NSFont boldSystemFontOfSize:24]; heading.frame = NSMakeRect(28,232,480,32);
    [self.window.contentView addSubview:heading];
    self.status = [NSTextField wrappingLabelWithString:
        PianoText(@"Piyano derslerini videodan bu Mac’te oluştur. Gerekli motorlar ve modeller pakete dahildir.\n\nUygulama hesabının Applications klasörüne kurulacak. Ayrı Python kurulmaz, sistem servisi eklenmez. Güncelleme sırasında açık Piano Spark kapanır.")];
    self.status.frame = NSMakeRect(28,98,480,124); [self.window.contentView addSubview:self.status];
    self.progress = [[NSProgressIndicator alloc] initWithFrame:NSMakeRect(28,78,480,10)];
    self.progress.indeterminate = YES; self.progress.style = NSProgressIndicatorStyleBar;
    self.progress.hidden = YES; [self.window.contentView addSubview:self.progress];
    self.install = [NSButton buttonWithTitle:PianoText(@"Yükle") target:self action:@selector(installApp:)];
    self.install.frame = NSMakeRect(382,24,130,34); [self.window.contentView addSubview:self.install];
    self.cancel = [NSButton buttonWithTitle:PianoText(@"Vazgeç") target:self action:@selector(cancelInstall:)];
    self.cancel.frame = NSMakeRect(264,24,110,34); [self.window.contentView addSubview:self.cancel];
    [self.window center]; [self.window makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES];
}
- (void)cancelInstall:(id)sender {
    (void)sender;
    if (self.working) { self.cancelled = YES; self.status.stringValue = PianoText(@"Kurulum iptal ediliyor…"); self.cancel.enabled = NO; }
    else [NSApp terminate:nil];
}
- (BOOL)windowShouldClose:(NSWindow *)sender { (void)sender; [self cancelInstall:nil]; return NO; }
- (void)installApp:(id)sender {
    (void)sender;
    if (self.installed) { [NSWorkspace.sharedWorkspace openURL:self.destination]; [NSApp terminate:nil]; return; }
    self.working = YES; self.install.enabled = NO;
    self.status.stringValue = PianoText(@"Uygulama ve modeller kopyalanıyor…\n\nBu işlem bitene kadar mevcut uygulama korunur.");
    self.progress.hidden = NO; [self.progress startAnimation:nil];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0), ^{
        NSFileManager *files = NSFileManager.defaultManager;
        NSURL *support = [[files URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject URLByAppendingPathComponent:@"PianoMan/Install"];
        NSURL *stage = [support URLByAppendingPathComponent:NSUUID.UUID.UUIDString];
        NSURL *prepared = [stage URLByAppendingPathComponent:@"Piano Spark.app"];
        NSURL *backup = [stage URLByAppendingPathComponent:@"Previous.app"];
        NSURL *payload = [NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"Piano Spark.app"];
        NSError *error;
        BOOL ok = [files createDirectoryAtURL:stage withIntermediateDirectories:YES attributes:nil error:&error];
        if (ok) ok = [files copyItemAtURL:payload toURL:prepared error:&error];
        if (ok && !self.cancelled) {
            for (NSRunningApplication *app in [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.pianoman.desktop"]) {
                if ([app.bundleURL.path isEqual:self.destination.path]) {
                    [app terminate];
                    for (int i=0;i<300 && !app.terminated && !self.cancelled;i++) usleep(100000);
                    if (!app.terminated) { ok = NO; error = [NSError errorWithDomain:@"PianoMan.Installer" code:1 userInfo:@{NSLocalizedDescriptionKey:PianoText(@"Açık Piano Spark kapanmadı. Kapatıp kurulumu tekrar başlat.")}]; break; }
                }
            }
        }
        BOOL movedOld = NO, didInstall = NO;
        if (ok && !self.cancelled) {
            ok = [files createDirectoryAtURL:self.destination.URLByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:&error];
            if (ok && [files fileExistsAtPath:self.destination.path]) { ok = [files moveItemAtURL:self.destination toURL:backup error:&error]; movedOld = ok; }
            if (ok) { ok = [files moveItemAtURL:prepared toURL:self.destination error:&error]; didInstall = ok; }
            if (!ok && movedOld) {
                NSError *restoreError;
                if (![files moveItemAtURL:backup toURL:self.destination error:&restoreError]) {
                    error = restoreError; stage = nil; // Preserve the old app for recovery.
                }
            }
        }
        if (stage) [files removeItemAtURL:stage error:NULL];
        rmdir(support.path.fileSystemRepresentation);
        dispatch_async(dispatch_get_main_queue(), ^{
            self.working = NO; [self.progress stopAnimation:nil]; self.progress.hidden = YES;
            if (self.cancelled && !didInstall) { [NSApp terminate:nil]; return; }
            self.install.enabled = YES; self.cancel.enabled = YES;
            if (ok) {
                self.installed = YES; self.install.title = PianoText(@"Piano Spark’ı aç"); self.cancel.title = PianoText(@"Kapat");
                self.status.stringValue = PianoText(@"Piano Spark yüklendi.\n\nVideonu seçip Ders oluştur düğmesine basabilirsin. Uygulamayı ve verilerini kaldırmak için Piano Spark menüsündeki “Piano Spark’ı kaldır…” seçeneğini kullan.");
            } else self.status.stringValue = [PianoText(@"Kurulum tamamlanamadı.\n\n") stringByAppendingString:error.localizedDescription ?: PianoText(@"Dosya kopyalanamadı.")];
        });
    });
}
@end

int main(void) {
    @autoreleasepool {
        NSApplication *app = NSApplication.sharedApplication;
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        __attribute__((objc_precise_lifetime)) PianoInstaller *owner = [PianoInstaller new];
        app.delegate = owner; [app run];
    }
    return 0;
}
