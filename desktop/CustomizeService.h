#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>

// Lets a person change rach3 by describing the change to ChatGPT.
//
// The page is served from a "design": the original files in the app bundle, or a
// saved copy in Application Support/Rach3/Customize/designs. Codex works on a
// scratch copy of the active design, closed off from everything else on the Mac,
// and every finished change becomes a new design the person can switch back from.
@interface CustomizeService : NSObject <WKURLSchemeHandler, WKScriptMessageHandlerWithReply, WKNavigationDelegate>
@property (nonatomic, copy) void (^onEvent)(NSDictionary *);
// Asks the window to reload the page after the active design changed.
@property (nonatomic, copy) void (^onReload)(void);
// Answers the page's native commands inside the hidden preview, read-only ones only.
@property (nonatomic, copy) id (^previewBridge)(NSDictionary *message);
// A lesson was created or changed for the person.
@property (nonatomic, copy) void (^onLessonChanged)(NSDictionary *lesson);
@property (nonatomic) NSSize previewSize;
@property (nonatomic, readonly) BOOL busy;
// Reports runtime errors on the page so the person and ChatGPT can see them.
+ (NSString *)errorScript;
- (void)pageError:(NSDictionary *)error;
- (instancetype)initWithSource:(NSURL *)source codex:(NSURL *)codex support:(NSURL *)support version:(NSString *)version;
+ (NSString *)scheme;
// The page's address. Each branch has its own host, so its stored settings
// (localStorage) are its own and can never reach main's.
- (NSURL *)pageURL;
// A branch opened for the first time starts with the settings of the page it was opened
// from, copied once.
- (BOOL)needsSeed:(NSString *)host;
- (void)markSeeded:(NSString *)host;
- (void)handle:(NSDictionary *)request reply:(void (^)(id result, NSString *error))reply;
- (NSDictionary *)state;
- (void)publishState;
- (void)restoreOriginal;
// Lessons as the page sees them: the person's own, plus those ChatGPT made for the
// version on screen (or, for the hidden preview, the version being changed).
- (NSArray *)lessonsForPage:(BOOL)preview;
- (NSDictionary *)lessonForPage:(NSString *)identifier preview:(BOOL)preview;
// nil when deleted. personal is YES for the person's own lesson, which the caller deletes;
// it is refused ("original-only") unless the original rach3 is on screen.
- (NSString *)deleteLessonForPage:(NSString *)identifier personal:(BOOL *)personal;
- (void)stop;
@end
