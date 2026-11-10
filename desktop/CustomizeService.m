#import "CustomizeService.h"
#import "LessonDesk.h"
#import "Localization.h"
#import <AppKit/AppKit.h>
#import <arpa/inet.h>
#import <CommonCrypto/CommonDigest.h>
#import <netinet/in.h>
#import <Security/Security.h>
#import <sys/socket.h>
#import <unistd.h>

// Sign in with ChatGPT, direct flow for open-source apps
// (developers.openai.com/siwc/token-sharing-open-source).
static NSString *const AuthorizeURL = @"https://auth.openai.com/api/accounts/authorize";
static NSString *const TokenURL = @"https://auth.openai.com/api/accounts/oauth/token";
static NSString *const RevokeURL = @"https://auth.openai.com/api/accounts/oauth/revoke";
static NSString *const Resource = @"https://api.openai.com/v1";
static NSString *const Scope = @"openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
static NSString *const PlanScope = @"chatgpt.tokens.use.direct";
static NSString *const UsageURL = @"https://chatgpt.com/settings/usage";

static NSString *Base64URL(NSData *data) {
    return [[[[data base64EncodedStringWithOptions:0] stringByReplacingOccurrencesOfString:@"+" withString:@"-"]
        stringByReplacingOccurrencesOfString:@"/" withString:@"_"] stringByReplacingOccurrencesOfString:@"=" withString:@""];
}
static NSString *RandomToken(NSUInteger bytes) {
    NSMutableData *data = [NSMutableData dataWithLength:bytes];
    if (SecRandomCopyBytes(kSecRandomDefault, bytes, data.mutableBytes) != errSecSuccess) return nil;
    return Base64URL(data);
}
static NSDictionary *Claims(NSString *jwt) {
    NSArray *parts = [jwt componentsSeparatedByString:@"."];
    if (parts.count < 2) return nil;
    NSString *body = [[parts[1] stringByReplacingOccurrencesOfString:@"-" withString:@"+"] stringByReplacingOccurrencesOfString:@"_" withString:@"/"];
    while (body.length % 4) body = [body stringByAppendingString:@"="];
    NSData *data = [[NSData alloc] initWithBase64EncodedString:body options:0];
    id claims = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
    return [claims isKindOfClass:NSDictionary.class] ? claims : nil;
}
static NSString *FormBody(NSDictionary<NSString *, NSString *> *fields) {
    NSMutableCharacterSet *allowed = [NSCharacterSet.alphanumericCharacterSet mutableCopy];
    [allowed addCharactersInString:@"-._~"];
    NSMutableArray *pairs = [NSMutableArray new];
    for (NSString *key in fields)
        [pairs addObject:[NSString stringWithFormat:@"%@=%@", key, [fields[key] stringByAddingPercentEncodingWithAllowedCharacters:allowed]]];
    return [pairs componentsJoinedByString:@"&"];
}
static NSString *TomlString(NSString *value) {
    return [NSString stringWithFormat:@"\"%@\"", [[value stringByReplacingOccurrencesOfString:@"\\" withString:@"\\\\"]
        stringByReplacingOccurrencesOfString:@"\"" withString:@"\\\""]];
}
// What core.js may reach in Customize: its records, the saved versions, the scratch
// copy and the lessons ChatGPT made. Not the sign-in, not Codex's home.
static NSSet<NSString *> *DataEntries(void) {
    static NSSet *names; static dispatch_once_t once;
    dispatch_once(&once, ^{ names = [NSSet setWithArray:@[@"designs.json", @"usage.json", @"designs", @"workspace", @"lessons"]]; });
    return names;
}
static BOOL IsLink(NSURL *url) {
    NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:url.path error:NULL];
    return [attributes[NSFileType] isEqual:NSFileTypeSymbolicLink];
}
static NSString *MimeType(NSString *extension) {
    NSDictionary *types = @{@"html":@"text/html; charset=utf-8", @"js":@"text/javascript; charset=utf-8", @"mjs":@"text/javascript; charset=utf-8",
        @"css":@"text/css; charset=utf-8", @"json":@"application/json; charset=utf-8", @"png":@"image/png", @"jpg":@"image/jpeg",
        @"jpeg":@"image/jpeg", @"svg":@"image/svg+xml", @"woff2":@"font/woff2", @"woff":@"font/woff", @"mid":@"audio/midi",
        @"wasm":@"application/wasm", @"txt":@"text/plain; charset=utf-8", @"md":@"text/plain; charset=utf-8"};
    return types[extension.lowercaseString] ?: @"application/octet-stream";
}
static id Value(id value) { return value ?: NSNull.null; }

@interface CustomizeService ()
@property (nonatomic, strong) NSURL *source;          // original design, inside the app bundle
@property (nonatomic, strong) NSURL *codexRoot;       // bundled Codex package
@property (nonatomic, strong) NSURL *root;            // Application Support/Rach3/Customize
@property (nonatomic, strong) NSURL *support;
@property (nonatomic, copy) NSString *version;
@property (nonatomic, strong) NSMutableDictionary *session;
@property (nonatomic, strong) NSMutableDictionary *preferences;
// what is on screen, as core.js last said
@property (nonatomic, copy) NSString *pageHost;
@property (nonatomic, copy) NSString *activeDesign;
// core.js
@property (nonatomic) BOOL coreReady;
@property (nonatomic, strong) NSMutableArray *coreQueue;
@property (nonatomic, strong) NSMutableDictionary *answers;
@property (nonatomic) long long nextQuestion;
// sign-in
@property (nonatomic) int listener;
@property (nonatomic, copy) NSString *signInError;
@property (nonatomic) BOOL signingIn;
@property (nonatomic, strong) NSMutableArray *refreshWaiters;
// Codex app-server
@property (nonatomic, strong) NSTask *codex;
@property (nonatomic, strong) NSFileHandle *codexInput;
@property (nonatomic, strong) NSMutableData *codexBuffer;
@property (nonatomic, copy) NSString *codexToken;
@property (nonatomic, strong) LessonDesk *desk;
// hidden preview of the scratch copy, for Codex to check its work
@property (nonatomic, strong) NSWindow *previewWindow;
@property (nonatomic, strong) WKWebView *previewView;
@property (nonatomic, strong) NSMutableArray *previewErrors;
@property (nonatomic, copy) void (^previewLoaded)(void);
@end

@implementation CustomizeService

+ (NSString *)scheme { return @"rach3-app"; }

+ (void)blockInternetIn:(WKUserContentController *)controller then:(void (^)(void))done {
    static WKContentRuleList *rules;
    static NSHashTable *blocked;
    if (!blocked) blocked = [NSHashTable weakObjectsHashTable];
    void (^apply)(void) = ^{
        if (rules && ![blocked containsObject:controller]) { [controller addContentRuleList:rules]; [blocked addObject:controller]; }
        if (!rules) NSLog(@"rach3: the internet block could not be set up");
        done();
    };
    if (rules) { apply(); return; }
    // WebKit's rule regexes have no "|", so each scheme is its own rule.
    NSString *json = @"[{\"trigger\":{\"url-filter\":\"^https?://\"},\"action\":{\"type\":\"block\"}},"
        "{\"trigger\":{\"url-filter\":\"^wss?://\"},\"action\":{\"type\":\"block\"}},"
        "{\"trigger\":{\"url-filter\":\"^ftp://\"},\"action\":{\"type\":\"block\"}}]";
    [WKContentRuleListStore.defaultStore compileContentRuleListForIdentifier:@"rach3-offline" encodedContentRuleList:json
        completionHandler:^(WKContentRuleList *list, NSError *error) {
        if (error) NSLog(@"rach3: %@", error.localizedDescription);
        dispatch_async(dispatch_get_main_queue(), ^{ if (list) rules = list; apply(); });
    }];
}
- (NSURL *)pageURL { return [NSURL URLWithString:[NSString stringWithFormat:@"rach3-app://%@/piano.html", self.pageHost ?: @"app"]]; }
- (BOOL)needsSeed:(NSString *)host {
    return ![host isEqual:@"app"] && ![self.preferences[@"seeded"] containsObject:host];
}
- (void)markSeeded:(NSString *)host {
    if (![self needsSeed:host]) return;
    NSMutableArray *seeded = [self.preferences[@"seeded"] mutableCopy] ?: [NSMutableArray new];
    [seeded addObject:host]; self.preferences[@"seeded"] = seeded; [self save:self.preferences as:@"preferences.json"];
}

- (instancetype)initWithSource:(NSURL *)source codex:(NSURL *)codex support:(NSURL *)support version:(NSString *)version {
    if ((self = [super init])) {
        self.source = source; self.codexRoot = codex; self.version = version ?: @"";
        self.support = support;
        self.root = [support URLByAppendingPathComponent:@"Customize" isDirectory:YES];
        [NSFileManager.defaultManager createDirectoryAtURL:[self.root URLByAppendingPathComponent:@"designs"]
            withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL];
        self.session = [self load:@"session.json"] ?: [NSMutableDictionary new];
        self.preferences = [self load:@"preferences.json"] ?: [NSMutableDictionary new];
        self.desk = [[LessonDesk alloc] initWithRoot:[self.root URLByAppendingPathComponent:@"desk" isDirectory:YES]];
        __weak CustomizeService *weakDesk = self;
        self.desk.onProgress = ^(NSDictionary *progress) {
            CustomizeService *service = weakDesk;
            if (service.onDeskEvent) {
                NSMutableDictionary *event = [progress mutableCopy];
                event[@"event"] = @"desk-progress";
                service.onDeskEvent(event);
            }
        };
        self.listener = -1;
        self.refreshWaiters = [NSMutableArray new];
        self.coreQueue = [NSMutableArray new]; self.answers = [NSMutableDictionary new];
        self.pageHost = @"app"; self.activeDesign = @"original";
    }
    return self;
}

#pragma mark Storage

- (NSMutableDictionary *)load:(NSString *)name {
    NSData *data = [NSData dataWithContentsOfURL:[self.root URLByAppendingPathComponent:name]];
    id value = data ? [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:NULL] : nil;
    return [value isKindOfClass:NSMutableDictionary.class] ? value : nil;
}
- (void)save:(NSDictionary *)value as:(NSString *)name {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingPrettyPrinted error:NULL];
    NSURL *url = [self.root URLByAppendingPathComponent:name];
    [data writeToURL:url options:NSDataWritingAtomic error:NULL];
    [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions:@0600} ofItemAtPath:url.path error:NULL];
}
- (NSURL *)workspace { return [self.root URLByAppendingPathComponent:@"workspace" isDirectory:YES]; }
- (NSURL *)lessonsURL { return [self.support URLByAppendingPathComponent:@"Lessons" isDirectory:YES]; }
- (NSURL *)activeRoot {
    NSString *design = self.activeDesign;
    if ([design isEqual:@"original"]) return self.source;
    NSURL *url = [[self.root URLByAppendingPathComponent:@"designs" isDirectory:YES] URLByAppendingPathComponent:design isDirectory:YES];
    BOOL folder = NO;
    return [NSFileManager.defaultManager fileExistsAtPath:url.path isDirectory:&folder] && folder ? url : self.source;
}

// A relative path inside root, or nil when it would leave it: no "..", no hidden
// names, and no link on the way, since a link could lead anywhere on the Mac.
+ (NSURL *)inside:(NSURL *)root path:(NSString *)path {
    if (![path isKindOfClass:NSString.class] || [path hasPrefix:@"/"]) return nil;
    NSURL *url = root;
    if (!path.length) return root;
    for (NSString *part in [path componentsSeparatedByString:@"/"]) {
        if (!part.length || [part hasPrefix:@"."]) return nil;
        url = [url URLByAppendingPathComponent:part];
        if (IsLink(url)) return nil;
    }
    return url;
}

#pragma mark Page files

- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
    (void)webView;
    NSURL *url = task.request.URL;
    NSString *path = url.path.length > 1 ? [url.path substringFromIndex:1] : @"piano.html";
    BOOL preview = [url.scheme isEqual:@"rach3-preview"];
    if ([path hasPrefix:@"_desk/"]) {
        NSString *type = nil;
        NSData *served = !preview && [url.host isEqual:self.pageHost] ? [self.desk servedFile:path type:&type] : nil;
        [task didReceiveResponse:[[NSHTTPURLResponse alloc] initWithURL:url statusCode:served ? 200 : 404 HTTPVersion:@"HTTP/1.1"
            headerFields:@{@"Content-Type":type ?: @"text/plain", @"Cache-Control":@"no-store", @"Content-Length":@(served.length).stringValue}]];
        if (served) [task didReceiveData:served];
        [task didFinish]; return;
    }
    BOOL protected = [path isEqual:@"AGENTS.md"] || [path hasPrefix:@"assets/notation/"] || [path hasPrefix:@"assets/bravura/"];
    NSURL *root = protected ? self.source : preview ? self.workspace : self.activeRoot;
    if ([path isEqual:@"piano.html"] && task.request.mainDocumentURL && [task.request.URL isEqual:task.request.mainDocumentURL]) {
        if (preview) [self.previewErrors removeAllObjects];
        else [self ask:@"page-loading" body:@{} reply:^(id result, NSString *error) { (void)result; (void)error; }];
    }
    BOOL ours = [url.host isEqual:preview ? @"app" : self.pageHost];
    NSURL *file = ours ? [CustomizeService inside:root path:path] : nil;
    NSData *data = file ? [NSData dataWithContentsOfURL:file] : nil;
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:url statusCode:data ? 200 : 404 HTTPVersion:@"HTTP/1.1"
        headerFields:@{@"Content-Type":data ? MimeType(file.pathExtension) : @"text/plain", @"Cache-Control":@"no-store",
                       @"Content-Length":@(data.length).stringValue}];
    [task didReceiveResponse:response];
    if (data) [task didReceiveData:data];
    [task didFinish];
}
- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task { (void)webView; (void)task; }

#pragma mark core.js

- (void)toCore:(NSDictionary *)message {
    if (!self.coreReady) { [self.coreQueue addObject:message]; return; }
    if (self.onCore) self.onCore(message);
}

- (void)ask:(NSString *)command body:(NSDictionary *)body reply:(void (^)(id, NSString *))reply {
    NSNumber *identifier = @(++self.nextQuestion);
    self.answers[identifier] = [reply copy];
    [self toCore:@{@"request":identifier, @"command":command, @"body":body ?: @{}}];
}

- (void)coreRestarted {
    self.coreReady = NO;
    // Whatever core.js was doing is gone with it, Codex's conversation too.
    [self stopCodex:NO];
    NSDictionary *answers = [self.answers copy]; [self.answers removeAllObjects];
    for (NSNumber *key in answers) ((void (^)(id, NSString *))answers[key])(nil, @"restarted");
}

- (NSDictionary *)authState {
    NSDictionary *account = nil;
    if (self.session[@"refresh_token"]) {
        NSDictionary *claims = Claims(self.session[@"id_token"]) ?: @{};
        account = @{@"email":claims[@"email"] ?: @"", @"name":claims[@"name"] ?: @""};
    }
    return @{@"signedIn":@(account != nil), @"account":Value(account), @"signingIn":@(self.signingIn), @"signInError":Value(self.signInError)};
}
- (void)publishAuth { if (self.coreReady && self.onCore) self.onCore(@{@"auth":self.authState}); }

- (NSURL *)location:(NSDictionary *)place write:(BOOL)write {
    if (![place isKindOfClass:NSDictionary.class]) return nil;
    NSString *area = place[@"area"], *path = place[@"path"];
    if (![area isKindOfClass:NSString.class] || ![path isKindOfClass:NSString.class]) return nil;
    NSURL *root = nil;
    if ([area isEqual:@"source"] && !write) root = self.source;
    else if ([area isEqual:@"lessons"]) root = self.lessonsURL;
    else if ([area isEqual:@"data"]) {
        if (![DataEntries() containsObject:[path componentsSeparatedByString:@"/"].firstObject]) return nil;
        root = self.root;
    }
    return root ? [CustomizeService inside:root path:path] : nil;
}

// Every regular file under folder, as paths relative to it. Links are left out.
// Regular files under folder, as paths relative to it. Links are skipped, never followed.
// (Relative paths come straight from the enumerator, so a folder reached through a link,
// like /var for /private/var, still lists.)
static NSArray<NSString *> *RelativeFiles(NSURL *folder) {
    NSMutableArray *paths = [NSMutableArray new];
    NSDirectoryEnumerator *walk = [NSFileManager.defaultManager enumeratorAtPath:folder.path];
    for (NSString *path in walk)
        if ([walk.fileAttributes[NSFileType] isEqual:NSFileTypeRegular]) [paths addObject:path];
    return paths;
}

- (BOOL)copyFrom:(NSURL *)from to:(NSURL *)to {
    NSFileManager *files = NSFileManager.defaultManager;
    BOOL folder = NO;
    if (!from || !to || IsLink(from) || ![files fileExistsAtPath:from.path isDirectory:&folder]) return NO;
    if (!folder) {
        [files removeItemAtURL:to error:NULL];
        [files createDirectoryAtURL:to.URLByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:NULL];
        return [files copyItemAtURL:from toURL:to error:NULL];
    }
    [files createDirectoryAtURL:to withIntermediateDirectories:YES attributes:nil error:NULL];
    for (NSString *path in RelativeFiles(from)) {
        NSURL *target = [to URLByAppendingPathComponent:path];
        [files removeItemAtURL:target error:NULL];
        [files createDirectoryAtURL:target.URLByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:NULL];
        if (![files copyItemAtURL:[from URLByAppendingPathComponent:path] toURL:target error:NULL]) return NO;
    }
    return YES;
}

- (NSArray *)summaries:(NSURL *)folder {
    NSMutableArray *list = [NSMutableArray new];
    for (NSURL *url in [NSFileManager.defaultManager contentsOfDirectoryAtURL:folder includingPropertiesForKeys:nil options:0 error:NULL]) {
        if (![url.pathExtension isEqual:@"json"] || IsLink(url)) continue;
        NSData *data = [NSData dataWithContentsOfURL:url];
        NSDictionary *lesson = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
        if (![lesson isKindOfClass:NSDictionary.class] || !lesson[@"id"] || !lesson[@"title"]) continue;
        [list addObject:@{@"id":lesson[@"id"], @"title":lesson[@"title"], @"noteCount":lesson[@"noteCount"] ?: @0, @"duration":lesson[@"duration"] ?: @0}];
    }
    return list;
}

- (void)native:(NSDictionary *)body reply:(void (^)(id, NSString *))reply {
    NSString *op = body[@"op"];
    NSFileManager *files = NSFileManager.defaultManager;
    if (![op isKindOfClass:NSString.class]) { reply(nil, @"invalid"); return; }
    if ([op isEqual:@"info"]) {
        reply(@{@"platform":@"mac", @"version":self.version, @"language":PianoLanguage(), @"available":@(self.available),
                @"workspace":self.workspace.path}, nil);
    } else if ([op isEqual:@"preferences"]) {
        reply(@{@"welcomed":@([self.preferences[@"welcomed"] boolValue]), @"open":@([self.preferences[@"open"] boolValue])}, nil);
    } else if ([op isEqual:@"set-preference"]) {
        if (![@[@"welcomed", @"open"] containsObject:body[@"key"] ?: @""]) { reply(nil, @"invalid"); return; }
        self.preferences[body[@"key"]] = @([body[@"value"] boolValue]); [self save:self.preferences as:@"preferences.json"]; reply(@{}, nil);
    } else if ([op isEqual:@"auth"]) {
        reply(self.authState, nil);
    } else if ([op isEqual:@"read"]) {
        NSURL *url = [self location:body write:NO];
        NSString *text = url ? [NSString stringWithContentsOfURL:url encoding:NSUTF8StringEncoding error:NULL] : nil;
        reply(Value(text), nil);
    } else if ([op isEqual:@"write"]) {
        NSURL *url = [self location:body write:YES];
        NSData *data = [body[@"text"] isKindOfClass:NSString.class] ? [body[@"text"] dataUsingEncoding:NSUTF8StringEncoding] : nil;
        if (!url || !data) { reply(@NO, nil); return; }
        [files createDirectoryAtURL:url.URLByDeletingLastPathComponent withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL];
        reply(@([data writeToURL:url options:[body[@"exclusive"] boolValue] ? NSDataWritingWithoutOverwriting : NSDataWritingAtomic error:NULL]), nil);
    } else if ([op isEqual:@"list"]) {
        NSURL *url = [self location:body write:NO];
        reply(url ? RelativeFiles(url) : @[], nil);
    } else if ([op isEqual:@"exists"]) {
        NSURL *url = [self location:body write:NO];
        BOOL folder = NO;
        reply(url && [files fileExistsAtPath:url.path isDirectory:&folder] ? (folder ? @"folder" : @"file") : NSNull.null, nil);
    } else if ([op isEqual:@"same"]) {
        NSURL *a = [self location:body[@"a"] write:NO], *b = [self location:body[@"b"] write:NO];
        NSData *before = a ? [NSData dataWithContentsOfURL:a options:NSDataReadingMappedIfSafe error:NULL] : nil;
        NSData *after = b ? [NSData dataWithContentsOfURL:b options:NSDataReadingMappedIfSafe error:NULL] : nil;
        reply(@(before == after || [before isEqualToData:after]), nil);
    } else if ([op isEqual:@"remove"] || [op isEqual:@"trash"]) {
        NSURL *url = [self location:body write:YES];
        if (url && ![url isEqual:self.root] && ![url isEqual:self.lessonsURL]) {
            if ([op isEqual:@"trash"]) [files trashItemAtURL:url resultingItemURL:NULL error:NULL];
            else [files removeItemAtURL:url error:NULL];
        }
        reply(@{}, nil);
    } else if ([op isEqual:@"copy"]) {
        reply(@([self copyFrom:[self location:body[@"from"] write:NO] to:[self location:body[@"to"] write:YES]]), nil);
    } else if ([op isEqual:@"move"]) {
        NSURL *from = [self location:body[@"from"] write:YES], *to = [self location:body[@"to"] write:YES];
        if (!from || !to || [to.path hasPrefix:[self.source.path stringByAppendingString:@"/"]]) { reply(@NO, nil); return; }
        [files createDirectoryAtURL:to.URLByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:NULL];
        reply(@([files moveItemAtURL:from toURL:to error:NULL]), nil);
    } else if ([op isEqual:@"open-workspace"]) {
        // codex.sb names the scratch copy by path, so it only has to exist.
        reply(@([files createDirectoryAtURL:self.workspace withIntermediateDirectories:YES attributes:nil error:NULL]), nil);
    } else if ([op isEqual:@"summaries"]) {
        NSURL *url = [self location:body write:NO];
        reply(url ? [self summaries:url] : @[], nil);
    } else if ([op isEqual:@"codex-ensure"]) {
        [self ensureCodex:^(NSDictionary *result) { reply(result, nil); }];
    } else if ([op isEqual:@"codex-write"]) {
        if ([body[@"line"] isKindOfClass:NSString.class]) [self writeLine:body[@"line"]];
        reply(@{}, nil);
    } else if ([op isEqual:@"sign-in"]) {
        [self signIn]; reply(@{}, nil);
    } else if ([op isEqual:@"cancel-sign-in"]) {
        [self cancelSignIn]; reply(@{}, nil);
    } else if ([op isEqual:@"sign-out"]) {
        [self signOut]; reply(@{}, nil);
    } else if ([op isEqual:@"open-usage"]) {
        [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:UsageURL]]; reply(@{}, nil);
    } else if ([op isEqual:@"preview"]) {
        [self preview:[body[@"script"] isKindOfClass:NSString.class] ? body[@"script"] : nil done:^(NSDictionary *result) { reply(result, nil); }];
    } else if ([op isEqual:@"desk-entries"]) {
        reply(self.desk.entries, nil);
    } else if ([op isEqual:@"desk-add"]) {
        if ([body[@"entry"] isKindOfClass:NSDictionary.class]) [self.desk addEntry:body[@"entry"]];
        reply(@{}, nil);
    } else if ([op isEqual:@"desk-clear"]) {
        [self.desk clear]; reply(@{}, nil);
    } else if ([op isEqual:@"desk-card"]) {
        reply(Value([self.desk card:body[@"card"]]), nil);
    } else if ([op isEqual:@"desk-update"]) {
        if ([body[@"card"] isKindOfClass:NSDictionary.class]) [self.desk update:body[@"card"]];
        reply(@{}, nil);
    } else if ([op isEqual:@"desk-show"]) {
        NSString *source = [body[@"source"] isKindOfClass:NSString.class] ? body[@"source"] : @"";
        NSString *title = [body[@"title"] isKindOfClass:NSString.class] ? body[@"title"] : @"";
        NSString *note = [body[@"note"] isKindOfClass:NSString.class] ? body[@"note"] : @"";
        [self.desk show:source title:title note:note done:^(NSDictionary *card, NSString *error) {
            reply(card ? @{@"card":card} : @{@"error":error ?: @""}, nil);
        }];
    } else if ([op isEqual:@"desk-event"]) {
        if ([body[@"event"] isKindOfClass:NSDictionary.class] && self.onDeskEvent) self.onDeskEvent(body[@"event"]);
        reply(@{}, nil);
    } else if ([op isEqual:@"missing-tools"]) {
        reply(@(self.missingTools ? self.missingTools([body[@"kind"] isKindOfClass:NSString.class] ? body[@"kind"] : @"") : 0), nil);
    } else if ([op isEqual:@"import-lesson"]) {
        if (!self.importLesson) { reply(@{@"error":PianoText(@"Ders başlatılamadı.")}, nil); return; }
        reply(self.importLesson(@{@"kind":body[@"kind"] ?: @"", @"file":[self.desk fileOf:body[@"card"]] ?: NSNull.null,
                                  @"link":body[@"link"] ?: NSNull.null, @"title":body[@"title"] ?: @""}), nil);
    } else if ([op isEqual:@"open-lesson"]) {
        if ([body[@"lesson"] isKindOfClass:NSDictionary.class] && self.onLessonChanged) self.onLessonChanged(body[@"lesson"]);
        reply(@{}, nil);
    } else if ([op isEqual:@"panel"]) {
        if (self.onPanel) self.onPanel([body[@"open"] boolValue], [body[@"toggle"] doubleValue]);
        reply(@{}, nil);
    } else if ([op isEqual:@"show"]) {
        NSString *host = body[@"host"], *design = body[@"design"];
        NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyz0123456789-"];
        if (![host isKindOfClass:NSString.class] || !host.length || [host.lowercaseString rangeOfCharacterFromSet:allowed.invertedSet].location != NSNotFound ||
            ![design isKindOfClass:NSString.class] || [CustomizeService inside:self.root path:[@"designs/" stringByAppendingString:design]] == nil) {
            reply(nil, @"invalid"); return;
        }
        BOOL start = [body[@"start"] boolValue];
        self.pageHost = host.lowercaseString; self.activeDesign = design;
        reply(@{}, nil);
        if (self.onShow) self.onShow(start);
        if (!self.coreReady) {
            self.coreReady = YES;
            NSArray *queued = [self.coreQueue copy]; [self.coreQueue removeAllObjects];
            for (NSDictionary *message in queued) if (self.onCore) self.onCore(message);
        }
    } else if ([op isEqual:@"answer"]) {
        NSNumber *identifier = body[@"id"];
        void (^answer)(id, NSString *) = [identifier isKindOfClass:NSNumber.class] ? self.answers[identifier] : nil;
        if (answer) { [self.answers removeObjectForKey:identifier]; answer(body[@"value"], [body[@"error"] isKindOfClass:NSString.class] ? body[@"error"] : nil); }
        reply(@{}, nil);
    } else reply(nil, @"invalid");
}

- (NSDictionary *)deskCard:(NSString *)card { return [self.desk card:card]; }

#pragma mark Sign in with ChatGPT

- (NSString *)hostIdentifier {
    NSString *host = self.preferences[@"host"];
    if (!host) { host = [@"urn:uuid:" stringByAppendingString:NSUUID.UUID.UUIDString.lowercaseString];
        self.preferences[@"host"] = host; [self save:self.preferences as:@"preferences.json"]; }
    return host;
}

- (void)signIn {
    if (self.signingIn) return;
    int port = 0, fd = -1;
    for (port = 1455; port < 1466 && fd < 0; port++) {
        fd = socket(AF_INET, SOCK_STREAM, 0);
        int yes = 1; setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);
        struct sockaddr_in address = {.sin_family = AF_INET, .sin_port = htons((uint16_t)port), .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
        if (bind(fd, (struct sockaddr *)&address, sizeof address) != 0 || listen(fd, 4) != 0) { close(fd); fd = -1; }
    }
    port--;
    if (fd < 0) { self.signInError = @"port"; [self publishAuth]; return; }
    NSString *verifier = RandomToken(32), *state = RandomToken(16), *nonce = RandomToken(16);
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    NSData *verifierData = [verifier dataUsingEncoding:NSUTF8StringEncoding];
    CC_SHA256(verifierData.bytes, (CC_LONG)verifierData.length, digest);
    NSString *redirect = [NSString stringWithFormat:@"http://127.0.0.1:%d/auth/callback", port];
    NSString *client = self.preferences[@"client"] ?: @"dynamic_agent_client";
    NSURLComponents *components = [NSURLComponents componentsWithString:AuthorizeURL];
    NSMutableArray *items = [NSMutableArray new];
    NSDictionary *query = @{@"response_type":@"code", @"client_id":client, @"agent_name_hint":@"rach3", @"ext_agent_host_id":self.hostIdentifier,
        @"redirect_uri":redirect, @"scope":Scope, @"resource":Resource, @"state":state, @"nonce":nonce,
        @"code_challenge":Base64URL([NSData dataWithBytes:digest length:sizeof digest]), @"code_challenge_method":@"S256"};
    for (NSString *key in query) [items addObject:[NSURLQueryItem queryItemWithName:key value:query[key]]];
    components.queryItems = items;
    self.listener = fd; self.signingIn = YES; self.signInError = nil; [self publishAuth];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        NSDictionary *callback = nil;
        while (!callback) {
            int client = accept(fd, NULL, NULL);
            if (client < 0) break;
            struct timeval timeout = {.tv_sec = 5}; setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
            char buffer[8192]; ssize_t length = recv(client, buffer, sizeof buffer - 1, 0);
            NSString *head = length > 0 ? [[NSString alloc] initWithBytes:buffer length:(NSUInteger)length encoding:NSUTF8StringEncoding] : @"";
            NSArray *words = [[head componentsSeparatedByString:@"\r\n"].firstObject componentsSeparatedByString:@" "];
            NSURLComponents *target = words.count > 1 ? [NSURLComponents componentsWithString:[@"http://127.0.0.1" stringByAppendingString:words[1]]] : nil;
            BOOL ours = [target.path isEqual:@"/auth/callback"];
            if (ours) {
                NSMutableDictionary *values = [NSMutableDictionary new];
                for (NSURLQueryItem *item in target.queryItems) if (item.value) values[item.name] = item.value;
                callback = values;
            }
            NSString *page = ours ? @"<!doctype html><meta charset=utf-8><title>rach3</title><body style=\"font:16px -apple-system,system-ui;background:#131416;color:#eee;display:grid;place-items:center;height:90vh\"><p>rach3 ✓ — you can close this tab.</p>" : @"";
            NSString *reply = [NSString stringWithFormat:@"HTTP/1.1 %@\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: %lu\r\nConnection: close\r\n\r\n%@",
                ours ? @"200 OK" : @"404 Not Found", (unsigned long)[page lengthOfBytesUsingEncoding:NSUTF8StringEncoding], page];
            NSData *bytes = [reply dataUsingEncoding:NSUTF8StringEncoding];
            send(client, bytes.bytes, bytes.length, 0); close(client);
        }
        close(fd);
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self.listener == fd) self.listener = -1;
            if (!callback) { self.signingIn = NO; [self publishAuth]; return; }
            if (callback[@"error"] || ![callback[@"state"] isEqual:state] || !callback[@"code"]) {
                self.signingIn = NO; self.signInError = [callback[@"error"] isEqual:@"access_denied"] ? @"denied" : @"failed";
                [self publishAuth]; return;
            }
            NSString *issued = callback[@"client_id"] ?: client;
            [self token:@{@"grant_type":@"authorization_code", @"client_id":issued, @"code":callback[@"code"], @"code_verifier":verifier,
                          @"redirect_uri":redirect, @"resource":Resource} done:^(NSDictionary *tokens, NSString *error) {
                self.signingIn = NO;
                NSDictionary *claims = Claims(tokens[@"id_token"]);
                if (!error && (![claims[@"nonce"] isEqual:nonce] || ![claims[@"iss"] isEqual:@"https://auth.openai.com"])) error = @"failed";
                if (!error && ![[tokens[@"scope"] componentsSeparatedByString:@" "] containsObject:PlanScope]) error = @"plan";
                if (error) { self.signInError = error; [self publishAuth]; return; }
                self.preferences[@"client"] = issued; [self save:self.preferences as:@"preferences.json"];
                [self storeTokens:tokens];
                [NSApp activateIgnoringOtherApps:YES];
                [self publishAuth];
            }];
        });
    });
    [NSWorkspace.sharedWorkspace openURL:components.URL];
}

- (void)cancelSignIn {
    if (self.listener >= 0) shutdown(self.listener, SHUT_RDWR);
    self.signingIn = NO; [self publishAuth];
}

- (void)storeTokens:(NSDictionary *)tokens {
    NSMutableDictionary *session = [self.session mutableCopy];
    for (NSString *key in @[@"access_token", @"refresh_token", @"id_token", @"scope"]) if (tokens[key]) session[key] = tokens[key];
    session[@"expires_at"] = @(NSDate.date.timeIntervalSince1970 + [tokens[@"expires_in"] doubleValue]);
    self.session = session; [self save:session as:@"session.json"];
}

- (void)token:(NSDictionary *)fields done:(void (^)(NSDictionary *, NSString *))done {
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:TokenURL]];
    request.HTTPMethod = @"POST"; request.timeoutInterval = 30;
    [request setValue:@"application/x-www-form-urlencoded" forHTTPHeaderField:@"Content-Type"];
    request.HTTPBody = [FormBody(fields) dataUsingEncoding:NSUTF8StringEncoding];
    [[NSURLSession.sharedSession dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *failure) {
        NSInteger status = [(NSHTTPURLResponse *)response statusCode];
        id body = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
        NSString *error = nil;
        if (failure) error = @"offline";
        else if (status != 200 || ![body isKindOfClass:NSDictionary.class] || !body[@"access_token"]) {
            NSString *code = [body isKindOfClass:NSDictionary.class] ? body[@"error"] : nil;
            error = [@[@"invalid_grant", @"invalid_refresh_token", @"token_expired", @"refresh_token_expired",
                       @"refresh_token_invalidated", @"refresh_token_reused"] containsObject:code ?: @""] ? @"expired" : @"failed";
        }
        dispatch_async(dispatch_get_main_queue(), ^{ done(error ? nil : body, error); });
    }] resume];
}

// Hands back a token valid for at least ten more minutes; refreshes one at a time.
- (void)freshToken:(void (^)(NSString *token, NSString *error))done {
    if (!self.session[@"refresh_token"]) { done(nil, @"signed-out"); return; }
    if ([self.session[@"expires_at"] doubleValue] - NSDate.date.timeIntervalSince1970 > 600) { done(self.session[@"access_token"], nil); return; }
    [self.refreshWaiters addObject:[done copy]];
    if (self.refreshWaiters.count > 1) return;
    [self token:@{@"grant_type":@"refresh_token", @"client_id":self.preferences[@"client"] ?: @"", @"refresh_token":self.session[@"refresh_token"],
                  @"resource":Resource} done:^(NSDictionary *tokens, NSString *error) {
        if (tokens) [self storeTokens:tokens];
        else if ([error isEqual:@"expired"]) { [self forgetSession]; }
        NSArray *waiters = [self.refreshWaiters copy]; [self.refreshWaiters removeAllObjects];
        for (void (^waiter)(NSString *, NSString *) in waiters) waiter(tokens ? self.session[@"access_token"] : nil, error);
    }];
}

- (void)forgetSession {
    self.session = [NSMutableDictionary new];
    [NSFileManager.defaultManager removeItemAtURL:[self.root URLByAppendingPathComponent:@"session.json"] error:NULL];
    [self stopCodex:YES]; [self publishAuth];
}

- (void)signOut {
    NSString *refresh = self.session[@"refresh_token"], *client = self.preferences[@"client"];
    if (refresh && client) {
        NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:RevokeURL]];
        request.HTTPMethod = @"POST";
        [request setValue:@"application/x-www-form-urlencoded" forHTTPHeaderField:@"Content-Type"];
        request.HTTPBody = [FormBody(@{@"token":refresh, @"token_type_hint":@"refresh_token", @"client_id":client}) dataUsingEncoding:NSUTF8StringEncoding];
        [[NSURLSession.sharedSession dataTaskWithRequest:request] resume];
    }
    [self forgetSession];
}

#pragma mark Codex

- (NSURL *)codexBinary { return [self.codexRoot URLByAppendingPathComponent:@"bin/codex"]; }
- (NSURL *)codexRule { return [self.codexRoot URLByAppendingPathComponent:@"codex.sb"]; }
- (BOOL)available {
    return [NSFileManager.defaultManager isExecutableFileAtPath:self.codexBinary.path]
        && [NSFileManager.defaultManager fileExistsAtPath:self.codexRule.path];
}

// Codex never runs outside codex.sb: macOS, not Codex, keeps it and every command it
// starts to its program, its home and the scratch copy, and keeps commands off the
// network. Codex's temporary folder lives in its home, since the shared one is closed.
// The path the kernel sees, which the sandbox rule must name. (URLByResolvingSymlinksInPath
// is not it: it drops "/private", so /var/folders would stay /var/folders.)
static NSString *RealPath(NSURL *url) {
    char real[PATH_MAX];
    return realpath(url.fileSystemRepresentation, real) ? [NSString stringWithUTF8String:real] : url.path;
}
- (NSTask *)codexTask:(NSURL *)home arguments:(NSArray *)arguments {
    NSURL *temporary = [home URLByAppendingPathComponent:@"tmp" isDirectory:YES];
    [NSFileManager.defaultManager createDirectoryAtURL:temporary withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL];
    NSString *codex = RealPath(self.codexRoot);   // the rule names real paths
    NSTask *task = [NSTask new];
    task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/sandbox-exec"];
    task.arguments = [@[@"-f", self.codexRule.path, @"-D", [@"CODEX=" stringByAppendingString:codex],
        @"-D", [@"HOME=" stringByAppendingString:RealPath(home)],
        @"-D", [@"WORKSPACE=" stringByAppendingString:RealPath(self.workspace)],
        [codex stringByAppendingPathComponent:@"bin/codex"]] arrayByAddingObjectsFromArray:arguments];
    task.environment = @{@"CODEX_HOME":home.path, @"HOME":NSHomeDirectory(), @"TMPDIR":temporary.path, @"PATH":@"/usr/bin:/bin"};
    return task;
}

- (void)writeCodexConfiguration:(NSURL *)home {
    // codex.sb sets the limits; Codex's own sandbox is off because macOS allows no
    // sandbox inside one. Commands may read the system's own tools and read and write
    // the scratch copy, nothing else: not the person's files, not rach3's other data,
    // not the network, and not the ChatGPT token. Codex itself may search the web
    // (OpenAI runs the search); rach3 fetches anything it shows the person.
    NSString *config =
        @"# Written by rach3 on every start.\n"
        "sandbox_mode = \"danger-full-access\"\n"
        "web_search = \"live\"\n\n"
        "[shell_environment_policy]\n"
        "ignore_default_excludes = false\n"
        "exclude = [\"ACCESS_TOKEN\", \"*TOKEN*\", \"*KEY*\", \"*SECRET*\"]\n";
    [config writeToURL:[home URLByAppendingPathComponent:@"config.toml"] atomically:YES encoding:NSUTF8StringEncoding error:NULL];
}

// Codex's newer models send searches to a separate endpoint that ChatGPT sign-in
// tokens may not use. The Responses API itself accepts its web search tool with
// these tokens, so rach3 hands Codex its own bundled model list with that path on.
- (NSURL *)writeModelCatalog:(NSURL *)home {
    NSTask *task = [self codexTask:home arguments:@[@"debug", @"models", @"--bundled"]];
    NSPipe *output = [NSPipe pipe];
    task.standardOutput = output;
    task.standardError = [NSFileHandle fileHandleForWritingAtPath:@"/dev/null"];
    if (![task launchAndReturnError:NULL]) return nil;
    NSData *data = [output.fileHandleForReading readDataToEndOfFile];
    [task waitUntilExit];
    if (task.terminationStatus != 0) return nil;
    NSMutableDictionary *catalog = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:NULL];
    if (![catalog isKindOfClass:NSDictionary.class] || ![catalog[@"models"] isKindOfClass:NSArray.class] || ![catalog[@"models"] count]) return nil;
    for (NSMutableDictionary *model in catalog[@"models"])
        if ([model isKindOfClass:NSMutableDictionary.class]) model[@"use_responses_lite"] = @NO;
    NSURL *file = [home URLByAppendingPathComponent:@"models.json"];
    NSData *json = [NSJSONSerialization dataWithJSONObject:catalog options:0 error:NULL];
    return [json writeToURL:file atomically:YES] ? file : nil;
}

// Codex running with a sign-in valid for ten more minutes. fresh: a new Codex started,
// which core.js then introduces itself to.
- (void)ensureCodex:(void (^)(NSDictionary *result))done {
    [self freshToken:^(NSString *token, NSString *error) {
        if (error) { done(@{@"error":error}); return; }
        if (self.codex && [self.codexToken isEqual:token]) { done(@{@"fresh":@NO}); return; }
        [self stopCodex:NO];   // Codex reads the token at start
        NSString *failure = [self startCodex:token];
        done(failure ? @{@"error":failure} : @{@"fresh":@YES});
    }];
}

- (NSString *)startCodex:(NSString *)token {
    if (!self.available) return @"missing";
    NSURL *home = [self.root URLByAppendingPathComponent:@"codex" isDirectory:YES];
    [NSFileManager.defaultManager createDirectoryAtURL:home withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL];
    [NSFileManager.defaultManager createDirectoryAtURL:self.workspace withIntermediateDirectories:YES attributes:nil error:NULL];
    [self writeCodexConfiguration:home];
    NSString *provider = @"model_providers.chatgpt_plan", *upstream = Resource;
#ifdef PIANO_CAPTURE
    // Development builds can talk to a stand-in for OpenAI, to try a whole change offline.
    if (NSProcessInfo.processInfo.environment[@"RACH3_CODEX_UPSTREAM"].length) upstream = NSProcessInfo.processInfo.environment[@"RACH3_CODEX_UPSTREAM"];
#endif
    NSArray *arguments = @[@"app-server", @"--listen", @"stdio://",
        @"-c", @"model_provider=\"chatgpt_plan\"",
        @"-c", [provider stringByAppendingString:@".name=\"ChatGPT plan\""],
        @"-c", [provider stringByAppendingFormat:@".base_url=%@", TomlString(upstream)],
        @"-c", [provider stringByAppendingString:@".env_key=\"ACCESS_TOKEN\""],
        @"-c", [provider stringByAppendingString:@".wire_api=\"responses\""],
        @"-c", [provider stringByAppendingString:@".requires_openai_auth=false"],
        @"-c", [provider stringByAppendingString:@".supports_websockets=false"]];
    NSURL *catalog = [self writeModelCatalog:home];
    if (catalog) arguments = [arguments arrayByAddingObjectsFromArray:@[@"-c", [@"model_catalog_json=" stringByAppendingString:TomlString(catalog.path)]]];
    NSTask *task = [self codexTask:home arguments:arguments];
    NSDictionary *inherited = NSProcessInfo.processInfo.environment;
    NSMutableDictionary *environment = [task.environment mutableCopy];
    for (NSString *key in @[@"USER", @"LOGNAME", @"LANG", @"__CF_USER_TEXT_ENCODING"]) if (inherited[key]) environment[key] = inherited[key];
    environment[@"PATH"] = [[self.codexRoot URLByAppendingPathComponent:@"codex-path"].path stringByAppendingString:@":/usr/bin:/bin:/usr/sbin:/sbin"];
    environment[@"SHELL"] = @"/bin/zsh";
    environment[@"CODEX_HOME"] = home.path;
    environment[@"ACCESS_TOKEN"] = token;
    task.environment = environment;
    task.currentDirectoryURL = self.workspace;
    NSPipe *input = [NSPipe pipe], *output = [NSPipe pipe];
    task.standardInput = input; task.standardOutput = output;
    task.standardError = [NSFileHandle fileHandleForWritingAtPath:@"/dev/null"];
#ifdef PIANO_CAPTURE
    NSString *log = [home URLByAppendingPathComponent:@"stderr.log"].path;
    [NSFileManager.defaultManager createFileAtPath:log contents:nil attributes:nil];
    task.standardError = [NSFileHandle fileHandleForWritingAtPath:log] ?: task.standardError;
#endif
    self.codexBuffer = [NSMutableData new];
    __weak CustomizeService *weakSelf = self;
    output.fileHandleForReading.readabilityHandler = ^(NSFileHandle *handle) {
        NSData *chunk = handle.availableData;
        dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf receive:chunk from:task]; });
    };
    task.terminationHandler = ^(NSTask *ended) {
        output.fileHandleForReading.readabilityHandler = nil;
        dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf codexEnded:ended]; });
    };
    NSError *error;
    if (![task launchAndReturnError:&error]) return @"missing";
    self.codex = task; self.codexInput = input.fileHandleForWriting; self.codexToken = token;
    return nil;
}

// notify: core.js is told Codex stopped (it fails what was waiting on it). A restart
// for a new sign-in does not tell it; it learns from codex-ensure.
- (void)stopCodex:(BOOL)notify {
    NSTask *task = self.codex;
    self.codex = nil; self.codexInput = nil; self.codexToken = nil;
    if (task.running) [task terminate];
    if (task && notify) [self toCoreIfReady:@{@"codex":@"exit"}];
}
- (void)toCoreIfReady:(NSDictionary *)message { if (self.coreReady && self.onCore) self.onCore(message); }

- (void)codexEnded:(NSTask *)task {
    if (task != self.codex) return;
    self.codex = nil; self.codexInput = nil; self.codexToken = nil;
    [self toCoreIfReady:@{@"codex":@"exit"}];
}

- (void)stop { [self cancelSignIn]; [self stopCodex:NO]; }

- (void)writeLine:(NSString *)line {
    NSMutableData *data = [[line dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
    [data appendBytes:"\n" length:1];
    @try { [self.codexInput writeData:data]; } @catch (NSException *exception) { (void)exception; }
}

- (void)receive:(NSData *)chunk from:(NSTask *)task {
    if (task != self.codex) return;
    [self.codexBuffer appendData:chunk];
    while (YES) {
        NSRange newline = [self.codexBuffer rangeOfData:[NSData dataWithBytes:"\n" length:1] options:0 range:NSMakeRange(0, self.codexBuffer.length)];
        if (newline.location == NSNotFound) break;
        NSData *line = [self.codexBuffer subdataWithRange:NSMakeRange(0, newline.location)];
        [self.codexBuffer replaceBytesInRange:NSMakeRange(0, newline.location + 1) withBytes:NULL length:0];
        NSString *text = [[NSString alloc] initWithData:line encoding:NSUTF8StringEncoding];
        if (text) [self toCoreIfReady:@{@"codex":@"line", @"text":text}];
    }
}

#pragma mark Hidden preview

+ (NSString *)errorScript {
    // desktop/customize/page-errors.js, shared with Windows.
    NSURL *file = [NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"Customize/page-errors.js"];
    return [NSString stringWithContentsOfURL:file encoding:NSUTF8StringEncoding error:NULL] ?: @"";
}

// Opens the scratch copy in a window the person never sees, runs script, and answers
// {errors, scriptResult, image, snapshotError} or {timedOut, errors}.
- (void)preview:(NSString *)script done:(void (^)(NSDictionary *))done {
    NSSize size = self.previewSize.width > 0 ? self.previewSize : NSMakeSize(1340, 900);
    if (!self.previewView) {
        WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
        configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        [configuration setURLSchemeHandler:self forURLScheme:@"rach3-preview"];
        [configuration.userContentController addScriptMessageHandlerWithReply:self contentWorld:WKContentWorld.pageWorld name:@"rach3"];
        [configuration.userContentController addUserScript:[[WKUserScript alloc] initWithSource:CustomizeService.errorScript
            injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
        [configuration.userContentController addUserScript:[[WKUserScript alloc] initWithSource:@"document.documentElement.dataset.windowControls='mac';"
            injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
        self.previewView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, size.width, size.height) configuration:configuration];
        self.previewView.navigationDelegate = self;
        // Far off screen: it renders like a real window but the person never sees it.
        self.previewWindow = [[NSWindow alloc] initWithContentRect:NSMakeRect(-20000, -20000, size.width, size.height)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        self.previewWindow.releasedWhenClosed = NO;
        self.previewWindow.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
        self.previewWindow.contentView = self.previewView;
        self.previewWindow.ignoresMouseEvents = YES;
    }
    [self.previewWindow setContentSize:size];
    [self.previewWindow orderBack:nil];
    self.previewErrors = [NSMutableArray new];
    __block BOOL finished = NO;
    void (^finish)(NSDictionary *) = ^(NSDictionary *result) {
        if (finished) return;
        finished = YES; self.previewLoaded = nil;
        [self.previewWindow orderOut:nil];
        done(result);
    };
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 25 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        finish(@{@"timedOut":@YES, @"errors":[self.previewErrors copy] ?: @[]});
    });
    // Held only until the preview finishes (finish clears it), so the cycle is brief.
    void (^loaded)(void) = ^{
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            [self.previewView callAsyncJavaScript:script ?: @"return null;" arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld
                completionHandler:^(id value, NSError *scriptError) {
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.8 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
                    [self.previewView takeSnapshotWithConfiguration:nil completionHandler:^(NSImage *image, NSError *snapshotError) {
                        NSMutableDictionary *result = [@{@"errors":[self.previewErrors copy] ?: @[]} mutableCopy];
                        if (script) result[@"scriptResult"] = scriptError ? [@"Error: " stringByAppendingString:scriptError.localizedDescription] : (value ? [value description] : @"undefined");
                        NSBitmapImageRep *bitmap = image ? [[NSBitmapImageRep alloc] initWithData:image.TIFFRepresentation] : nil;
                        NSData *jpeg = [bitmap representationUsingType:NSBitmapImageFileTypeJPEG properties:@{NSImageCompressionFactor:@0.72}];
                        if (jpeg) result[@"image"] = [@"data:image/jpeg;base64," stringByAppendingString:[jpeg base64EncodedStringWithOptions:0]];
                        else result[@"snapshotError"] = snapshotError.localizedDescription ?: @"unknown";
                        finish(result);
                    }];
                });
            }];
        });
    };
    self.previewLoaded = loaded;
    WKWebView *preview = self.previewView;
    [CustomizeService blockInternetIn:preview.configuration.userContentController then:^{
        [preview loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@"rach3-preview://app/piano.html"]]];
    }];
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    (void)navigation;
    if (webView == self.previewView && self.previewLoaded) self.previewLoaded();
}
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    (void)webView;
    decisionHandler([action.request.URL.scheme isEqual:@"rach3-preview"] ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}

// The preview page talks to the same native commands as the real one, but only
// the read-only ones are answered; nothing it does reaches the piano or lessons.
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message
    replyHandler:(void (^)(id, NSString *))replyHandler {
    (void)controller;
    NSDictionary *body = [message.body isKindOfClass:NSDictionary.class] ? message.body : @{};
    if ([body[@"command"] isEqual:@"page-error"]) {
        if (self.previewErrors.count < 30) [self.previewErrors addObject:body];
        replyHandler(@{}, nil); return;
    }
    if (!self.previewBridge) { replyHandler(@{}, nil); return; }
    self.previewBridge(body, ^(id value) { replyHandler(value ?: @{}, nil); });
}

@end
