#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <signal.h>
#import <unistd.h>
#import "LessonService.h"
#import "UpdateController.h"
#import "../bluetooth-connection/BLEMIDIOutput.h"

int PianoBluetoothMain(int argc, const char *argv[]);

@interface PianoApp : NSObject <NSApplicationDelegate, NSWindowDelegate,
    WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply, WKDownloadDelegate>
@property (nonatomic, strong) NSWindow *window;
@property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, strong) NSURL *pageURL;
@property (nonatomic, strong) NSURL *runtimeURL;
@property (nonatomic, strong) NSTask *bluetooth;
@property (nonatomic, strong) NSMutableDictionary *state;
@property (nonatomic, strong) NSMutableDictionary *held;
@property (nonatomic, strong) NSMutableSet *downloads;
@property (nonatomic, strong) NSString *deviceUUID;
@property (nonatomic) BOOL pageReady;
@property (nonatomic) BOOL quitting;
@property (nonatomic) BOOL savingWorkspace;
@property (nonatomic, strong) LessonService *lessons;
@property (nonatomic, strong) NSURL *pendingVideo;
@property (nonatomic) BOOL uninstalling;
@property (nonatomic, strong) UpdateController *updates;
@end

@implementation PianoApp

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    self.state = [@{@"phase":@"disconnected", @"connected":@NO, @"message":@"Piyano bağlı değil",
        @"device":@"Yamaha CLP-835", @"note_count":@0, @"last_note":NSNull.null, @"pedal":NSNull.null, @"active":@NO} mutableCopy];
    self.held = [NSMutableDictionary new];
    self.downloads = [NSMutableSet new];
    self.deviceUUID = [NSUserDefaults.standardUserDefaults stringForKey:@"BluetoothDeviceUUID"];
    NSURL *support = [[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory
        inDomains:NSUserDomainMask].firstObject;
    self.runtimeURL = [support URLByAppendingPathComponent:@"PianoMan/Bluetooth" isDirectory:YES];
    self.lessons = [[LessonService alloc] initWithEngine:[NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"Engine"]
        support:[support URLByAppendingPathComponent:@"PianoMan" isDirectory:YES]];
    __weak PianoApp *weakSelf = self;
    self.lessons.onEvent = ^(NSDictionary *event) { [weakSelf publish:event]; };
    self.lessons.onIdle = ^{ dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf finishTermination]; }); };
    self.pageURL = [NSBundle.mainBundle URLForResource:@"index" withExtension:@"html"];

    WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
    configuration.websiteDataStore = WKWebsiteDataStore.defaultDataStore;
    [configuration.userContentController addScriptMessageHandlerWithReply:self
        contentWorld:WKContentWorld.pageWorld name:@"pianoman"];
    WKUserScript *errors = [[WKUserScript alloc] initWithSource:
        @"window.addEventListener('error', e => window.webkit.messageHandlers.pianoman.postMessage({command:'page-error',message:e.message}));"
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES];
    [configuration.userContentController addUserScript:errors];
    self.webView = [[WKWebView alloc] initWithFrame:NSZeroRect configuration:configuration];
    self.webView.navigationDelegate = self;
    self.webView.UIDelegate = self;
    self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

    NSRect visible = NSScreen.mainScreen.visibleFrame;
    NSRect frame = NSMakeRect(0, 0, MIN(1340, visible.size.width), MIN(920, visible.size.height));
    self.window = [[NSWindow alloc] initWithContentRect:frame
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    self.window.title = @"PianoMan";
    self.window.delegate = self;
    self.window.releasedWhenClosed = NO;
    self.window.minSize = NSMakeSize(820, 620);
    self.window.collectionBehavior = NSWindowCollectionBehaviorFullScreenPrimary;
    self.window.backgroundColor = [NSColor colorWithSRGBRed:.075 green:.08 blue:.09 alpha:1];
    self.window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    self.window.contentView = self.webView;
    if (![self.window setFrameUsingName:@"PianoManMainWindow"]) [self.window center];
    [self.window setFrameAutosaveName:@"PianoManMainWindow"];
    self.updates = [UpdateController new];
    self.updates.onChange = ^(NSDictionary *event) { [weakSelf publish:event]; };
    [self makeMenus];
    [self.updates start];
    [self.webView loadFileURL:self.pageURL allowingReadAccessToURL:NSBundle.mainBundle.resourceURL];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    if (self.pendingVideo) {
        NSError *error;
        if (![self.lessons openVideo:self.pendingVideo error:&error]) [self showLessonError:error];
        self.pendingVideo = nil;
    }
}

- (void)makeMenus {
    NSMenu *bar = [NSMenu new];
    NSMenuItem *appItem = [NSMenuItem new];
    NSMenu *app = [[NSMenu alloc] initWithTitle:@"PianoMan"];
    [app addItemWithTitle:@"PianoMan Hakkında" action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
    NSMenuItem *updates = [app addItemWithTitle:@"Güncellemeleri denetle…" action:@selector(check:) keyEquivalent:@""];
    updates.target = self.updates;
    [app addItem:NSMenuItem.separatorItem];
    [app addItemWithTitle:@"PianoMan’i Gizle" action:@selector(hide:) keyEquivalent:@"h"];
    NSMenuItem *uninstall = [app addItemWithTitle:@"PianoMan’i kaldır…" action:@selector(uninstall:) keyEquivalent:@""];
    uninstall.target = self;
    [app addItemWithTitle:@"PianoMan’den Çık" action:@selector(terminate:) keyEquivalent:@"q"];
    appItem.submenu = app; [bar addItem:appItem];
    NSMenuItem *editItem = [NSMenuItem new];
    NSMenu *edit = [[NSMenu alloc] initWithTitle:@"Düzenle"];
    [edit addItemWithTitle:@"Kopyala" action:@selector(copy:) keyEquivalent:@"c"];
    [edit addItemWithTitle:@"Yapıştır" action:@selector(paste:) keyEquivalent:@"v"];
    [edit addItemWithTitle:@"Tümünü Seç" action:@selector(selectAll:) keyEquivalent:@"a"];
    editItem.submenu = edit; [bar addItem:editItem];
    NSMenuItem *viewItem = [NSMenuItem new];
    NSMenu *view = [[NSMenu alloc] initWithTitle:@"Görünüm"];
    NSMenuItem *full = [view addItemWithTitle:@"Tam Ekran" action:@selector(toggleFullScreen:) keyEquivalent:@"f"];
    full.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagControl;
    full.target = self.window;
    viewItem.submenu = view; [bar addItem:viewItem];
    NSApp.mainMenu = bar;
}

- (NSDictionary *)snapshot {
    return @{@"event":@"snapshot", @"status":[self.state copy], @"held":self.held.allValues,
        @"fullscreen":@((self.window.styleMask & NSWindowStyleMaskFullScreen) != 0)};
}

- (void)publish:(NSDictionary *)event {
    if (!self.pageReady || self.quitting) return;
    [self.webView callAsyncJavaScript:@"window.dispatchEvent(new CustomEvent('pianoman-native-event', {detail: event}));"
        arguments:@{@"event":event} inFrame:nil inContentWorld:WKContentWorld.pageWorld
        completionHandler:^(id result, NSError *error) {
            (void)result;
            if (error) NSLog(@"PianoMan arayüz aktarımı: %@", error.localizedDescription);
        }];
}

- (void)setPhase:(NSString *)phase message:(NSString *)message {
    BOOL connected = [phase isEqualToString:@"connected"];
    [self.state addEntriesFromDictionary:@{@"phase":phase, @"connected":@(connected), @"message":message}];
    if (!connected) { [self.held removeAllObjects]; self.state[@"pedal"] = NSNull.null; self.state[@"output_capable"] = @NO; }
    [self publish:@{@"event":@"status", @"status":[self.state copy]}];
}

- (void)startBluetooth {
    if (self.bluetooth || self.quitting) return;
    self.state[@"active"] = @YES;
    [self.state removeObjectForKey:@"diagnostic"];
    self.state[@"note_count"] = @0;
    self.state[@"last_note"] = NSNull.null;
    [self setPhase:@"connecting" message:@"Mac’in Bluetooth erişimi kontrol ediliyor… macOS izin sorarsa onayla."];
    NSTask *task = [NSTask new];
    task.executableURL = NSBundle.mainBundle.executableURL;
    NSMutableArray *args = [@[@"--bluetooth", self.runtimeURL.path, @"start", @"--timeout", @"45", @"--duration", @"0"] mutableCopy];
    if (self.deviceUUID.length) [args addObjectsFromArray:@[@"--uuid", self.deviceUUID]];
    task.arguments = args;
    NSPipe *pipe = [NSPipe pipe];
    task.standardOutput = pipe;
    task.standardError = pipe;
    NSError *error;
    if (![task launchAndReturnError:&error]) {
        self.state[@"active"] = @NO;
        self.state[@"diagnostic"] = @{@"code":@"service_failed", @"detail":error.localizedDescription};
        [self setPhase:@"error" message:error.localizedDescription]; return;
    }
    self.bluetooth = task;
    __weak PianoApp *weakSelf = self;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        NSMutableData *buffer = [NSMutableData new];
        NSFileHandle *reader = pipe.fileHandleForReading;
        for (;;) {
            @autoreleasepool {
                NSData *chunk = reader.availableData;
                if (!chunk.length) break;
                [buffer appendData:chunk];
                NSMutableArray *events = [NSMutableArray new];
                for (;;) {
                    const void *newline = memchr(buffer.bytes, '\n', buffer.length);
                    if (!newline) break;
                    NSUInteger count = (const char *)newline - (const char *)buffer.bytes;
                    NSData *line = [buffer subdataWithRange:NSMakeRange(0, count)];
                    [buffer replaceBytesInRange:NSMakeRange(0, count + 1) withBytes:NULL length:0];
                    id value = [NSJSONSerialization JSONObjectWithData:line options:0 error:NULL];
                    if ([value isKindOfClass:NSDictionary.class]) [events addObject:value];
                }
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (weakSelf.bluetooth != task) return;
                    for (NSDictionary *event in events) [weakSelf handleBluetooth:event];
                });
            }
        }
        [reader closeFile];
        [task waitUntilExit];
        dispatch_async(dispatch_get_main_queue(), ^{
            PianoApp *owner = weakSelf;
            if (owner.bluetooth != task) return;
            owner.bluetooth = nil;
            owner.state[@"active"] = @NO;
            if ([owner.state[@"phase"] isEqual:@"error"]) [owner setPhase:@"error" message:owner.state[@"message"]];
            else {
                if (task.terminationStatus != 0) {
                    owner.state[@"diagnostic"] = @{@"code":@"service_failed", @"osCode":@(task.terminationStatus)};
                    [owner setPhase:@"error" message:@"Bluetooth bağlantı servisi kapandı."];
                }
                else [owner setPhase:@"disconnected" message:@"Piyano bağlantısı kapalı"];
            }
            [owner finishTermination];
        });
    });
}

- (void)handleBluetooth:(NSDictionary *)event {
    NSString *kind = event[@"event"];
    if ([kind isEqual:@"output_error"]) { [self publish:event]; return; }
    if ([kind isEqual:@"connection_issue"] || ([kind isEqual:@"stopped"] && event[@"diagnostic"])) {
        self.state[@"diagnostic"] = event[@"diagnostic"];
        [self setPhase:@"error" message:@"Bluetooth bağlantısı tamamlanamadı."]; return;
    }
    if ([kind isEqual:@"error"]) {
        if (!self.state[@"diagnostic"]) self.state[@"diagnostic"] = @{@"code":@"service_failed",
            @"detail":event[@"message"] ?: @"", @"stage":event[@"operation"] ?: @"", @"osCode":event[@"code"] ?: NSNull.null};
        [self setPhase:@"error" message:event[@"message"] ?: @"Bluetooth bağlantısında hata oluştu"];
    } else if ([kind isEqual:@"stopped"]) {
        if (![event[@"own_connection_closed"] boolValue]) {
            self.state[@"diagnostic"] = @{@"code":@"disconnect_unconfirmed"};
            [self setPhase:@"error" message:@"macOS bağlantının kapandığını doğrulamadı."];
        }
    } else if ([self.state[@"phase"] isEqual:@"stopping"]) {
        return;
    } else if ([kind isEqual:@"ready"]) {
        [self.state removeObjectForKey:@"diagnostic"];
        self.state[@"output_capable"] = event[@"output_capable"] ?: @NO;
        self.deviceUUID = event[@"uuid"];
        [NSUserDefaults.standardUserDefaults setObject:self.deviceUUID forKey:@"BluetoothDeviceUUID"];
        [self setPhase:@"connected" message:@"Yamaha CLP-835 bağlı · tuşlar dinleniyor"];
    } else if ([kind isEqual:@"connection_timeout"]) {
        [self setPhase:@"error" message:@"Piyanoya ulaşılamadı. Piyanonun açık ve Bluetooth’un etkin olduğunu kontrol et."];
    } else if ([kind isEqual:@"disconnected"]) {
        [self setPhase:@"disconnected" message:@"Piyano bağlantısı kesildi"];
    } else if ([kind isEqual:@"scanning"]) {
        [self setPhase:@"connecting" message:@"Mac’in Bluetooth’u açık. Yakındaki CLP-835 MIDI bağlantısı aranıyor…"];
    } else if ([kind isEqual:@"bluetooth_waiting"]) {
        [self setPhase:@"connecting" message:@"Mac’in Bluetooth servisi hazırlanıyor; henüz piyanoya bağlantı kurulmadı."];
    } else if ([kind isEqual:@"midi_discovery"]) {
        [self setPhase:@"connecting" message:@"Piyanoya Bluetooth bağlantısı kuruldu. MIDI hizmeti kontrol ediliyor…"];
    } else if ([kind isEqual:@"connecting"]) {
        [self setPhase:@"connecting" message:@"Yamaha CLP-835 bağlantısı kuruluyor…"];
    } else if ([kind isEqual:@"midi_initial_read"]) {
        [self setPhase:@"connecting" message:@"MIDI bağlantısı hazırlanıyor… macOS eşleştirme onayı sorarsa onayla."];
    } else if ([self.state[@"connected"] boolValue]) {
        NSString *key = [NSString stringWithFormat:@"%@:%@", event[@"channel"] ?: @1, event[@"note"]];
        if ([kind isEqual:@"note_on"] && [event[@"velocity"] intValue] > 0) {
            self.held[key] = event;
            self.state[@"note_count"] = @([self.state[@"note_count"] integerValue] + 1);
            self.state[@"last_note"] = event;
            [self publish:event];
        } else if ([kind isEqual:@"note_off"] || [kind isEqual:@"note_on"]) {
            [self.held removeObjectForKey:key]; [self publish:event];
        } else if ([kind isEqual:@"pedal"]) {
            if ([event[@"pedal"] isEqual:@"sustain"]) self.state[@"pedal"] = event;
            [self publish:event];
        } else if ([kind isEqual:@"control_change"] &&
                   ([event[@"controller"] intValue] == 120 || [event[@"controller"] intValue] == 123)) {
            for (NSString *heldKey in [self.held.allKeys copy]) {
                NSDictionary *note = self.held[heldKey];
                if ([note[@"channel"] isEqual:event[@"channel"]]) {
                    NSMutableDictionary *release = [note mutableCopy];
                    release[@"event"] = @"note_off"; release[@"velocity"] = @0;
                    [self.held removeObjectForKey:heldKey]; [self publish:release];
                }
            }
        }
    }
}

- (void)stopBluetooth {
    if (!self.bluetooth) return;
    [self setPhase:@"stopping" message:@"Bağlantı kapatılıyor…"];
    if (self.bluetooth.running) [self.bluetooth terminate];
}

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message
    replyHandler:(void (^)(id, NSString *))replyHandler {
    (void)controller;
    if (!message.frameInfo.mainFrame || ![message.frameInfo.request.URL.path isEqual:self.pageURL.path] ||
        ![message.body isKindOfClass:NSDictionary.class]) {
        replyHandler(nil, @"Unknown page"); return;
    }
    NSString *command = message.body[@"command"];
    if ([command isEqual:@"subscribe"]) {
        self.pageReady = YES;
        NSLog(@"PianoMan arayüzü hazır");
        replyHandler([self snapshot], nil);
    } else if ([command isEqual:@"update-state"]) {
        replyHandler([self.updates snapshot], nil);
    } else if ([command isEqual:@"update-check"]) {
        replyHandler(@{}, nil); [self.updates check:nil];

    } else if ([command isEqual:@"update-read"]) {
        [self.updates acknowledge]; replyHandler(@{}, nil);

    } else if ([command isEqual:@"connect"]) {
        [self startBluetooth]; replyHandler(@{}, nil);
    } else if ([command isEqual:@"disconnect"]) {
        [self stopBluetooth]; replyHandler(@{}, nil);
    } else if ([command isEqual:@"forget-device"]) {
        if (self.bluetooth) { replyHandler(nil,@"Önce mevcut bağlantının kapanmasını bekle."); return; }
        self.deviceUUID = nil;
        [NSUserDefaults.standardUserDefaults removeObjectForKey:@"BluetoothDeviceUUID"];
        [self.state removeObjectForKey:@"diagnostic"];
        [self setPhase:@"disconnected" message:@"PianoMan’in kayıtlı piyano kimliği temizlendi; yeniden arayabilirsin."];
        replyHandler(@{},nil);
    } else if ([@[@"output-start",@"output-stop",@"output-heartbeat"] containsObject:command]) {
        if (![self.state[@"connected"] boolValue]) { replyHandler(nil,@"Piyano bağlı değil."); return; }
        NSString *runtime = self.runtimeURL.path; NSDictionary *request = message.body;
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0), ^{
            NSError *error; NSDictionary *result = PianoBluetoothCommand(runtime, request, &error);
            dispatch_async(dispatch_get_main_queue(), ^{ replyHandler(result,error.localizedDescription ?: result[@"error"]); });
        });
    } else if ([command isEqual:@"fullscreen"]) {
        [self.window toggleFullScreen:nil]; replyHandler(@{}, nil);
    } else if ([command isEqual:@"unsubscribe"]) {
        self.pageReady = NO; replyHandler(@{}, nil);
    } else if ([command isEqual:@"page-error"]) {
        NSLog(@"PianoMan JavaScript: %@", message.body[@"message"]); replyHandler(@{}, nil);
    } else if ([command isEqual:@"lesson-state"]) {
        replyHandler([self.lessons snapshot], nil);
    } else if ([command isEqual:@"lesson-list"]) {
        replyHandler([self.lessons lessons], nil);
    } else if ([command isEqual:@"lesson-delete"]) {
        NSError *error; BOOL ok = [self.lessons deleteLesson:message.body[@"id"] error:&error];
        replyHandler(@{@"ok":@(ok)},error.localizedDescription);
    } else if ([command isEqual:@"lesson-load"]) {
        NSError *error; NSDictionary *lesson = [self.lessons lesson:message.body[@"id"] error:&error];
        replyHandler(lesson,error.localizedDescription);
    } else if ([command isEqual:@"lesson-begin"]) {
        NSError *error; NSDictionary *job = [self.lessons begin:message.body error:&error];
        replyHandler(job,error.localizedDescription);
    } else if ([command isEqual:@"lesson-chunk"]) {
        NSError *error; BOOL ok = [self.lessons append:message.body[@"data"] identifier:message.body[@"id"] error:&error];
        replyHandler(@{@"ok":@(ok)},error.localizedDescription);
    } else if ([command isEqual:@"lesson-start"]) {
        NSError *error; BOOL ok = [self.lessons start:message.body[@"id"] error:&error];
        replyHandler(@{@"ok":@(ok)},error.localizedDescription);
    } else if ([command isEqual:@"lesson-cancel"]) {
        [self.lessons cancel]; replyHandler(@{},nil);
    } else replyHandler(nil, @"Unknown command");
}

- (void)windowDidEnterFullScreen:(NSNotification *)notification {
    (void)notification; [self publish:@{@"event":@"fullscreen", @"active":@YES}];
}
- (void)windowDidExitFullScreen:(NSNotification *)notification {
    (void)notification; [self publish:@{@"event":@"fullscreen", @"active":@NO}];
}
- (BOOL)windowShouldClose:(NSWindow *)sender {
    (void)sender; [NSApp terminate:nil]; return NO;
}
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    (void)sender;
    if (self.uninstalling) [self.updates stop];
    self.quitting = YES;
    self.savingWorkspace = YES;
    [self.window saveFrameUsingName:@"PianoManMainWindow"];
    [self.webView callAsyncJavaScript:@"window.dispatchEvent(new Event('pianoman-save-state'));"
        arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld
        completionHandler:^(id result, NSError *error) {
            (void)result; (void)error;
            self.savingWorkspace = NO;
            [self finishTermination];
        }];
    [self stopBluetooth]; [self.lessons cancel]; return NSTerminateLater;
}
- (void)finishTermination {
    if (!self.quitting || self.savingWorkspace || self.bluetooth || self.lessons.running) return;
    if (self.uninstalling && ![self launchUninstaller]) {
        self.quitting = NO; self.uninstalling = NO;
        [NSApp replyToApplicationShouldTerminate:NO]; return;
    }
    [NSApp replyToApplicationShouldTerminate:YES];
}
- (void)uninstall:(id)sender {
    (void)sender;
    NSAlert *alert = [NSAlert new];
    alert.messageText = @"PianoMan kaldırılsın mı?";
    alert.informativeText = @"Uygulama, modeller, kayıtlı dersler ve PianoMan'in geçici verileri kalıcı olarak silinecek. Orijinal videolar ve dışarı aktardığın MIDI dosyaları korunacak.";
    [alert addButtonWithTitle:@"Vazgeç"]; [alert addButtonWithTitle:@"PianoMan’i kaldır"];
    [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
        if (response==NSAlertSecondButtonReturn) { self.uninstalling = YES; [NSApp terminate:nil]; }
    }];
}
- (BOOL)launchUninstaller {
    NSTask *helper = [NSTask new]; helper.executableURL = NSBundle.mainBundle.executableURL;
    helper.arguments = @[@"--uninstall",@(getpid()).stringValue];
    NSError *error;
    if (![helper launchAndReturnError:&error]) { self.uninstalling = NO; [self showLessonError:error]; return NO; }
    [NSUserDefaults.standardUserDefaults removePersistentDomainForName:@"com.pianoman.desktop"];
    return YES;
}
- (void)showLessonError:(NSError *)error {
    NSAlert *alert = [NSAlert new]; alert.messageText = @"PianoMan";
    alert.informativeText = error.localizedDescription ?: @"İşlem tamamlanamadı.";
    [alert beginSheetModalForWindow:self.window completionHandler:nil];
}
- (void)application:(NSApplication *)sender openFiles:(NSArray<NSString *> *)filenames {
    (void)sender;
    if (filenames.count!=1) { [NSApp replyToOpenOrPrint:NSApplicationDelegateReplyFailure]; return; }
    NSURL *url = [NSURL fileURLWithPath:filenames.firstObject];
    if (!self.lessons) self.pendingVideo = url;
    else {
        NSError *error;
        if (![self.lessons openVideo:url error:&error]) { [self showLessonError:error]; [NSApp replyToOpenOrPrint:NSApplicationDelegateReplyFailure]; return; }
    }
    [NSApp replyToOpenOrPrint:NSApplicationDelegateReplySuccess];
}
- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)visible {
    (void)sender; if (!visible) [self.window makeKeyAndOrderFront:nil]; return YES;
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    (void)webView;
    if (action.shouldPerformDownload) { decisionHandler(WKNavigationActionPolicyDownload); return; }
    if ([action.request.URL.path isEqual:self.pageURL.path] && action.request.URL.isFileURL) {
        decisionHandler(WKNavigationActionPolicyAllow); return;
    }
    decisionHandler(WKNavigationActionPolicyCancel);
}
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    (void)webView; (void)navigation;
    NSAlert *alert = [NSAlert new]; alert.messageText = @"PianoMan açılamadı";
    alert.informativeText = error.localizedDescription; [alert beginSheetModalForWindow:self.window completionHandler:nil];
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    self.pageReady = NO; [self stopBluetooth]; [webView reload];
}
- (void)webView:(WKWebView *)webView runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
    initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSArray<NSURL *> *))completionHandler {
    (void)webView; (void)frame;
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.canChooseDirectories = NO; panel.allowsMultipleSelection = parameters.allowsMultipleSelection;
    // Both imports use the standard WebKit file input. Each flow verifies its
    // own format after selection; the native panel must also admit videos.
    panel.allowedContentTypes = @[[UTType typeWithFilenameExtension:@"mid"],
        [UTType typeWithFilenameExtension:@"midi"], UTTypePDF, UTTypeMovie,
        [UTType typeWithFilenameExtension:@"webm"]];
    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
        completionHandler(result == NSModalResponseOK ? panel.URLs : nil);
    }];
}
- (void)webView:(WKWebView *)webView navigationAction:(WKNavigationAction *)action didBecomeDownload:(WKDownload *)download {
    (void)webView; (void)action; download.delegate = self; [self.downloads addObject:download];
}
- (void)download:(WKDownload *)download decideDestinationUsingResponse:(NSURLResponse *)response
    suggestedFilename:(NSString *)suggestedFilename completionHandler:(void (^)(NSURL *))completionHandler {
    (void)download; (void)response;
    NSSavePanel *panel = [NSSavePanel savePanel]; panel.nameFieldStringValue = suggestedFilename;
    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
        completionHandler(result == NSModalResponseOK ? panel.URL : nil);
    }];
}
- (void)downloadDidFinish:(WKDownload *)download { [self.downloads removeObject:download]; }
- (void)download:(WKDownload *)download didFailWithError:(NSError *)error resumeData:(NSData *)resumeData {
    (void)resumeData; [self.downloads removeObject:download];
    if (error.code == NSURLErrorCancelled) return;
    NSAlert *alert = [NSAlert new]; alert.messageText = @"Dosya kaydedilemedi";
    alert.informativeText = error.localizedDescription; [alert beginSheetModalForWindow:self.window completionHandler:nil];
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc==3 && strcmp(argv[1],"--uninstall")==0) {
            pid_t parent = (pid_t)atoi(argv[2]);
            while (parent>1 && kill(parent,0)==0) usleep(100000);
            NSURL *app = NSBundle.mainBundle.bundleURL;
            if (![NSBundle.mainBundle.bundleIdentifier isEqual:@"com.pianoman.desktop"] || ![app.pathExtension isEqual:@"app"]) return 1;
            NSFileManager *files = NSFileManager.defaultManager;
            NSURL *library = [files URLsForDirectory:NSLibraryDirectory inDomains:NSUserDomainMask].firstObject;
            NSMutableArray *paths = [NSMutableArray arrayWithObject:app];
            for (NSString *path in @[@"Application Support/PianoMan",@"Caches/com.pianoman.desktop",@"WebKit/com.pianoman.desktop",@"Saved Application State/com.pianoman.desktop.savedState",@"Preferences/com.pianoman.desktop.plist"])
                [paths addObject:[library URLByAppendingPathComponent:path]];
            NSMutableArray *failures = [NSMutableArray new];
            for (NSURL *path in paths) {
                if (![files fileExistsAtPath:path.path]) continue;
                NSError *error;
                if (![files removeItemAtURL:path error:&error]) [failures addObject:error.localizedDescription];
            }
            if (failures.count) {
                [NSApplication sharedApplication];
                NSAlert *alert = [NSAlert new]; alert.messageText = @"Bazı PianoMan dosyaları silinemedi";
                alert.informativeText = [failures componentsJoinedByString:@"\n"]; [alert runModal];
                return 1;
            }
            return 0;
        }
        if (argc > 1 && strcmp(argv[1], "--bluetooth") == 0) {
            pid_t parent = getppid();
            if (parent == 1) return 1;
            // App crashes also trigger the existing native BLE cleanup path.
            dispatch_source_t monitor = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, parent,
                DISPATCH_PROC_EXIT, dispatch_get_main_queue());
            dispatch_source_set_event_handler(monitor, ^{ kill(getpid(), SIGTERM); });
            dispatch_resume(monitor);
            int result = PianoBluetoothMain(argc - 1, argv + 1);
            dispatch_source_cancel(monitor);
            return result;
        }
        NSApplication *app = NSApplication.sharedApplication;
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        __attribute__((objc_precise_lifetime)) PianoApp *delegate = [PianoApp new];
        app.delegate = delegate;
        signal(SIGTERM,SIG_IGN);
        dispatch_source_t termination = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL,SIGTERM,0,dispatch_get_main_queue());
        dispatch_source_set_event_handler(termination, ^{ [app terminate:nil]; });
        dispatch_resume(termination);
        [app run];
        dispatch_source_cancel(termination);
    }
    return 0;
}
