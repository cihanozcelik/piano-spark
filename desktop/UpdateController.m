#import "Localization.h"
#import "UpdateController.h"
#import <Sparkle/Sparkle.h>

@interface UpdateController () <SPUUpdaterDelegate, SPUStandardUserDriverDelegate>
@property (nonatomic, strong) SPUStandardUpdaterController *controller;
@property (nonatomic, strong) NSDictionary *releaseInfo;
@property (nonatomic, copy) NSString *status;
@property (nonatomic) BOOL started;
@property (nonatomic) BOOL installing;
@property (nonatomic) BOOL stopped;
@property (nonatomic) BOOL newVersion;
@property (nonatomic, strong) SUAppcastItem *pending;
@end

@implementation UpdateController
- (instancetype)init {
    self = [super init];
    if (self) {
        NSData *data = [NSData dataWithContentsOfURL:[NSBundle.mainBundle URLForResource:@"release" withExtension:@"json"]];
        _releaseInfo = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        _status = @"Güncellemeler otomatik denetlenir.";
        NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
        NSString *previous = [defaults stringForKey:@"LastLaunchedBuild"];
        NSString *current = [_releaseInfo[@"build"] stringValue];
        if (previous && ![previous isEqual:current]) [defaults setObject:current forKey:@"UnreadUpdateBuild"];
        _newVersion = [[defaults stringForKey:@"UnreadUpdateBuild"] isEqual:current];
        [defaults setObject:current forKey:@"LastLaunchedBuild"];
        _controller = [[SPUStandardUpdaterController alloc] initWithStartingUpdater:NO updaterDelegate:self userDriverDelegate:self];
    }
    return self;
}
- (NSDictionary *)snapshot {
    return @{@"event":@"update",@"version":self.releaseInfo[@"version"],@"notes":self.releaseInfo[@"localizedNotes"][PianoLanguage()] ?: self.releaseInfo[@"notes"],
        @"newVersion":@(self.newVersion),@"message":PianoText(self.status),
        @"availableVersion":self.pending.displayVersionString ?: @"",@"availableNotes":self.pending.itemDescription ?: @""};
}
- (void)changed { if (self.onChange) self.onChange([self snapshot]); }
- (void)start {
    if (self.stopped || self.started) return;
    self.controller.updater.automaticallyChecksForUpdates = YES;
    self.controller.updater.automaticallyDownloadsUpdates = YES;
    [self.controller startUpdater];
    self.started = YES;
    // A delta may be one step in a chain when this Mac missed several releases.
    if (self.newVersion) [self.controller.updater checkForUpdatesInBackground];
    self.status = @"Güncellemeler otomatik denetlenir.";
    [self changed];
}
- (void)check:(id)sender {
    [self start];
    if (self.controller.updater.canCheckForUpdates) {
        self.status = @"Yeni sürüm aranıyor…"; [self changed];
        [self.controller checkForUpdates:sender];
    } else { [self.controller checkForUpdates:sender]; }
}
- (void)acknowledge {
    self.newVersion = NO; [NSUserDefaults.standardUserDefaults removeObjectForKey:@"UnreadUpdateBuild"]; [self changed];
}
- (void)stop {
    self.stopped = YES;
    self.controller.updater.automaticallyChecksForUpdates = NO;
}
- (BOOL)updater:(SPUUpdater *)updater willInstallUpdateOnQuit:(SUAppcastItem *)item immediateInstallationBlock:(void (^)(void))handler {
    (void)updater; (void)item;
    self.status = @"Yeni sürüm yükleniyor; çalışma konumu kaydedilip rach3 yeniden açılacak…";
    self.installing = YES; [self changed];
    dispatch_async(dispatch_get_main_queue(), ^{ if (!self.stopped) handler(); });
    return YES;
}
- (SUAppcastItem *)bestValidUpdateInAppcast:(SUAppcast *)appcast forUpdater:(SPUUpdater *)updater {
    NSString *installed = [updater.hostBundle objectForInfoDictionaryKey:@"CFBundleVersion"];
    SUStandardVersionComparator *versions = SUStandardVersionComparator.defaultComparator;
    SUAppcastItem *reachable = nil;
    // Sparkle supplies already-filtered top-level items and chooses their delta itself.
    // Retained feed entries let an older Mac advance through small signed patches.
    for (SUAppcastItem *item in appcast.items) {
        if (item.deltaUpdates[installed] && [versions compareVersion:item.versionString toVersion:installed] == NSOrderedDescending &&
            (!reachable || [versions compareVersion:item.versionString toVersion:reachable.versionString] == NSOrderedDescending)) {
            reachable = item;
        }
    }
    // No matching patch (or a damaged installation): Sparkle's full repair path.
    return reachable;
}
- (void)updater:(SPUUpdater *)updater didFindValidUpdate:(SUAppcastItem *)item {
    (void)updater; self.pending = item; self.status = @"Yeni sürüm bulundu. Arka planda hazırlanıyor…"; [self changed];
}
- (void)updater:(SPUUpdater *)updater willDownloadUpdate:(SUAppcastItem *)item withRequest:(NSMutableURLRequest *)request {
    (void)updater; (void)item;
    [request setValue:@"application/octet-stream" forHTTPHeaderField:@"Accept"];
    self.status = @"Yeni sürüm arka planda indiriliyor…"; [self changed];
}
- (void)updater:(SPUUpdater *)updater didAbortWithError:(NSError *)error {
    (void)updater;
    self.installing = NO;
    self.status = error.code == SUNoUpdateError ? @"En güncel sürüm yüklü." : @"Güncelleme tamamlanamadı. İnternet bağlantısını kontrol et; mevcut sürümle devam edebilirsin.";
    [self changed];
}
- (BOOL)supportsGentleScheduledUpdateReminders { return YES; }
- (BOOL)standardUserDriverShouldHandleShowingScheduledUpdate:(SUAppcastItem *)update andInImmediateFocus:(BOOL)focus {
    (void)update; (void)focus;
    self.status = @"Yeni sürüm var. Güncelleme menüsünden ayrıntıları açabilirsin."; [self changed]; return NO;
}
@end
