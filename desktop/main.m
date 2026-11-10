#import "Localization.h"
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <signal.h>
#import <unistd.h>
#import "LessonService.h"
#import "UpdateController.h"
#import "CustomizeService.h"
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
@property (nonatomic) BOOL pageReady;
@property (nonatomic) BOOL quitting;
@property (nonatomic) BOOL savingWorkspace;
@property (nonatomic, strong) LessonService *lessons;
@property (nonatomic, strong) NSURL *pendingVideo;
@property (nonatomic) BOOL uninstalling;
@property (nonatomic, strong) UpdateController *updates;
@property (nonatomic, strong) CustomizeService *customize;
// The Customize panel is a separate web view beside the page, so a version changed
// by ChatGPT has no way to reach it: not its DOM, its keys, or its commands.
@property (nonatomic, strong) WKWebView *panelView;
@property (nonatomic, strong) WKContentWorld *frameWorld;
@property (nonatomic) BOOL panelOpen;
@property (nonatomic) CGFloat toggleWidth;
@property (nonatomic, strong) NSDictionary *pendingLesson;
@property (nonatomic, copy) NSArray<WKUserScript *> *pageScripts;
@property (nonatomic) BOOL reloadPending;
@property (nonatomic, strong) dispatch_source_t developmentSignal;
#ifdef PIANO_CAPTURE
@property (nonatomic, copy) NSString *captureDirectory;
@property (nonatomic, copy) NSString *captureLanguage;
@property (nonatomic) BOOL captureStarted;
#endif
@end

@implementation PianoApp

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
#ifdef PIANO_CAPTURE
    PianoSetLanguage(self.captureLanguage);
#endif
    self.state = [@{@"phase":@"disconnected", @"connected":@NO, @"message":PianoText(@"Piyano bağlı değil"),
        @"device":@"", @"uuid":NSNull.null, @"devices":@[], @"input_capable":@NO, @"note_count":@0, @"last_note":NSNull.null, @"pedal":NSNull.null, @"active":@NO} mutableCopy];
    self.held = [NSMutableDictionary new];
    self.downloads = [NSMutableSet new];
    self.state[@"remembered_device"] = [NSUserDefaults.standardUserDefaults stringForKey:@"BluetoothDeviceUUID"] ?: (id)NSNull.null;
    NSURL *support = [[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory
        inDomains:NSUserDomainMask].firstObject;
#ifdef PIANO_CAPTURE
    support = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:@"Rach3Capture"]];
#endif
    self.runtimeURL = [support URLByAppendingPathComponent:@"Rach3/Bluetooth" isDirectory:YES];
    self.lessons = [[LessonService alloc] initWithEngine:[NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"Engine"]
        support:[support URLByAppendingPathComponent:@"Rach3" isDirectory:YES]
        tools:[support URLByAppendingPathComponent:@"Rach3/Tools/1" isDirectory:YES]];
    __weak PianoApp *weakSelf = self;
    self.lessons.onEvent = ^(NSDictionary *event) { [weakSelf publish:event]; };
    self.lessons.onIdle = ^{ dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf finishTermination]; }); };
    // The page is served from the design on screen: the original files in the
    // bundle, or a copy the person changed with ChatGPT (CustomizeService).
    NSURL *codex = [NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"Codex"];
    NSString *developmentCodex = NSProcessInfo.processInfo.environment[@"RACH3_CODEX_ROOT"];
    if (developmentCodex.length) codex = [NSURL fileURLWithPath:developmentCodex];
    self.customize = [[CustomizeService alloc] initWithSource:[NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"Source"]
        codex:codex support:[support URLByAppendingPathComponent:@"Rach3" isDirectory:YES]
        version:[NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"]];
    self.customize.onEvent = ^(NSDictionary *event) { [weakSelf publishCustomize:event]; };
    self.customize.onReload = ^{ [weakSelf reloadDesign]; };
    self.customize.previewBridge = ^id(NSDictionary *body) { return [weakSelf previewReply:body]; };
    // Opens a lesson ChatGPT made, once the version saved with it is on screen.
    self.customize.onLessonChanged = ^(NSDictionary *lesson) {
        weakSelf.pendingLesson = @{@"event":@"lesson-progress", @"phase":@"complete", @"progress":@1, @"message":@"",
                                   @"id":lesson[@"id"], @"title":lesson[@"title"] ?: @"", @"noteCount":lesson[@"noteCount"] ?: @0};
        if (weakSelf.pageReady && !weakSelf.reloadPending) [weakSelf openPendingLesson];
    };
    self.pageURL = self.customize.pageURL;

    WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
    [configuration setURLSchemeHandler:self.customize forURLScheme:CustomizeService.scheme];
    self.frameWorld = [WKContentWorld worldWithName:@"rach3-frame"];
    configuration.websiteDataStore = WKWebsiteDataStore.defaultDataStore;
#ifdef PIANO_CAPTURE
    configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
#endif
    [configuration.userContentController addScriptMessageHandlerWithReply:self
        contentWorld:WKContentWorld.pageWorld name:@"rach3"];
    WKUserScript *errors = [[WKUserScript alloc] initWithSource:CustomizeService.errorScript
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES];
    NSMutableArray *pageScripts = [@[errors] mutableCopy];
#ifndef PIANO_CAPTURE
    // The page's header is the title bar: it leaves room for the window buttons.
    [pageScripts addObject:[[WKUserScript alloc] initWithSource:@"document.documentElement.dataset.windowControls='mac';"
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
#endif
    self.pageScripts = pageScripts;
    for (WKUserScript *script in pageScripts) [configuration.userContentController addUserScript:script];
    self.webView = [[WKWebView alloc] initWithFrame:NSZeroRect configuration:configuration];
    self.webView.navigationDelegate = self;
    self.webView.UIDelegate = self;
    self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

    NSRect visible = NSScreen.mainScreen.visibleFrame;
    NSRect frame = NSMakeRect(0, 0, MIN(1340, visible.size.width), MIN(920, visible.size.height));
    self.window = [[NSWindow alloc] initWithContentRect:frame
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    self.window.title = @"rach3";
#ifndef PIANO_CAPTURE
    // One bar at the top, like other Mac apps: the page runs up under a see-through title
    // bar and the window buttons sit inside the page's own header.
    self.window.styleMask |= NSWindowStyleMaskFullSizeContentView;
    self.window.titlebarAppearsTransparent = YES;
    self.window.titleVisibility = NSWindowTitleHidden;
#endif
    self.window.delegate = self;
    self.window.releasedWhenClosed = NO;
    self.window.minSize = NSMakeSize(820, 620);
    self.window.collectionBehavior = NSWindowCollectionBehaviorFullScreenPrimary;
    self.window.backgroundColor = [NSColor colorWithSRGBRed:.075 green:.08 blue:.09 alpha:1];
    self.window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    NSView *content = [[NSView alloc] initWithFrame:frame];
    content.autoresizesSubviews = YES;
    self.webView.frame = content.bounds;
    [content addSubview:self.webView];
    [self makePanel];
    if (self.panelView) [content addSubview:self.panelView];
    self.window.contentView = content;
    [self layoutCustomize];
    if (![self.window setFrameUsingName:@"Rach3MainWindow"]) [self.window center];
    [self.window setFrameAutosaveName:@"Rach3MainWindow"];
    self.updates = [UpdateController new];
    self.updates.onChange = ^(NSDictionary *event) { [weakSelf publish:event]; };
    [self makeMenus];
#ifndef PIANO_CAPTURE
    [self.updates start];
#endif
    [self.webView loadRequest:[NSURLRequest requestWithURL:self.pageURL]];
    [self.window makeKeyAndOrderFront:nil];
    [self placeWindowButtons];
    [NSApp activateIgnoringOtherApps:YES];
    [self startDevelopmentHook];
    self.customize.previewSize = self.webView.bounds.size;
    if (self.pendingVideo) {
        NSError *error;
        if (![self.lessons openVideo:self.pendingVideo error:&error]) [self showLessonError:error];
        self.pendingVideo = nil;
    }
}

- (void)makeMenus {
    NSMenu *bar = [NSMenu new];
    NSMenuItem *appItem = [NSMenuItem new];
    NSMenu *app = [[NSMenu alloc] initWithTitle:@"rach3"];
    [app addItemWithTitle:PianoText(@"rach3 Hakkında") action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
    NSMenuItem *updates = [app addItemWithTitle:PianoText(@"Güncellemeleri denetle…") action:@selector(check:) keyEquivalent:@""];
    updates.target = self.updates;
    [app addItem:NSMenuItem.separatorItem];
    [app addItemWithTitle:PianoText(@"rach3’ü Gizle") action:@selector(hide:) keyEquivalent:@"h"];
    NSMenuItem *uninstall = [app addItemWithTitle:PianoText(@"rach3’ü kaldır…") action:@selector(uninstall:) keyEquivalent:@""];
    uninstall.target = self;
    [app addItem:NSMenuItem.separatorItem];
    NSMenuItem *customize = [app addItemWithTitle:PianoText(@"rach3’ü değiştir…") action:@selector(toggleCustomize:) keyEquivalent:@"k"];
    customize.target = self;
    NSMenuItem *original = [app addItemWithTitle:PianoText(@"Orijinal rach3’ü etkinleştir") action:@selector(restoreOriginalDesign:) keyEquivalent:@""];
    original.target = self;
    [app addItem:NSMenuItem.separatorItem];
    [app addItemWithTitle:PianoText(@"rach3’ten Çık") action:@selector(terminate:) keyEquivalent:@"q"];
    appItem.submenu = app; [bar addItem:appItem];
    NSMenuItem *editItem = [NSMenuItem new];
    NSMenu *edit = [[NSMenu alloc] initWithTitle:PianoText(@"Düzenle")];
    [edit addItemWithTitle:PianoText(@"Kopyala") action:@selector(copy:) keyEquivalent:@"c"];
    [edit addItemWithTitle:PianoText(@"Yapıştır") action:@selector(paste:) keyEquivalent:@"v"];
    [edit addItemWithTitle:PianoText(@"Tümünü Seç") action:@selector(selectAll:) keyEquivalent:@"a"];
    editItem.submenu = edit; [bar addItem:editItem];
    NSMenuItem *viewItem = [NSMenuItem new];
    NSMenu *view = [[NSMenu alloc] initWithTitle:PianoText(@"Görünüm")];
    NSMenuItem *full = [view addItemWithTitle:PianoText(@"Tam Ekran") action:@selector(toggleFullScreen:) keyEquivalent:@"f"];
    full.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagControl;
    full.target = self.window;
    viewItem.submenu = view; [bar addItem:viewItem];
    NSApp.mainMenu = bar;
}

#ifdef PIANO_CAPTURE
// Development-only export of the real app renderer. Never compiled into releases.
- (void)captureView:(NSString *)name completion:(void (^)(void))completion {
    WKSnapshotConfiguration *configuration = [WKSnapshotConfiguration new];
    configuration.snapshotWidth = @1600;
    [self.webView takeSnapshotWithConfiguration:configuration completionHandler:^(NSImage *image, NSError *error) {
        if (error) { NSLog(@"Capture failed: %@",error); exit(1); }
        NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithData:image.TIFFRepresentation];
        NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        NSString *path = [self.captureDirectory stringByAppendingPathComponent:name];
        if (![png writeToFile:path atomically:YES]) { NSLog(@"Capture could not be saved"); exit(1); }
        NSLog(@"Saved application screenshot: %@",name); completion();
    }];
}
- (void)captureWhenReady:(NSUInteger)attempt {
    [self.webView callAsyncJavaScript:@"return window.PianoI18n?.language === language && !!document.querySelector('#sheet-paper svg') && !document.getElementById('sheet-paper').hidden;"
        arguments:@{@"language":self.captureLanguage} inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id ready,NSError *error) {
        if (error || ![ready boolValue]) {
            if (attempt == 5) {
                [self.webView evaluateJavaScript:@"document.getElementById('sheet-loading-text').textContent" completionHandler:^(id value,NSError *diagnosticError) {
                    NSLog(@"Capture readiness: %@ %@",value,diagnosticError);
                }];
            }
            if (attempt >= 30) { NSLog(@"Application score was not ready for capture: %@",error); exit(1); }
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC),dispatch_get_main_queue(),^{ [self captureWhenReady:attempt+1]; });
            return;
        }
        // Plain falling bars on the website: no staff badges, no note names.
        [self.webView callAsyncJavaScript:@"document.getElementById('tab-practice').click(); const staff=document.getElementById('staff'); staff.checked=false; staff.dispatchEvent(new Event('change',{bubbles:true})); const names=document.getElementById('notation'); names.value='none'; names.dispatchEvent(new Event('change',{bubbles:true})); const seek=document.getElementById('seek'); seek.value=25; seek.dispatchEvent(new Event('input',{bubbles:true}));"
            arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id result,NSError *seekError) {
            (void)result;
            if (seekError) { NSLog(@"Capture positioning failed: %@",seekError); exit(1); }
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW,2*NSEC_PER_SEC),dispatch_get_main_queue(),^{
                [self captureView:@"practice.png" completion:^{
                    [self.webView callAsyncJavaScript:@"document.getElementById('tab-create').click();"
                        arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id value,NSError *tabError) {
                        (void)value;
                        if (tabError) { NSLog(@"Capture tab failed: %@",tabError); exit(1); }
                        dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC),dispatch_get_main_queue(),^{
                            [self captureView:@"create-lesson.png" completion:^{ [NSApp terminate:nil]; }];
                        });
                    }];
                }];
            });
        }];
    }];
}
#endif

- (NSDictionary *)snapshot {
    return @{@"event":@"snapshot", @"language":PianoLanguage(), @"status":PianoLocalizedStatus(self.state), @"held":self.held.allValues,
        @"fullscreen":@((self.window.styleMask & NSWindowStyleMaskFullScreen) != 0)};
}

- (void)publishCustomize:(NSDictionary *)event {
    if (self.quitting) return;
    [self.panelView callAsyncJavaScript:@"window.rach3Customize?.receive(event);" arguments:@{@"event":event}
        inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:nil];
}

- (void)openPendingLesson {
    NSDictionary *event = self.pendingLesson;
    self.pendingLesson = nil;
    if (event) [self publish:event];
}

- (void)makePanel {
    NSString *script = [NSString stringWithContentsOfURL:[NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"Customize/panel.js"]
        encoding:NSUTF8StringEncoding error:NULL];
    if (!script) return;
    WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
    configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
    [configuration.userContentController addScriptMessageHandlerWithReply:self contentWorld:WKContentWorld.pageWorld name:@"customize"];
    [configuration.userContentController addUserScript:[[WKUserScript alloc] initWithSource:script
        injectionTime:WKUserScriptInjectionTimeAtDocumentEnd forMainFrameOnly:YES]];
    self.panelView = [[WKWebView alloc] initWithFrame:NSZeroRect configuration:configuration];
    self.panelView.navigationDelegate = self;
    [self.panelView setValue:@NO forKey:@"drawsBackground"];
    self.toggleWidth = 110;
    [self.panelView loadHTMLString:@"<!doctype html><html><head><meta charset=\"utf-8\"><style>html,body{margin:0;background:transparent;overflow:hidden}</style></head><body></body></html>"
        baseURL:nil];
}

// Open, the panel takes the right side of the window and the page gets the rest.
// Closed, only its button shows, at the end of the page's header.
- (void)layoutCustomize {
    if (!self.panelView) return;
    NSRect bounds = self.window.contentView.bounds;
    CGFloat width = NSWidth(bounds), height = NSHeight(bounds);
    if (self.panelOpen) {
        CGFloat panel = MIN(400, MAX(300, width - 480));
        self.webView.frame = NSMakeRect(0, 0, width - panel, height);
        self.panelView.frame = NSMakeRect(width - panel, 0, panel, height);
        self.panelView.autoresizingMask = NSViewMinXMargin | NSViewHeightSizable;
    } else {
        CGFloat button = self.toggleWidth + 28;
        self.webView.frame = bounds;
        self.panelView.frame = NSMakeRect(width - button, height - 48, button, 48);
        self.panelView.autoresizingMask = NSViewMinXMargin | NSViewMinYMargin;
    }
    self.customize.previewSize = self.webView.bounds.size;
    [self makeRoomForToggle];
}

// Keeps the end of the page's header clear for the button while the panel is closed.
- (void)makeRoomForToggle {
    if (!self.pageReady || !self.panelView) return;
    CGFloat room = self.panelOpen ? 0 : self.toggleWidth + 28;
    [self.webView callAsyncJavaScript:@"let style = document.getElementById('rach3-room');"
        "if (!style) { style = document.createElement('style'); style.id = 'rach3-room'; document.head.appendChild(style); }"
        "style.textContent = room ? `.app-bar { padding-right: ${room}px !important; }` : '';"
        arguments:@{@"room":@(room)} inFrame:nil inContentWorld:self.frameWorld completionHandler:nil];
}

// Shows the design that just became active. Waits while a lesson video is being handed over.
- (void)reloadDesign {
    if (self.reloadPending) return;
    self.reloadPending = YES;
    [self.webView callAsyncJavaScript:@"return document.documentElement.dataset.lessonPhase === 'upload';" arguments:@{}
        inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id busy, NSError *error) {
            (void)error;
            if ([busy boolValue]) {
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{ self.reloadPending = NO; [self reloadDesign]; });
                return;
            }
            [self.webView callAsyncJavaScript:@"window.dispatchEvent(new Event('rach3-save-state'));" arguments:@{}
                inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id result, NSError *failure) {
                    (void)result; (void)failure;
                    NSURL *next = self.customize.pageURL;
                    if ([next.host isEqual:self.pageURL.host] || ![self.customize needsSeed:next.host]) { [self loadPage:next seed:nil]; return; }
                    // First visit to this branch: it starts with this page's settings.
                    [self.webView callAsyncJavaScript:@"return JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])));"
                        arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id stored, NSError *readError) {
                            (void)readError;
                            [self loadPage:next seed:[stored isKindOfClass:NSString.class] ? stored : @"{}"];
                        }];
                }];
        }];
}

- (void)loadPage:(NSURL *)url seed:(NSString *)seed {
    WKUserContentController *controller = self.webView.configuration.userContentController;
    [controller removeAllUserScripts];
    for (WKUserScript *script in self.pageScripts) [controller addUserScript:script];
    if (seed) {
        NSData *json = [NSJSONSerialization dataWithJSONObject:url.host options:NSJSONWritingFragmentsAllowed error:NULL];
        NSString *host = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
        NSDictionary *parsed = [NSJSONSerialization JSONObjectWithData:[seed dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
        NSData *values = [NSJSONSerialization dataWithJSONObject:[parsed isKindOfClass:NSDictionary.class] ? parsed : @{} options:0 error:NULL];
        NSString *source = [NSString stringWithFormat:@"(() => { if (location.host !== %@) return; try {"
            " if (localStorage.getItem('rach3.seeded')) return;"
            " for (const [key, value] of Object.entries(%@)) if (typeof value === 'string') localStorage.setItem(key, value);"
            " localStorage.setItem('rach3.seeded', '1'); } catch {} })();", host,
            [[NSString alloc] initWithData:values encoding:NSUTF8StringEncoding]];
        [controller addUserScript:[[WKUserScript alloc] initWithSource:source injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    }
    self.reloadPending = NO; self.pageReady = NO;
    self.pageURL = url;
    [self.webView loadRequest:[NSURLRequest requestWithURL:url]];
}

// Development only: with RACH3_DEV_DIR set by whoever launched the app, SIGUSR1 runs
// command.json ({"world":"page"|"customize","js":"…","snapshot":"name.png"}) and
// writes result.json and the snapshot there. Without the variable nothing listens.
- (void)startDevelopmentHook {
    NSString *folder = NSProcessInfo.processInfo.environment[@"RACH3_DEV_DIR"];
    if (!folder.length) return;
    signal(SIGUSR1, SIG_IGN);
    self.developmentSignal = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGUSR1, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(self.developmentSignal, ^{
        NSData *data = [NSData dataWithContentsOfFile:[folder stringByAppendingPathComponent:@"command.json"]];
        NSDictionary *command = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
        BOOL inPanel = [command[@"world"] isEqual:@"customize"];
        WKWebView *view = inPanel ? self.panelView : self.webView;
        void (^finish)(id, NSString *) = ^(id value, NSString *failure) {
            NSDictionary *result = @{@"value":value ?: NSNull.null, @"error":failure ?: NSNull.null};
            NSData *json = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingFragmentsAllowed error:NULL]
                ?: [NSJSONSerialization dataWithJSONObject:@{@"value":[value description] ?: @"", @"error":failure ?: NSNull.null} options:0 error:NULL];
            [json writeToFile:[folder stringByAppendingPathComponent:@"result.json"] atomically:YES];
        };
        [view callAsyncJavaScript:command[@"js"] ?: @"return null;" arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld
            completionHandler:^(id value, NSError *error) {
            NSString *name = command[@"snapshot"];
            if (![name isKindOfClass:NSString.class]) { finish(value, error.localizedDescription); return; }
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.6 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
                [view takeSnapshotWithConfiguration:nil completionHandler:^(NSImage *image, NSError *snapshotError) {
                    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithData:image.TIFFRepresentation];
                    [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:[folder stringByAppendingPathComponent:name] atomically:YES];
                    finish(value, error.localizedDescription ?: snapshotError.localizedDescription);
                }];
            });
        }];
    });
    dispatch_resume(self.developmentSignal);
}

// What the hidden preview may ask the native side: reading only.
- (id)previewReply:(NSDictionary *)body {
    self.customize.previewSize = self.webView.bounds.size;
    NSString *command = body[@"command"];
    if ([command isEqual:@"get-language"]) return @{@"language":PianoLanguage()};
    if ([command isEqual:@"subscribe"]) return [self snapshot];
    if ([command isEqual:@"update-state"]) return [self.updates snapshot];
    if ([command isEqual:@"lesson-state"]) return [self.lessons snapshot];
    if ([command isEqual:@"lesson-tools"]) return [self.lessons tools];
    if ([command isEqual:@"lesson-list"]) return [self.customize lessonsForPage:YES];
    if ([command isEqual:@"lesson-load"]) return [self.customize lessonForPage:body[@"id"] preview:YES];
    return @{};
}

- (void)restoreOriginalDesign:(id)sender { (void)sender; [self.customize restoreOriginal]; }
- (void)toggleCustomize:(id)sender {
    (void)sender;
    [self.panelView callAsyncJavaScript:@"window.rach3Customize?.toggle();" arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:nil];
}

- (void)publish:(NSDictionary *)event {
    if (!self.pageReady || self.quitting) return;
    NSMutableDictionary *localized = [PianoLocalizedStatus(event) mutableCopy];
    if (event[@"status"]) localized[@"status"] = PianoLocalizedStatus(event[@"status"]);
    [self.webView callAsyncJavaScript:@"window.dispatchEvent(new CustomEvent('rach3-native-event', {detail: event}));"
        arguments:@{@"event":localized} inFrame:nil inContentWorld:WKContentWorld.pageWorld
        completionHandler:^(id result, NSError *error) {
            (void)result;
            if (error) NSLog(@"rach3 arayüz aktarımı: %@", error.localizedDescription);
        }];
}

- (void)setPhase:(NSString *)phase message:(NSString *)message {
    BOOL connected = [phase isEqualToString:@"connected"];
    [self.state addEntriesFromDictionary:@{@"phase":phase, @"connected":@(connected), @"message":message}];
    if (!connected) { [self.held removeAllObjects]; self.state[@"pedal"] = NSNull.null; self.state[@"output_capable"] = @NO; self.state[@"input_capable"] = @NO; }
    [self publish:@{@"event":@"status", @"status":[self.state copy]}];
}

- (void)startBluetooth:(NSString *)identifier {
    if (self.bluetooth || self.quitting) return;
    self.state[@"active"] = @YES;
    [self.state removeObjectForKey:@"diagnostic"];
    self.state[@"note_count"] = @0;
    self.state[@"last_note"] = NSNull.null;
    self.state[@"uuid"] = identifier ?: (id)NSNull.null;
    self.state[@"device"] = @""; self.state[@"devices"] = @[];
    self.state[@"browsing"] = @(!identifier);
    [self setPhase:@"starting" message:PianoText(@"Mac’in Bluetooth erişimi kontrol ediliyor… macOS izin sorarsa onayla.")];
    NSTask *task = [NSTask new];
    task.executableURL = NSBundle.mainBundle.executableURL;
    NSMutableArray *args = [@[@"--bluetooth", self.runtimeURL.path, @"start", @"--timeout", @"45", @"--duration", @"0"] mutableCopy];
    if (identifier.length) [args addObjectsFromArray:@[@"--uuid", identifier]];
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
                    [owner setPhase:@"error" message:PianoText(@"Bluetooth bağlantı servisi kapandı.")];
                }
                else [owner setPhase:@"disconnected" message:PianoText(@"Piyano bağlantısı kapalı")];
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
        [self setPhase:@"error" message:PianoText(@"Bluetooth bağlantısı tamamlanamadı.")]; return;
    }
    if ([kind isEqual:@"error"]) {
        if (!self.state[@"diagnostic"]) self.state[@"diagnostic"] = @{@"code":@"service_failed",
            @"detail":event[@"message"] ?: @"", @"stage":event[@"operation"] ?: @"", @"osCode":event[@"code"] ?: NSNull.null};
        [self setPhase:@"error" message:event[@"message"] ?: PianoText(@"Bluetooth bağlantısında hata oluştu")];
    } else if ([kind isEqual:@"stopped"]) {
        if (![event[@"own_connection_closed"] boolValue]) {
            self.state[@"diagnostic"] = @{@"code":@"disconnect_unconfirmed"};
            [self setPhase:@"error" message:PianoText(@"macOS bağlantının kapandığını doğrulamadı.")];
        }
    } else if ([self.state[@"phase"] isEqual:@"stopping"]) {
        return;
    } else if ([kind isEqual:@"ready"]) {
        [self.state removeObjectForKey:@"diagnostic"];
        self.state[@"output_capable"] = event[@"output_capable"] ?: @NO;
        self.state[@"uuid"] = event[@"uuid"];
        self.state[@"device"] = event[@"name"] ?: @"Bluetooth MIDI";
        self.state[@"input_capable"] = event[@"input_capable"] ?: @YES;
        [self setPhase:@"connected" message:PianoText(@"MIDI bağlantısı hazır")];
    } else if ([kind isEqual:@"discovered"]) {
        NSMutableArray *devices = [self.state[@"devices"] mutableCopy];
        NSIndexSet *old = [devices indexesOfObjectsPassingTest:^BOOL(NSDictionary *device, NSUInteger index, BOOL *stop) {
            (void)index; (void)stop; return [device[@"uuid"] isEqual:event[@"uuid"]];
        }];
        [devices removeObjectsAtIndexes:old]; [devices addObject:event];
        self.state[@"devices"] = [devices copy];
        [self publish:@{@"event":@"status", @"status":[self.state copy]}];
    } else if ([kind isEqual:@"scan_complete"]) {
        [self setPhase:@"idle" message:PianoText(@"Tarama tamamlandı. Listeden bir piyano seç veya yeniden tara.")];
    } else if ([kind isEqual:@"connection_timeout"]) {
        [self setPhase:@"error" message:PianoText(@"Piyanoya ulaşılamadı. Piyanonun açık ve Bluetooth’un etkin olduğunu kontrol et.")];
    } else if ([kind isEqual:@"disconnected"]) {
        [self setPhase:@"disconnected" message:PianoText(@"Piyano bağlantısı kesildi")];
    } else if ([kind isEqual:@"scanning"]) {
        self.state[@"devices"] = @[]; self.state[@"browsing"] = event[@"browsing"] ?: @NO;
        [self setPhase:[self.state[@"browsing"] boolValue] ? @"scanning" : @"connecting"
            message:PianoText([self.state[@"browsing"] boolValue] ? @"Yakındaki Bluetooth MIDI cihazları aranıyor…" : @"Seçilen piyano aranıyor…")];
    } else if ([kind isEqual:@"bluetooth_waiting"]) {
        [self setPhase:@"starting" message:PianoText(@"Mac’in Bluetooth servisi hazırlanıyor; henüz piyanoya bağlantı kurulmadı.")];
    } else if ([kind isEqual:@"midi_discovery"]) {
        [self setPhase:@"connecting" message:PianoText(@"Piyanoya Bluetooth bağlantısı kuruldu. MIDI hizmeti kontrol ediliyor…")];
    } else if ([kind isEqual:@"connecting"]) {
        self.state[@"uuid"] = event[@"uuid"]; self.state[@"device"] = event[@"name"];
        self.state[@"browsing"] = @NO;
        [self setPhase:@"connecting" message:PianoText(@"Seçilen piyanoya bağlanılıyor…")];
    } else if ([kind isEqual:@"midi_initial_read"]) {
        [self setPhase:@"connecting" message:PianoText(@"MIDI bağlantısı hazırlanıyor… macOS eşleştirme onayı sorarsa onayla.")];
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
    [self setPhase:@"stopping" message:PianoText(@"Bağlantı kapatılıyor…")];
    if (self.bluetooth.running) [self.bluetooth terminate];
}

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message
    replyHandler:(void (^)(id, NSString *))replyHandler {
    (void)controller;
    if (message.webView == self.panelView) {
        if (!message.frameInfo.mainFrame || ![message.name isEqual:@"customize"] || ![message.body isKindOfClass:NSDictionary.class]) {
            replyHandler(nil, @"Unknown page"); return;
        }
        if ([message.body[@"action"] isEqual:@"panel"]) {
            BOOL open = [message.body[@"open"] boolValue];
            self.panelOpen = open;
            self.toggleWidth = MAX(60, MIN(240, [message.body[@"toggle"] doubleValue]));
            [self layoutCustomize];
            [self.window makeFirstResponder:open ? self.panelView : self.webView];
        }
        [self.customize handle:message.body reply:replyHandler]; return;
    }
    NSURL *origin = message.frameInfo.request.URL;
    if (!message.frameInfo.mainFrame || ![message.name isEqual:@"rach3"] || ![origin.scheme isEqual:self.pageURL.scheme] ||
        ![origin.host isEqual:self.pageURL.host] || ![message.body isKindOfClass:NSDictionary.class]) {
        replyHandler(nil, @"Unknown page"); return;
    }
    NSString *command = message.body[@"command"];
    if ([command isEqual:@"get-language"]) {
        replyHandler(@{@"language":PianoLanguage()}, nil);
    } else if ([command isEqual:@"set-language"]) {
        NSString *language = message.body[@"language"];
        if (![@[@"en", @"tr"] containsObject:language]) {
            replyHandler(nil, PianoText(@"Desteklenmeyen dil.")); return;
        }
        PianoSetLanguage(language);
        [self makeMenus];
        replyHandler(@{@"language":PianoLanguage()}, nil);
        [self publish:@{@"event":@"language", @"language":PianoLanguage()}];
        [self publish:[self snapshot]];
        [self publish:[self.updates snapshot]];
        [self publish:[self.lessons snapshot]];
        [self.customize publishState];
    } else if ([command isEqual:@"subscribe"]) {
        self.pageReady = YES;
        NSLog(@"rach3 arayüzü hazır");
        [self makeRoomForToggle];
        [self.customize markSeeded:self.pageURL.host];
        if (self.pendingLesson) dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.8 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ [self openPendingLesson]; });
        replyHandler([self snapshot], nil);
#ifdef PIANO_CAPTURE
        if (!self.captureStarted) { self.captureStarted = YES; [self captureWhenReady:0]; }
#endif
    } else if ([command isEqual:@"update-state"]) {
        replyHandler([self.updates snapshot], nil);
    } else if ([command isEqual:@"update-check"]) {
        replyHandler(@{}, nil); [self.updates check:nil];

    } else if ([command isEqual:@"update-read"]) {
        [self.updates acknowledge]; replyHandler(@{}, nil);

    } else if ([command isEqual:@"connect"] || [command isEqual:@"scan"]) {
        NSString *identifier = nil;
        if ([command isEqual:@"connect"]) {
            id raw = message.body[@"uuid"];
            identifier = [raw isKindOfClass:NSString.class] ? [[NSUUID alloc] initWithUUIDString:raw].UUIDString : nil;
            if (!identifier) { replyHandler(nil,PianoText(@"Listeden bir MIDI cihazı seç.")); return; }
        }
        if (!self.bluetooth) { [self startBluetooth:identifier]; replyHandler(@{}, nil); return; }
        if (![@[@"scanning",@"idle"] containsObject:self.state[@"phase"]]) {
            replyHandler(nil,PianoText(@"Önce mevcut bağlantıyı kes.")); return;
        }
        NSDictionary *request = identifier ? @{@"command":@"connect",@"uuid":identifier} : @{@"command":@"scan"};
        NSString *runtime = self.runtimeURL.path;
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0), ^{
            NSError *error = nil; NSDictionary *result = PianoBluetoothCommand(runtime, request, &error);
            dispatch_async(dispatch_get_main_queue(), ^{ replyHandler(result,PianoText(error.localizedDescription ?: result[@"error"])); });
        });
    } else if ([command isEqual:@"disconnect"]) {
        [self stopBluetooth]; replyHandler(@{}, nil);
    } else if ([@[@"output-start",@"output-stop",@"output-heartbeat"] containsObject:command]) {
        if (![self.state[@"connected"] boolValue]) { replyHandler(nil,PianoText(@"Piyano bağlı değil.")); return; }
        NSString *runtime = self.runtimeURL.path; NSDictionary *request = message.body;
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0), ^{
            NSError *error; NSDictionary *result = PianoBluetoothCommand(runtime, request, &error);
            dispatch_async(dispatch_get_main_queue(), ^{ replyHandler(result,PianoText(error.localizedDescription ?: result[@"error"])); });
        });
    } else if ([command isEqual:@"drag-window"]) {
        // a press on an empty part of the header moves the window, as a title bar does
        NSEvent *event = NSApp.currentEvent;
        if (event.type == NSEventTypeLeftMouseDown || event.type == NSEventTypeLeftMouseDragged)
            [self.window performWindowDragWithEvent:event];
        replyHandler(@{}, nil);
    } else if ([command isEqual:@"title-double-click"]) {
        NSString *action = [NSUserDefaults.standardUserDefaults stringForKey:@"AppleActionOnDoubleClick"];
        if ([action isEqual:@"Minimize"]) [self.window performMiniaturize:nil];
        else if (![action isEqual:@"None"]) [self.window performZoom:nil];
        replyHandler(@{}, nil);
    } else if ([command isEqual:@"fullscreen"]) {
        [self.window toggleFullScreen:nil]; replyHandler(@{}, nil);
    } else if ([command isEqual:@"unsubscribe"]) {
        self.pageReady = NO; replyHandler(@{}, nil);
    } else if ([command isEqual:@"page-error"]) {
        NSLog(@"rach3 JavaScript: %@", message.body[@"message"]); replyHandler(@{}, nil);
        [self.customize pageError:message.body];
    } else if ([command isEqual:@"lesson-state"]) {
        replyHandler([self.lessons snapshot], nil);
    } else if ([command isEqual:@"lesson-tools"]) {
        replyHandler([self.lessons tools], nil);
    } else if ([command isEqual:@"lesson-list"]) {
        replyHandler([self.customize lessonsForPage:NO], nil);
    } else if ([command isEqual:@"lesson-delete"]) {
        // Changed code may run on this page, so it can delete only what is visible here,
        // and the person's own lessons only from the original rach3.
        BOOL personal = NO;
        NSString *refusal = [self.customize deleteLessonForPage:message.body[@"id"] personal:&personal];
        if (refusal) { replyHandler(nil, [refusal isEqual:@"original-only"] ? PianoText(@"Kendi derslerini orijinal rach3’ten silebilirsin.") : PianoText(@"Bu ders burada yok.")); return; }
        if (!personal) { replyHandler(@{}, nil); return; }
        NSError *error; BOOL ok = [self.lessons deleteLesson:message.body[@"id"] error:&error];
        replyHandler(@{@"ok":@(ok)},error.localizedDescription);
    } else if ([command isEqual:@"lesson-load"]) {
        NSDictionary *lesson = [self.customize lessonForPage:message.body[@"id"] preview:NO];
        replyHandler(lesson, lesson ? nil : PianoText(@"Bu ders burada yok."));
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

// The page's header is 48 points tall (piano.html .app-bar); centre the window buttons in it.
- (void)placeWindowButtons {
#ifndef PIANO_CAPTURE
    const CGFloat PianoHeaderHeight = 48;
    NSButton *close = [self.window standardWindowButton:NSWindowCloseButton];
    NSView *container = close.superview.superview;
    if (!container || (self.window.styleMask & NSWindowStyleMaskFullScreen)) return;
    NSRect bar = container.frame;
    bar.size.height = PianoHeaderHeight;
    bar.origin.y = NSHeight(self.window.frame) - PianoHeaderHeight;
    container.frame = bar;
    close.superview.frame = container.bounds;
    CGFloat x = 18;
    for (NSNumber *kind in @[@(NSWindowCloseButton), @(NSWindowMiniaturizeButton), @(NSWindowZoomButton)]) {
        NSButton *button = [self.window standardWindowButton:kind.unsignedIntegerValue];
        NSRect frame = button.frame;
        // centred on the header's content, which ends at its 1-point bottom border
        frame.origin = NSMakePoint(x, 1 + (PianoHeaderHeight - 1 - NSHeight(frame)) / 2);
        button.frame = frame;
        x += NSWidth(frame) + 8;
    }
#endif
}
- (void)windowDidResize:(NSNotification *)notification {
    [self layoutCustomize];
    (void)notification; [self placeWindowButtons];
}
- (void)windowDidEnterFullScreen:(NSNotification *)notification {
    (void)notification; [self publish:@{@"event":@"fullscreen", @"active":@YES}];
}
- (void)windowDidExitFullScreen:(NSNotification *)notification {
    (void)notification; [self placeWindowButtons]; [self publish:@{@"event":@"fullscreen", @"active":@NO}];
}
- (BOOL)windowShouldClose:(NSWindow *)sender {
    (void)sender; [NSApp terminate:nil]; return NO;
}
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    (void)sender;
    if (self.uninstalling) [self.updates stop];
    self.quitting = YES;
    self.savingWorkspace = YES;
    [self.window saveFrameUsingName:@"Rach3MainWindow"];
    [self.webView callAsyncJavaScript:@"window.dispatchEvent(new Event('rach3-save-state'));"
        arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld
        completionHandler:^(id result, NSError *error) {
            (void)result; (void)error;
            self.savingWorkspace = NO;
            [self finishTermination];
        }];
    [self stopBluetooth]; [self.lessons cancel]; [self.customize stop]; return NSTerminateLater;
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
    alert.messageText = PianoText(@"rach3 kaldırılsın mı?");
    alert.informativeText = PianoText(@"Uygulama, modeller, kayıtlı dersler ve rach3’ün geçici verileri kalıcı olarak silinecek. Orijinal videolar ve dışarı aktardığın MIDI dosyaları korunacak.");
    [alert addButtonWithTitle:PianoText(@"Vazgeç")]; [alert addButtonWithTitle:PianoText(@"rach3’ü kaldır")];
    [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
        if (response==NSAlertSecondButtonReturn) { self.uninstalling = YES; [NSApp terminate:nil]; }
    }];
}
- (BOOL)launchUninstaller {
    NSTask *helper = [NSTask new]; helper.executableURL = NSBundle.mainBundle.executableURL;
    helper.arguments = @[@"--uninstall",@(getpid()).stringValue];
    NSError *error;
    if (![helper launchAndReturnError:&error]) { self.uninstalling = NO; [self showLessonError:error]; return NO; }
    [NSUserDefaults.standardUserDefaults removePersistentDomainForName:@"com.rach3.app"];
    return YES;
}
- (void)showLessonError:(NSError *)error {
    NSAlert *alert = [NSAlert new]; alert.messageText = @"rach3";
    [alert addButtonWithTitle:PianoText(@"Tamam")];
    alert.informativeText = PianoText(error.localizedDescription) ?: PianoText(@"İşlem tamamlanamadı.");
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
    if (webView == self.panelView) {
        // The panel never leaves its own page.
        decisionHandler([action.request.URL.absoluteString isEqual:@"about:blank"] ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
        return;
    }
    if (action.shouldPerformDownload) { decisionHandler(WKNavigationActionPolicyDownload); return; }
    NSURL *target = action.request.URL;
    if ([target.scheme isEqual:self.pageURL.scheme] && [target.host isEqual:self.pageURL.host] &&
        (target.path.length <= 1 || [target.path isEqual:self.pageURL.path])) {
        decisionHandler(WKNavigationActionPolicyAllow); return;
    }
    decisionHandler(WKNavigationActionPolicyCancel);
}
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    (void)navigation;
    if (webView == self.panelView) return;
    NSAlert *alert = [NSAlert new]; alert.messageText = PianoText(@"rach3 açılamadı");
    [alert addButtonWithTitle:PianoText(@"Tamam")];
    alert.informativeText = error.localizedDescription; [alert beginSheetModalForWindow:self.window completionHandler:nil];
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    if (webView == self.panelView) { [webView removeFromSuperview]; self.panelView = nil; self.panelOpen = NO;
        [self makePanel]; if (self.panelView) [self.window.contentView addSubview:self.panelView]; [self layoutCustomize]; return; }
    self.pageReady = NO; [self stopBluetooth]; [webView reload];
}
- (void)webView:(WKWebView *)webView runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
    initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSArray<NSURL *> *))completionHandler {
    (void)webView; (void)frame;
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.title = PianoText(@"Aç"); panel.prompt = PianoText(@"Aç");
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
    panel.title = PianoText(@"Kaydet"); panel.prompt = PianoText(@"Kaydet");
    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
        completionHandler(result == NSModalResponseOK ? panel.URL : nil);
    }];
}
- (void)downloadDidFinish:(WKDownload *)download { [self.downloads removeObject:download]; }
- (void)download:(WKDownload *)download didFailWithError:(NSError *)error resumeData:(NSData *)resumeData {
    (void)resumeData; [self.downloads removeObject:download];
    if (error.code == NSURLErrorCancelled) return;
    NSAlert *alert = [NSAlert new]; alert.messageText = PianoText(@"Dosya kaydedilemedi");
    [alert addButtonWithTitle:PianoText(@"Tamam")];
    alert.informativeText = error.localizedDescription; [alert beginSheetModalForWindow:self.window completionHandler:nil];
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc==3 && strcmp(argv[1],"--uninstall")==0) {
            pid_t parent = (pid_t)atoi(argv[2]);
            while (parent>1 && kill(parent,0)==0) usleep(100000);
            NSURL *app = NSBundle.mainBundle.bundleURL;
            if (![NSBundle.mainBundle.bundleIdentifier isEqual:@"com.rach3.app"] || ![app.pathExtension isEqual:@"app"]) return 1;
            NSFileManager *files = NSFileManager.defaultManager;
            NSURL *library = [files URLsForDirectory:NSLibraryDirectory inDomains:NSUserDomainMask].firstObject;
            NSMutableArray *paths = [NSMutableArray arrayWithObject:app];
            for (NSString *path in @[@"Application Support/Rach3",@"Caches/com.rach3.app",@"WebKit/com.rach3.app",@"Saved Application State/com.rach3.app.savedState",@"Preferences/com.rach3.app.plist"])
                [paths addObject:[library URLByAppendingPathComponent:path]];
            NSMutableArray *failures = [NSMutableArray new];
            for (NSURL *path in paths) {
                if (![files fileExistsAtPath:path.path]) continue;
                NSError *error;
                if (![files removeItemAtURL:path error:&error]) [failures addObject:error.localizedDescription];
            }
            if (failures.count) {
                [NSApplication sharedApplication];
                NSAlert *alert = [NSAlert new]; alert.messageText = PianoText(@"Bazı rach3 dosyaları silinemedi");
                [alert addButtonWithTitle:PianoText(@"Tamam")];
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
#ifdef PIANO_CAPTURE
        delegate.captureDirectory = [NSString stringWithUTF8String:argv[1]];
        delegate.captureLanguage = argc > 2 ? [NSString stringWithUTF8String:argv[2]] : @"en";
#endif
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
