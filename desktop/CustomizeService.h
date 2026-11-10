#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>

// The Mac side of rach3's ChatGPT features. What they do, for changing rach3 and for
// the "With AI" tab, is desktop/customize/core.js, shared with Windows; it runs in the
// Customize panel's web view and asks this class for what only the Mac can do:
// files in rach3's own folders, Codex inside its sandbox, Sign in with ChatGPT, the
// hidden preview and serving the page.
//
// The page is served from a "design": the original files in the app bundle, or a
// saved copy in Application Support/Rach3/Customize/designs.
@interface CustomizeService : NSObject <WKURLSchemeHandler, WKScriptMessageHandlerWithReply, WKNavigationDelegate>
// Delivers a message to core.js (window.rach3Core.receive in the panel).
@property (nonatomic, copy) void (^onCore)(NSDictionary *message);
// core.js put a design on screen. start: the panel just loaded, so a page that already
// shows this design is kept; otherwise the page reloads.
@property (nonatomic, copy) void (^onShow)(BOOL start);
// The panel opened or closed; toggle is its button's width.
@property (nonatomic, copy) void (^onPanel)(BOOL open, CGFloat toggle);
// Answers the page's native commands inside the hidden preview, read-only ones only.
@property (nonatomic, copy) void (^previewBridge)(NSDictionary *message, void (^reply)(id value));
// A lesson was created or changed for the person.
@property (nonatomic, copy) void (^onLessonChanged)(NSDictionary *lesson);
@property (nonatomic) NSSize previewSize;
// Whether this copy of rach3 carries Codex, so ChatGPT features can be offered.
@property (nonatomic, readonly) BOOL available;
// Reports runtime errors on the page so the person and ChatGPT can see them.
+ (NSString *)errorScript;
- (instancetype)initWithSource:(NSURL *)source codex:(NSURL *)codex support:(NSURL *)support version:(NSString *)version;
+ (NSString *)scheme;
// Blocks every load from the internet in that view, then calls back. Pages,
// including ones Codex changed, may only load rach3's own files.
+ (void)blockInternetIn:(WKUserContentController *)controller then:(void (^)(void))done;
// The page's address. Each branch has its own host, so its stored settings
// (localStorage) are its own and can never reach main's.
- (NSURL *)pageURL;
// A branch opened for the first time starts with the settings of the page it was opened
// from, copied once.
- (BOOL)needsSeed:(NSString *)host;
- (void)markSeeded:(NSString *)host;
// A binding core.js asked for ({op, ...}).
- (void)native:(NSDictionary *)body reply:(void (^)(id result, NSString *error))reply;
// A request for core.js: lesson-list, lesson-load, lesson-delete, page-error, desk-*,
// lesson-progress, language, restore-original. Waits until core.js has started.
- (void)ask:(NSString *)command body:(NSDictionary *)body reply:(void (^)(id result, NSString *error))reply;
// The panel's web view was made again; core.js starts over in it.
- (void)coreRestarted;
- (void)stop;

// The "With AI" tab of Create a Lesson. It never changes the interface; lessons are made
// by rach3's own import. The request has kind (youtube, midi, pdf), file, link and
// title; the answer has the job id or an error to show.
@property (nonatomic, copy) NSDictionary *(^importLesson)(NSDictionary *request);
// Bytes of tools a lesson of that kind still needs to download.
@property (nonatomic, copy) unsigned long long (^missingTools)(NSString *kind);
@property (nonatomic, copy) void (^onDeskEvent)(NSDictionary *event);
- (NSDictionary *)deskCard:(NSString *)card;
@end
