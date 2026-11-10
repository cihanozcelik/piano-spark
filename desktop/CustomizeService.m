#import "CustomizeService.h"
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

// Codex reports these to the panel; everything else stays between rach3 and Codex.
static NSSet<NSString *> *ForwardedNotifications(void) {
    static NSSet *names; static dispatch_once_t once;
    dispatch_once(&once, ^{ names = [NSSet setWithArray:@[@"turn/started", @"turn/completed", @"item/started", @"item/completed",
        @"item/agentMessage/delta", @"thread/tokenUsage/updated", @"error"]]; });
    return names;
}

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
static NSNumber *Milliseconds(void) { return @((long long)(NSDate.date.timeIntervalSince1970 * 1000)); }

@interface CustomizeService ()
@property (nonatomic, strong) NSURL *source;          // original design, inside the app bundle
@property (nonatomic, strong) NSURL *codexRoot;       // bundled Codex package
@property (nonatomic, strong) NSURL *root;            // Application Support/Rach3/Customize
@property (nonatomic, copy) NSString *version;
@property (nonatomic, strong) NSMutableDictionary *designs;
@property (nonatomic, strong) NSMutableDictionary *usage;
@property (nonatomic, strong) NSMutableDictionary *session;
@property (nonatomic, strong) NSMutableDictionary *preferences;
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
@property (nonatomic) BOOL codexReady;
@property (nonatomic, strong) NSMutableArray *codexWaiters;
@property (nonatomic, strong) NSMutableDictionary *callbacks;
@property (nonatomic) long long nextRequest;
@property (nonatomic, strong) NSMutableSet *loadedThreads;
// the change being made right now
@property (nonatomic, strong) NSMutableDictionary *turn;
@property (nonatomic, copy) NSString *thread;
@property (nonatomic, strong) NSURL *support;
@property (nonatomic, strong) NSMutableArray *pageErrors;
// hidden preview of the scratch copy, for Codex to check its work
@property (nonatomic, strong) NSWindow *previewWindow;
@property (nonatomic, strong) WKWebView *previewView;
@property (nonatomic, strong) NSMutableArray *previewErrors;
@property (nonatomic, copy) void (^previewLoaded)(void);
@end

@implementation CustomizeService

+ (NSString *)scheme { return @"rach3-app"; }
+ (NSURL *)pageURL { return [NSURL URLWithString:@"rach3-app://app/piano.html"]; }

- (instancetype)initWithSource:(NSURL *)source codex:(NSURL *)codex support:(NSURL *)support version:(NSString *)version {
    if ((self = [super init])) {
        self.source = source; self.codexRoot = codex; self.version = version ?: @"";
        self.support = support; self.pageErrors = [NSMutableArray new];
        self.root = [support URLByAppendingPathComponent:@"Customize" isDirectory:YES];
        [NSFileManager.defaultManager createDirectoryAtURL:[self.root URLByAppendingPathComponent:@"designs"]
            withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL];
        self.designs = [self load:@"designs.json"] ?: [@{@"active":@"original", @"designs":@[]} mutableCopy];
        self.designs[@"designs"] = [self.designs[@"designs"] mutableCopy] ?: [NSMutableArray new];
        self.usage = [self load:@"usage.json"] ?: [NSMutableDictionary new];
        for (NSString *key in @[@"days", @"threads"]) self.usage[key] = [self.usage[key] mutableCopy] ?: [NSMutableDictionary new];
        self.session = [self load:@"session.json"] ?: [NSMutableDictionary new];
        self.preferences = [self load:@"preferences.json"] ?: [NSMutableDictionary new];
        self.listener = -1;
        self.callbacks = [NSMutableDictionary new]; self.codexWaiters = [NSMutableArray new];
        self.refreshWaiters = [NSMutableArray new]; self.loadedThreads = [NSMutableSet new];
        self.thread = self.preferences[@"thread"];
        // A design that was removed outside the app falls back to the original.
        if (![self designRoot:self.designs[@"active"]]) { self.designs[@"active"] = @"original"; [self save:self.designs as:@"designs.json"]; }
        [NSFileManager.defaultManager removeItemAtURL:[self.root URLByAppendingPathComponent:@"workspace"] error:NULL];
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
- (NSURL *)designRoot:(NSString *)identifier {
    if (!identifier || [identifier isEqual:@"original"]) return self.source;
    for (NSDictionary *design in self.designs[@"designs"]) if ([design[@"id"] isEqual:identifier]) {
        NSURL *url = [[self.root URLByAppendingPathComponent:@"designs" isDirectory:YES] URLByAppendingPathComponent:identifier isDirectory:YES];
        BOOL folder = NO;
        return [NSFileManager.defaultManager fileExistsAtPath:url.path isDirectory:&folder] && folder ? url : nil;
    }
    return nil;
}
- (NSURL *)activeRoot { return [self designRoot:self.designs[@"active"]] ?: self.source; }
- (BOOL)busy { return self.turn != nil; }

#pragma mark Page files

static NSString *MimeType(NSString *extension) {
    NSDictionary *types = @{@"html":@"text/html; charset=utf-8", @"js":@"text/javascript; charset=utf-8", @"mjs":@"text/javascript; charset=utf-8",
        @"css":@"text/css; charset=utf-8", @"json":@"application/json; charset=utf-8", @"png":@"image/png", @"jpg":@"image/jpeg",
        @"jpeg":@"image/jpeg", @"svg":@"image/svg+xml", @"woff2":@"font/woff2", @"woff":@"font/woff", @"mid":@"audio/midi",
        @"wasm":@"application/wasm", @"txt":@"text/plain; charset=utf-8", @"md":@"text/plain; charset=utf-8"};
    return types[extension.lowercaseString] ?: @"application/octet-stream";
}

- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
    (void)webView;
    NSURL *url = task.request.URL;
    NSString *path = url.path.length > 1 ? [url.path substringFromIndex:1] : @"piano.html";
    BOOL preview = [url.scheme isEqual:@"rach3-preview"];
    NSURL *root = (preview ? self.workspace : self.activeRoot).URLByStandardizingPath;
    if ([path isEqual:@"piano.html"] && task.request.mainDocumentURL && [task.request.URL isEqual:task.request.mainDocumentURL]) {
        if (preview) [self.previewErrors removeAllObjects];
        else if (self.pageErrors.count) { [self.pageErrors removeAllObjects]; [self publishState]; }
    }
    NSURL *file = [root URLByAppendingPathComponent:path].URLByStandardizingPath;
    NSData *data = nil;
    BOOL inside = [url.host isEqual:@"app"] && [file.path hasPrefix:[root.path stringByAppendingString:@"/"]];
    for (NSString *part in path.pathComponents) if ([part hasPrefix:@"."]) inside = NO;
    if (inside) data = [NSData dataWithContentsOfURL:file];
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:url statusCode:data ? 200 : 404 HTTPVersion:@"HTTP/1.1"
        headerFields:@{@"Content-Type":data ? MimeType(file.pathExtension) : @"text/plain", @"Cache-Control":@"no-store",
                       @"Content-Length":@(data.length).stringValue}];
    [task didReceiveResponse:response];
    if (data) [task didReceiveData:data];
    [task didFinish];
}
- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task { (void)webView; (void)task; }

#pragma mark State for the panel

- (NSDictionary *)account {
    if (!self.session[@"refresh_token"]) return nil;
    NSDictionary *claims = Claims(self.session[@"id_token"]) ?: @{};
    return @{@"email":claims[@"email"] ?: @"", @"name":claims[@"name"] ?: @""};
}
- (NSString *)today {
    NSDateFormatter *format = [NSDateFormatter new];
    format.dateFormat = @"yyyy-MM-dd"; format.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    return [format stringFromDate:NSDate.date];
}
- (NSDictionary *)state {
    NSMutableDictionary *state = [@{@"event":@"customize-state", @"language":PianoLanguage(), @"signedIn":@(self.account != nil),
        @"account":self.account ?: NSNull.null, @"signingIn":@(self.signingIn), @"signInError":self.signInError ?: NSNull.null,
        @"welcomed":@([self.preferences[@"welcomed"] boolValue]), @"open":@([self.preferences[@"open"] boolValue]),
        @"active":self.designs[@"active"], @"designs":self.designs[@"designs"], @"thread":self.thread ?: NSNull.null,
        @"today":self.usage[@"days"][self.today] ?: @{}, @"threadUsage":self.usage[@"threads"],
        @"available":@([NSFileManager.defaultManager isExecutableFileAtPath:self.codexBinary.path]),
        @"pageErrors":self.pageErrors} mutableCopy];
    if (self.turn) state[@"turn"] = @{@"thread":self.turn[@"thread"] ?: NSNull.null, @"turn":self.turn[@"turn"] ?: NSNull.null,
        @"prompt":self.turn[@"prompt"], @"tokens":self.turn[@"tokens"]};
    return state;
}
- (void)publishState { if (self.onEvent) self.onEvent(self.state); }
- (void)publish:(NSDictionary *)event { if (self.onEvent) self.onEvent(event); }

#pragma mark Requests from the panel

- (void)handle:(NSDictionary *)request reply:(void (^)(id, NSString *))reply {
    NSString *action = request[@"action"];
    if (![action isKindOfClass:NSString.class]) { reply(nil, @"invalid"); return; }
    if ([action isEqual:@"state"]) reply(self.state, nil);
    else if ([action isEqual:@"panel"]) {
        self.preferences[@"open"] = @([request[@"open"] boolValue]); [self save:self.preferences as:@"preferences.json"]; reply(@{}, nil);
    } else if ([action isEqual:@"welcomed"]) {
        self.preferences[@"welcomed"] = @YES; [self save:self.preferences as:@"preferences.json"]; reply(@{}, nil); [self publishState];
    } else if ([action isEqual:@"sign-in"]) { [self signIn]; reply(@{}, nil); }
    else if ([action isEqual:@"cancel-sign-in"]) { [self cancelSignIn]; reply(@{}, nil); }
    else if ([action isEqual:@"sign-out"]) { [self signOut]; reply(@{}, nil); }
    else if ([action isEqual:@"open-usage"]) { [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:UsageURL]]; reply(@{}, nil); }
    else if ([action isEqual:@"send"]) {
        NSString *text = request[@"text"];
        if (![text isKindOfClass:NSString.class] || ![text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length) { reply(nil, @"empty"); return; }
        if (self.turn) { reply(nil, @"busy"); return; }
        [self send:[text substringToIndex:MIN(text.length, (NSUInteger)8000)] reply:reply];
    } else if ([action isEqual:@"stop"]) {
        if (self.turn[@"turn"]) [self call:@"turn/interrupt" params:@{@"threadId":self.turn[@"thread"], @"turnId":self.turn[@"turn"]} done:nil];
        reply(@{}, nil);
    } else if ([action isEqual:@"new-thread"]) {
        if (self.turn) { reply(nil, @"busy"); return; }
        self.thread = nil; [self.preferences removeObjectForKey:@"thread"]; [self save:self.preferences as:@"preferences.json"];
        reply(@{}, nil); [self publishState];
    } else if ([action isEqual:@"threads"]) {
        [self withCodex:^(NSString *error) {
            if (error) { reply(nil, error); return; }
            [self call:@"thread/list" params:@{@"limit":@60} done:^(id result, NSDictionary *failure) {
                reply(result, failure ? @"codex" : nil);
            }];
        }];
    } else if ([action isEqual:@"open-thread"]) {
        NSString *identifier = request[@"thread"];
        if (![identifier isKindOfClass:NSString.class] || self.turn) { reply(nil, self.turn ? @"busy" : @"invalid"); return; }
        [self withCodex:^(NSString *error) {
            if (error) { reply(nil, error); return; }
            [self call:@"thread/read" params:@{@"threadId":identifier, @"includeTurns":@YES} done:^(id result, NSDictionary *failure) {
                if (failure) { reply(nil, @"codex"); return; }
                self.thread = identifier; self.preferences[@"thread"] = identifier; [self save:self.preferences as:@"preferences.json"];
                reply(result, nil);
            }];
        }];
    } else if ([action isEqual:@"use-design"]) {
        NSString *identifier = request[@"design"];
        if (![identifier isKindOfClass:NSString.class] || ![self designRoot:identifier]) { reply(nil, @"invalid"); return; }
        if (self.turn) { reply(nil, @"busy"); return; }
        self.designs[@"active"] = identifier; [self save:self.designs as:@"designs.json"];
        reply(@{}, nil); [self publishState]; if (self.onReload) self.onReload();
    } else if ([action isEqual:@"delete-design"]) {
        NSString *identifier = request[@"design"];
        if (![identifier isKindOfClass:NSString.class] || [identifier isEqual:@"original"] || ![self designRoot:identifier]) { reply(nil, @"invalid"); return; }
        if (self.turn) { reply(nil, @"busy"); return; }
        [self deleteDesign:identifier]; reply(@{}, nil);
    } else if ([action isEqual:@"rename-design"]) {
        NSString *identifier = request[@"design"], *title = request[@"title"];
        if (![title isKindOfClass:NSString.class] || ![title stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].length) { reply(nil, @"invalid"); return; }
        for (NSMutableDictionary *design in self.designs[@"designs"]) if ([design[@"id"] isEqual:identifier]) design[@"title"] = [title substringToIndex:MIN(title.length, (NSUInteger)120)];
        [self save:self.designs as:@"designs.json"]; reply(@{}, nil); [self publishState];
    } else reply(nil, @"invalid");
}

- (void)restoreOriginal {
    if (self.turn) return;
    self.designs[@"active"] = @"original"; [self save:self.designs as:@"designs.json"];
    [self publishState]; if (self.onReload) self.onReload();
}

- (void)deleteDesign:(NSString *)identifier {
    NSMutableArray *list = self.designs[@"designs"];
    NSDictionary *removed = nil;
    for (NSDictionary *design in list) if ([design[@"id"] isEqual:identifier]) removed = design;
    if (!removed) return;
    // Designs made from the removed one now come from its parent.
    for (NSMutableDictionary *design in list) if ([design[@"parent"] isEqual:identifier]) design[@"parent"] = removed[@"parent"] ?: @"original";
    [list removeObject:removed];
    [NSFileManager.defaultManager removeItemAtURL:[[self.root URLByAppendingPathComponent:@"designs"] URLByAppendingPathComponent:identifier] error:NULL];
    BOOL wasActive = [self.designs[@"active"] isEqual:identifier];
    if (wasActive) self.designs[@"active"] = removed[@"parent"] && [self designRoot:removed[@"parent"]] ? removed[@"parent"] : @"original";
    [self save:self.designs as:@"designs.json"]; [self publishState];
    if (wasActive && self.onReload) self.onReload();
}

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
    if (fd < 0) { self.signInError = @"port"; [self publishState]; return; }
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
    self.listener = fd; self.signingIn = YES; self.signInError = nil; [self publishState];
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
            if (!callback) { self.signingIn = NO; [self publishState]; return; }
            if (callback[@"error"] || ![callback[@"state"] isEqual:state] || !callback[@"code"]) {
                self.signingIn = NO; self.signInError = [callback[@"error"] isEqual:@"access_denied"] ? @"denied" : @"failed";
                [self publishState]; return;
            }
            NSString *issued = callback[@"client_id"] ?: client;
            [self token:@{@"grant_type":@"authorization_code", @"client_id":issued, @"code":callback[@"code"], @"code_verifier":verifier,
                          @"redirect_uri":redirect, @"resource":Resource} done:^(NSDictionary *tokens, NSString *error) {
                self.signingIn = NO;
                NSDictionary *claims = Claims(tokens[@"id_token"]);
                if (!error && (![claims[@"nonce"] isEqual:nonce] || ![claims[@"iss"] isEqual:@"https://auth.openai.com"])) error = @"failed";
                if (!error && ![[tokens[@"scope"] componentsSeparatedByString:@" "] containsObject:PlanScope]) error = @"plan";
                if (error) { self.signInError = error; [self publishState]; return; }
                self.preferences[@"client"] = issued; [self save:self.preferences as:@"preferences.json"];
                [self storeTokens:tokens];
                [NSApp activateIgnoringOtherApps:YES];
                [self publishState];
            }];
        });
    });
    [NSWorkspace.sharedWorkspace openURL:components.URL];
}

- (void)cancelSignIn {
    if (self.listener >= 0) shutdown(self.listener, SHUT_RDWR);
    self.signingIn = NO; [self publishState];
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
    [self stopCodex]; [self publishState];
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

- (void)writeCodexConfiguration:(NSURL *)home {
    // Commands Codex runs may read the system's own tools and read and write the
    // scratch copy, nothing else: not the person's files, not rach3's other data.
    NSString *config = [NSString stringWithFormat:
        @"# Written by rach3 on every start.\n"
        "default_permissions = \"rach3\"\n\n"
        "[permissions.rach3.filesystem]\n"
        "\":minimal\" = \"read\"\n"
        "%@ = \"write\"\n", TomlString(self.workspace.path)];
    [config writeToURL:[home URLByAppendingPathComponent:@"config.toml"] atomically:YES encoding:NSUTF8StringEncoding error:NULL];
}

- (void)withCodex:(void (^)(NSString *error))done {
    [self freshToken:^(NSString *token, NSString *error) {
        if (error) { done(error); return; }
        if (self.codex && ![self.codexToken isEqual:token]) [self stopCodex];   // Codex reads the token at start
        if (self.codexReady) { done(nil); return; }
        [self.codexWaiters addObject:[done copy]];
        if (self.codex) return;
        NSString *failure = [self startCodex:token];
        if (failure) {
            NSArray *waiters = [self.codexWaiters copy]; [self.codexWaiters removeAllObjects];
            for (void (^waiter)(NSString *) in waiters) waiter(failure);
        }
    }];
}

- (NSString *)startCodex:(NSString *)token {
    if (![NSFileManager.defaultManager isExecutableFileAtPath:self.codexBinary.path]) return @"missing";
    NSURL *home = [self.root URLByAppendingPathComponent:@"codex" isDirectory:YES];
    [NSFileManager.defaultManager createDirectoryAtURL:home withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL];
    [NSFileManager.defaultManager createDirectoryAtURL:self.workspace withIntermediateDirectories:YES attributes:nil error:NULL];
    [self writeCodexConfiguration:home];
    NSString *provider = @"model_providers.chatgpt_plan";
    NSTask *task = [NSTask new];
    task.executableURL = self.codexBinary;
    task.arguments = @[@"app-server", @"--listen", @"stdio://",
        @"-c", @"model_provider=\"chatgpt_plan\"",
        @"-c", [provider stringByAppendingString:@".name=\"ChatGPT plan\""],
        @"-c", [provider stringByAppendingFormat:@".base_url=%@", TomlString(Resource)],
        @"-c", [provider stringByAppendingString:@".env_key=\"ACCESS_TOKEN\""],
        @"-c", [provider stringByAppendingString:@".wire_api=\"responses\""],
        @"-c", [provider stringByAppendingString:@".requires_openai_auth=false"],
        @"-c", [provider stringByAppendingString:@".supports_websockets=false"]];
    NSDictionary *inherited = NSProcessInfo.processInfo.environment;
    NSMutableDictionary *environment = [NSMutableDictionary new];
    for (NSString *key in @[@"HOME", @"USER", @"LOGNAME", @"LANG", @"TMPDIR", @"__CF_USER_TEXT_ENCODING"]) if (inherited[key]) environment[key] = inherited[key];
    environment[@"PATH"] = [[self.codexRoot URLByAppendingPathComponent:@"codex-path"].path stringByAppendingString:@":/usr/bin:/bin:/usr/sbin:/sbin"];
    environment[@"SHELL"] = @"/bin/zsh";
    environment[@"CODEX_HOME"] = home.path;
    environment[@"ACCESS_TOKEN"] = token;
    task.environment = environment;
    task.currentDirectoryURL = self.workspace;
    NSPipe *input = [NSPipe pipe], *output = [NSPipe pipe];
    task.standardInput = input; task.standardOutput = output;
    task.standardError = [NSFileHandle fileHandleForWritingAtPath:@"/dev/null"];
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
    self.codexReady = NO; [self.loadedThreads removeAllObjects];
    [self call:@"initialize" params:@{@"clientInfo":@{@"name":@"rach3", @"title":@"rach3", @"version":self.version},
                                      @"capabilities":@{@"experimentalApi":@YES}} done:^(id result, NSDictionary *failure) {
        (void)result;
        if (task != self.codex) return;
        if (!failure) { [self write:@{@"method":@"initialized"}]; self.codexReady = YES; }
        NSArray *waiters = [self.codexWaiters copy]; [self.codexWaiters removeAllObjects];
        for (void (^waiter)(NSString *) in waiters) waiter(failure ? @"codex" : nil);
    }];
    return nil;
}

- (void)stopCodex {
    NSTask *task = self.codex;
    self.codex = nil; self.codexReady = NO; self.codexInput = nil;
    if (task.running) [task terminate];
    [self failPending];
}

- (void)failPending {
    NSDictionary *callbacks = [self.callbacks copy]; [self.callbacks removeAllObjects];
    for (NSNumber *key in callbacks) ((void (^)(id, NSDictionary *))callbacks[key])(nil, @{@"message":@"Codex stopped"});
    NSArray *waiters = [self.codexWaiters copy]; [self.codexWaiters removeAllObjects];
    for (void (^waiter)(NSString *) in waiters) waiter(@"codex");
    if (self.turn) [self finishTurn:@"failed" error:@"codex"];
}

- (void)codexEnded:(NSTask *)task {
    if (task != self.codex) return;
    self.codex = nil; self.codexReady = NO; self.codexInput = nil;
    [self failPending];
}

- (void)stop { [self cancelSignIn]; [self stopCodex]; }

- (void)write:(NSDictionary *)message {
    NSMutableData *line = [[NSJSONSerialization dataWithJSONObject:message options:0 error:NULL] mutableCopy];
    [line appendBytes:"\n" length:1];
    @try { [self.codexInput writeData:line]; } @catch (NSException *exception) { (void)exception; }
}

- (void)call:(NSString *)method params:(NSDictionary *)params done:(void (^)(id result, NSDictionary *error))done {
    if (!self.codexInput) { if (done) done(nil, @{@"message":@"Codex is not running"}); return; }
    NSNumber *identifier = @(++self.nextRequest);
    if (done) self.callbacks[identifier] = [done copy];
    [self write:@{@"id":identifier, @"method":method, @"params":params ?: @{}}];
}

- (void)receive:(NSData *)chunk from:(NSTask *)task {
    if (task != self.codex) return;
    [self.codexBuffer appendData:chunk];
    while (YES) {
        NSRange newline = [self.codexBuffer rangeOfData:[NSData dataWithBytes:"\n" length:1] options:0 range:NSMakeRange(0, self.codexBuffer.length)];
        if (newline.location == NSNotFound) break;
        NSData *line = [self.codexBuffer subdataWithRange:NSMakeRange(0, newline.location)];
        [self.codexBuffer replaceBytesInRange:NSMakeRange(0, newline.location + 1) withBytes:NULL length:0];
        id message = [NSJSONSerialization JSONObjectWithData:line options:0 error:NULL];
        if ([message isKindOfClass:NSDictionary.class]) [self dispatch:message];
    }
}

- (void)dispatch:(NSDictionary *)message {
    NSString *method = message[@"method"];
    id identifier = message[@"id"];
    if (!method && identifier) {
        void (^done)(id, NSDictionary *) = self.callbacks[identifier];
        [self.callbacks removeObjectForKey:identifier];
        if (done) done(message[@"result"], message[@"error"]);
        return;
    }
    if (identifier) {
        // Codex asks before stepping outside its box. The answer is always no.
        if ([method hasSuffix:@"requestApproval"]) [self write:@{@"id":identifier, @"result":@{@"decision":@"decline"}}];
        else if ([method isEqual:@"item/tool/call"]) {
            [self runTool:message[@"params"] done:^(NSArray *content, BOOL success) {
                [self write:@{@"id":identifier, @"result":@{@"contentItems":content, @"success":@(success)}}];
            }];
        }
        else [self write:@{@"id":identifier, @"error":@{@"code":@-32601, @"message":@"Not supported by rach3"}}];
        return;
    }
    NSDictionary *params = message[@"params"];
    if (![params isKindOfClass:NSDictionary.class]) return;
    if (self.turn && [params[@"threadId"] isEqual:self.turn[@"thread"]]) [self track:method params:params];
    if ([ForwardedNotifications() containsObject:method]) [self publish:@{@"event":@"customize-codex", @"method":method, @"params":params}];
}

#pragma mark Making a change

// Codex always starts from a fresh copy of the design on screen.
- (BOOL)prepareWorkspace {
    NSFileManager *files = NSFileManager.defaultManager;
    [files removeItemAtURL:self.workspace error:NULL];
    return [files copyItemAtURL:self.activeRoot toURL:self.workspace error:NULL];
}

- (void)send:(NSString *)text reply:(void (^)(id, NSString *))reply {
    NSString *base = self.designs[@"active"];
    self.turn = [@{@"prompt":text, @"base":base, @"thread":self.thread ?: NSNull.null, @"files":[NSMutableSet new], @"outside":@NO, @"lessons":[NSMutableArray new],
                   @"tokens":[@{@"input":@0, @"cached":@0, @"output":@0, @"total":@0} mutableCopy], @"started":Milliseconds()} mutableCopy];
    [self publishState];
    __weak CustomizeService *weakSelf = self;
    void (^fail)(NSString *) = ^(NSString *error) { [weakSelf finishTurn:@"failed" error:error]; reply(nil, error); };
    [self withCodex:^(NSString *error) {
        if (error) { fail(error); return; }
        if (![self prepareWorkspace]) { fail(@"workspace"); return; }
        void (^start)(NSString *) = ^(NSString *thread) {
            self.thread = thread; self.turn[@"thread"] = thread;
            self.preferences[@"thread"] = thread; [self save:self.preferences as:@"preferences.json"];
            [self call:@"turn/start" params:@{@"threadId":thread, @"cwd":self.workspace.path, @"approvalPolicy":@"never",
                @"input":@[@{@"type":@"text", @"text":text, @"text_elements":@[]}]} done:^(id result, NSDictionary *failure) {
                if (failure) { fail(@"codex"); return; }
                self.turn[@"turn"] = result[@"turn"][@"id"] ?: NSNull.null;
                reply(@{@"thread":thread}, nil); [self publishState];
            }];
        };
        NSString *thread = self.thread;
        if (!thread) {
            [self call:@"thread/start" params:@{@"cwd":self.workspace.path, @"approvalPolicy":@"never", @"serviceName":@"rach3",
                @"developerInstructions":self.instructions, @"dynamicTools":self.toolSpecs} done:^(id result, NSDictionary *failure) {
                NSString *identifier = result[@"thread"][@"id"];
                if (failure || !identifier) { fail(@"codex"); return; }
                [self.loadedThreads addObject:identifier]; start(identifier);
            }];
        } else if (![self.loadedThreads containsObject:thread]) {
            [self call:@"thread/resume" params:@{@"threadId":thread, @"cwd":self.workspace.path, @"approvalPolicy":@"never",
                @"developerInstructions":self.instructions} done:^(id result, NSDictionary *failure) {
                (void)result;
                if (failure) { fail(@"codex"); return; }
                [self.loadedThreads addObject:thread]; start(thread);
            }];
        } else start(thread);
    }];
}

#pragma mark Tools Codex can use

+ (NSString *)errorScript {
    return @"(() => {"
        "const send = (kind, detail) => { try { window.webkit.messageHandlers.rach3.postMessage({command:'page-error', kind, ...detail}); } catch {} };"
        "window.addEventListener('error', event => {"
        "  const target = event.target;"
        "  if (target && target !== window && (target.src || target.href)) send('resource', {message: 'Could not load ' + (target.src || target.href)});"
        "  else send('error', {message: event.message, source: event.filename || '', line: event.lineno || 0, column: event.colno || 0, stack: event.error?.stack || ''});"
        "}, true);"
        "window.addEventListener('unhandledrejection', event => send('rejection', {message: String(event.reason?.message || event.reason), stack: event.reason?.stack || ''}));"
        "const original = console.error;"
        "console.error = function(...parts) { send('console', {message: parts.map(part => part?.stack || String(part)).join(' ')}); return original.apply(this, parts); };"
        "})();";
}

static NSDictionary *CleanError(NSDictionary *raw, NSString *design) {
    NSMutableDictionary *error = [NSMutableDictionary new];
    for (NSString *key in @[@"kind", @"message", @"source", @"line", @"column", @"stack"]) {
        id value = raw[key];
        if ([value isKindOfClass:NSString.class]) {
            NSString *text = [[value stringByReplacingOccurrencesOfString:@"rach3-app://app/" withString:@""]
                stringByReplacingOccurrencesOfString:@"rach3-preview://app/" withString:@""];
            error[key] = [text substringToIndex:MIN(text.length, (NSUInteger)2000)];
        } else if ([value isKindOfClass:NSNumber.class]) error[key] = value;
    }
    error[@"design"] = design ?: @"original"; error[@"time"] = Milliseconds();
    return error;
}

- (void)pageError:(NSDictionary *)raw {
    if (self.pageErrors.count >= 20) return;
    [self.pageErrors addObject:CleanError(raw, self.designs[@"active"])];
    [self publishState];
}

static NSDictionary *Text(NSString *text) { return @{@"type":@"inputText", @"text":text ?: @""}; }
static NSString *JSONText(id value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:NULL];
    return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"null";
}

- (NSArray *)toolSpecs {
    NSDictionary *none = @{@"type":@"object", @"properties":@{}, @"additionalProperties":@NO};
    NSDictionary *note = @{@"type":@"array", @"description":@"[midi, start seconds, end seconds, velocity 0-1]", @"items":@{@"type":@"number"}, @"minItems":@4, @"maxItems":@4};
    NSDictionary *track = @{@"type":@"object", @"required":@[@"hand", @"notes"], @"additionalProperties":@NO, @"properties":@{
        @"hand":@{@"type":@"integer", @"enum":@[@0, @1], @"description":@"0 left hand, 1 right hand"},
        @"notes":@{@"type":@"array", @"items":note}}};
    return @[@{@"type":@"namespace", @"name":@"rach3", @"description":@"Look at rach3 the way the person sees it, and work with their lessons.", @"tools":@[
        @{@"type":@"function", @"name":@"preview", @"description":@"Open the current folder (your edited copy) in a hidden rach3 window and return a screenshot plus any runtime errors. Use it after every change. `script` optionally runs in the page first (for example to click a tab); its return value is reported.",
          @"inputSchema":@{@"type":@"object", @"additionalProperties":@NO, @"properties":@{@"script":@{@"type":@"string", @"description":@"Async JavaScript body run in the page; may `return` a value."}}}},
        @{@"type":@"function", @"name":@"page_errors", @"description":@"Runtime errors seen on the person's screen since the design on screen was loaded.", @"inputSchema":none},
        @{@"type":@"function", @"name":@"list_lessons", @"description":@"The person's saved lessons: id, title, note count.", @"inputSchema":none},
        @{@"type":@"function", @"name":@"read_lesson", @"description":@"One lesson: title, description, duration and notes per hand as [midi, start, end, velocity]. Optionally only notes starting between `from` and `to` seconds.",
          @"inputSchema":@{@"type":@"object", @"required":@[@"id"], @"additionalProperties":@NO, @"properties":@{
            @"id":@{@"type":@"string"}, @"from":@{@"type":@"number"}, @"to":@{@"type":@"number"}}}},
        @{@"type":@"function", @"name":@"save_lesson", @"description":@"Create a lesson (no id) or replace one (with id) for the person. Replaced lessons are backed up. Changing notes drops the engraved score, which no longer matches. The lesson opens on screen when saved.",
          @"inputSchema":@{@"type":@"object", @"required":@[@"title"], @"additionalProperties":@NO, @"properties":@{
            @"id":@{@"type":@"string"}, @"title":@{@"type":@"string"}, @"description":@{@"type":@"string"},
            @"tracks":@{@"type":@"array", @"items":track, @"description":@"Omit to keep the notes of an existing lesson."}}}}]}];
}

- (NSURL *)lessonsURL { return [self.support URLByAppendingPathComponent:@"Lessons" isDirectory:YES]; }
- (NSURL *)lessonURL:(NSString *)identifier {
    if (![identifier isKindOfClass:NSString.class] || ![[NSUUID alloc] initWithUUIDString:identifier]) return nil;
    return [self.lessonsURL URLByAppendingPathComponent:[identifier.uppercaseString isEqual:identifier] ? identifier : identifier.lowercaseString].URLByStandardizingPath;
}
- (NSMutableDictionary *)readLesson:(NSString *)identifier {
    for (NSString *name in @[identifier ?: @"", identifier.lowercaseString ?: @"", identifier.uppercaseString ?: @""]) {
        if (![[NSUUID alloc] initWithUUIDString:name]) continue;
        NSData *data = [NSData dataWithContentsOfURL:[self.lessonsURL URLByAppendingPathComponent:[name stringByAppendingPathExtension:@"json"]]];
        id lesson = data ? [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:NULL] : nil;
        if ([lesson isKindOfClass:NSMutableDictionary.class]) return lesson;
    }
    return nil;
}

- (void)runTool:(NSDictionary *)call done:(void (^)(NSArray *content, BOOL success))done {
    NSString *tool = call[@"tool"];
    NSDictionary *arguments = [call[@"arguments"] isKindOfClass:NSDictionary.class] ? call[@"arguments"] : @{};
    if ([tool isEqual:@"page_errors"]) {
        done(@[Text(self.pageErrors.count ? JSONText(self.pageErrors) : @"No runtime errors on screen.")], YES);
    } else if ([tool isEqual:@"preview"]) {
        [self preview:[arguments[@"script"] isKindOfClass:NSString.class] ? arguments[@"script"] : nil done:done];
    } else if ([tool isEqual:@"list_lessons"]) {
        NSMutableArray *list = [NSMutableArray new];
        for (NSURL *url in [NSFileManager.defaultManager contentsOfDirectoryAtURL:self.lessonsURL includingPropertiesForKeys:nil options:0 error:NULL]) {
            if (![url.pathExtension isEqual:@"json"]) continue;
            NSDictionary *lesson = [self readLesson:url.URLByDeletingPathExtension.lastPathComponent];
            if (lesson[@"id"]) [list addObject:@{@"id":lesson[@"id"], @"title":lesson[@"title"] ?: @"", @"noteCount":lesson[@"noteCount"] ?: @0,
                                                  @"duration":lesson[@"duration"] ?: @0}];
        }
        done(@[Text(list.count ? JSONText(list) : @"The person has no saved lessons yet.")], YES);
    } else if ([tool isEqual:@"read_lesson"]) {
        NSDictionary *lesson = [self readLesson:arguments[@"id"]];
        if (!lesson) { done(@[Text(@"No lesson with that id.")], NO); return; }
        double from = [arguments[@"from"] respondsToSelector:@selector(doubleValue)] ? [arguments[@"from"] doubleValue] : -INFINITY;
        double to = [arguments[@"to"] respondsToSelector:@selector(doubleValue)] ? [arguments[@"to"] doubleValue] : INFINITY;
        NSMutableArray *tracks = [NSMutableArray new];
        NSUInteger count = 0;
        for (NSDictionary *track in lesson[@"tracks"]) {
            NSMutableArray *notes = [NSMutableArray new];
            for (NSDictionary *note in track[@"notes"]) {
                double time = [note[@"time"] doubleValue];
                if (time < from || time > to || count >= 4000) continue;
                [notes addObject:@[note[@"midi"] ?: @0, @(round(time * 1000) / 1000), @(round([note[@"end"] doubleValue] * 1000) / 1000),
                                   @(round([note[@"velocity"] doubleValue] * 100) / 100)]];
                count++;
            }
            [tracks addObject:@{@"hand":track[@"id"] ?: @0, @"name":track[@"name"] ?: @"", @"notes":notes}];
        }
        NSMutableDictionary *summary = [@{@"id":lesson[@"id"], @"title":lesson[@"title"] ?: @"", @"description":lesson[@"description"] ?: @"",
            @"duration":lesson[@"duration"] ?: @0, @"noteCount":lesson[@"noteCount"] ?: @0, @"hasScore":@(lesson[@"notation"] != nil), @"tracks":tracks} mutableCopy];
        if (count >= 4000) summary[@"truncated"] = @"Only the first 4000 notes; ask for a time range with from/to.";
        done(@[Text(JSONText(summary))], YES);
    } else if ([tool isEqual:@"save_lesson"]) {
        NSString *error = nil;
        NSDictionary *saved = [self saveLesson:arguments error:&error];
        if (saved && self.turn) [self.turn[@"lessons"] addObject:@{@"id":saved[@"id"], @"title":saved[@"title"] ?: @""}];
        done(@[Text(saved ? JSONText(@{@"saved":saved[@"id"], @"title":saved[@"title"], @"noteCount":saved[@"noteCount"]}) : error)], saved != nil);
    } else done(@[Text(@"Unknown tool.")], NO);
}

- (NSDictionary *)saveLesson:(NSDictionary *)arguments error:(NSString **)error {
    NSString *title = [arguments[@"title"] isKindOfClass:NSString.class] ? [arguments[@"title"] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] : @"";
    if (!title.length) { *error = @"A title is required."; return nil; }
    NSMutableDictionary *lesson = nil;
    if (arguments[@"id"]) {
        lesson = [self readLesson:arguments[@"id"]];
        if (!lesson) { *error = @"No lesson with that id."; return nil; }
        NSURL *backups = [self.root URLByAppendingPathComponent:@"lesson-backups" isDirectory:YES];
        [NSFileManager.defaultManager createDirectoryAtURL:backups withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL];
        [[NSJSONSerialization dataWithJSONObject:lesson options:0 error:NULL] writeToURL:[backups URLByAppendingPathComponent:
            [NSString stringWithFormat:@"%@-%@.json", lesson[@"id"], Milliseconds()]] atomically:YES];
    } else {
        if (![arguments[@"tracks"] isKindOfClass:NSArray.class]) { *error = @"A new lesson needs tracks with notes."; return nil; }
        lesson = [@{@"id":NSUUID.UUID.UUIDString.lowercaseString, @"description":@""} mutableCopy];
    }
    lesson[@"title"] = [title substringToIndex:MIN(title.length, (NSUInteger)120)];
    if ([arguments[@"description"] isKindOfClass:NSString.class]) lesson[@"description"] = arguments[@"description"];
    if ([arguments[@"tracks"] isKindOfClass:NSArray.class]) {
        NSMutableArray *hands = [@[[NSMutableArray new], [NSMutableArray new]] mutableCopy];
        double duration = 0; NSUInteger count = 0;
        for (NSDictionary *track in arguments[@"tracks"]) {
            NSInteger hand = [track[@"hand"] integerValue];
            if (![track isKindOfClass:NSDictionary.class] || hand < 0 || hand > 1 || ![track[@"notes"] isKindOfClass:NSArray.class]) { *error = @"Each track needs hand 0 or 1 and notes."; return nil; }
            for (NSArray *note in track[@"notes"]) {
                if (![note isKindOfClass:NSArray.class] || note.count != 4) { *error = @"Each note is [midi, start, end, velocity]."; return nil; }
                double midi = [note[0] doubleValue], start = [note[1] doubleValue], end = [note[2] doubleValue], velocity = [note[3] doubleValue];
                if (midi < 21 || midi > 108 || midi != floor(midi) || start < 0 || end <= start || end - start > 60 || velocity <= 0 || velocity > 1 || !isfinite(start + end)) {
                    *error = [NSString stringWithFormat:@"Invalid note %@: midi 21-108, 0 <= start < end, velocity in (0, 1].", JSONText(note)]; return nil;
                }
                [hands[hand] addObject:@{@"midi":@((int)midi), @"time":@(start), @"end":@(end), @"velocity":@(velocity), @"hand":@(hand)}];
                duration = MAX(duration, end); count++;
            }
        }
        if (!count || count > 20000) { *error = @"A lesson needs between 1 and 20000 notes."; return nil; }
        NSMutableArray *tracks = [NSMutableArray new];
        for (NSInteger hand = 0; hand < 2; hand++) {
            [hands[hand] sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) { return [a[@"time"] compare:b[@"time"]]; }];
            [tracks addObject:@{@"id":@(hand), @"name":hand ? @"Sağ el" : @"Sol el", @"notes":hands[hand], @"pedals":@[]}];
        }
        lesson[@"tracks"] = tracks; lesson[@"noteCount"] = @(count); lesson[@"duration"] = @(duration);
        lesson[@"midiFilename"] = [NSString stringWithFormat:@"rach3-%@.mid", lesson[@"id"]];
        [lesson removeObjectForKey:@"notation"];
        lesson[@"provenance"] = @{@"model":@"Made with ChatGPT in rach3"};
    }
    [NSFileManager.defaultManager createDirectoryAtURL:self.lessonsURL withIntermediateDirectories:YES attributes:nil error:NULL];
    NSData *data = [NSJSONSerialization dataWithJSONObject:lesson options:0 error:NULL];
    NSURL *pending = [self.lessonsURL URLByAppendingPathComponent:[lesson[@"id"] stringByAppendingPathExtension:@"pending"]];
    if (![data writeToURL:pending atomically:YES] || ![NSFileManager.defaultManager replaceItemAtURL:
          [self.lessonsURL URLByAppendingPathComponent:[lesson[@"id"] stringByAppendingPathExtension:@"json"]] withItemAtURL:pending
          backupItemName:nil options:0 resultingItemURL:NULL error:NULL]) {
        // replaceItemAtURL needs an existing file; a new lesson is a plain move.
        if (![NSFileManager.defaultManager moveItemAtURL:pending toURL:[self.lessonsURL URLByAppendingPathComponent:[lesson[@"id"] stringByAppendingPathExtension:@"json"]] error:NULL]) {
            *error = @"The lesson could not be saved."; return nil;
        }
    }
    if (self.onLessonChanged) self.onLessonChanged(lesson);
    return lesson;
}

#pragma mark Hidden preview

- (void)preview:(NSString *)script done:(void (^)(NSArray *, BOOL))done {
    if (![NSFileManager.defaultManager fileExistsAtPath:[self.workspace URLByAppendingPathComponent:@"piano.html"].path]) {
        done(@[Text(@"Nothing to preview.")], NO); return;
    }
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
    void (^finish)(NSArray *, BOOL) = ^(NSArray *content, BOOL success) {
        if (finished) return;
        finished = YES; self.previewLoaded = nil;
        [self.previewWindow orderOut:nil];
        done(content, success);
    };
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 25 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        finish(@[Text([@"The preview did not finish loading in 25 seconds. Errors: " stringByAppendingString:JSONText(self.previewErrors ?: @[])])], NO);
    });
    // Held only until the preview finishes (finish clears it), so the cycle is brief.
    void (^loaded)(void) = ^{
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            [self.previewView callAsyncJavaScript:script ?: @"return null;" arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld
                completionHandler:^(id value, NSError *scriptError) {
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.8 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
                    [self.previewView takeSnapshotWithConfiguration:nil completionHandler:^(NSImage *image, NSError *snapshotError) {
                        NSMutableDictionary *report = [@{@"errors":self.previewErrors ?: @[]} mutableCopy];
                        if (script) report[@"scriptResult"] = scriptError ? [@"Error: " stringByAppendingString:scriptError.localizedDescription] : (value ? [value description] : @"undefined");
                        NSMutableArray *content = [@[Text([@"Preview of your edited copy. " stringByAppendingString:JSONText(report)])] mutableCopy];
                        NSBitmapImageRep *bitmap = image ? [[NSBitmapImageRep alloc] initWithData:image.TIFFRepresentation] : nil;
                        NSData *jpeg = [bitmap representationUsingType:NSBitmapImageFileTypeJPEG properties:@{NSImageCompressionFactor:@0.72}];
                        if (jpeg) [content addObject:@{@"type":@"inputImage", @"imageUrl":[@"data:image/jpeg;base64," stringByAppendingString:[jpeg base64EncodedStringWithOptions:0]]}];
                        else [content addObject:Text([@"No screenshot: " stringByAppendingString:snapshotError.localizedDescription ?: @"unknown"])];
                        finish(content, YES);
                    }];
                });
            }];
        });
    };
    self.previewLoaded = loaded;
    [self.previewView loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@"rach3-preview://app/piano.html"]]];
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
        if (self.previewErrors.count < 30) [self.previewErrors addObject:CleanError(body, @"preview")];
        replyHandler(@{}, nil); return;
    }
    id reply = self.previewBridge ? self.previewBridge(body) : nil;
    replyHandler(reply ?: @{}, nil);
}

- (NSString *)instructions {
    return @"You are inside rach3, a piano practice app, changing the app for the person using it. They are not a programmer. "
        "The current folder is the app's web interface; AGENTS.md there explains it. Change only files in this folder. "
        "Every finished change is saved as a new design the person can switch back from, so make the change they asked for and nothing else. "
        "Reply in the language the person writes in, in a few short plain sentences without code or file names, unless they ask for details. "
        "There is no internet access, git, or package installation here. "
        "After changing files, call the rach3.preview tool to see your edited copy running and fix any errors it reports before you finish. "
        "If the person mentions something broken on screen, call rach3.page_errors. "
        "For lessons (the pieces they practise), use rach3.list_lessons, rach3.read_lesson and rach3.save_lesson; lessons are not files in this folder.";
}

- (void)track:(NSString *)method params:(NSDictionary *)params {
    if ([method isEqual:@"thread/tokenUsage/updated"]) {
        NSDictionary *last = params[@"tokenUsage"][@"last"];
        NSMutableDictionary *tokens = self.turn[@"tokens"];
        tokens[@"input"] = @([tokens[@"input"] longLongValue] + [last[@"inputTokens"] longLongValue]);
        tokens[@"cached"] = @([tokens[@"cached"] longLongValue] + [last[@"cachedInputTokens"] longLongValue]);
        tokens[@"output"] = @([tokens[@"output"] longLongValue] + [last[@"outputTokens"] longLongValue]);
        tokens[@"total"] = @([tokens[@"total"] longLongValue] + [last[@"totalTokens"] longLongValue]);
    } else if ([method isEqual:@"item/completed"] && [params[@"item"][@"type"] isEqual:@"fileChange"]) {
        NSString *inside = [self.workspace.URLByStandardizingPath.path stringByAppendingString:@"/"];
        for (NSDictionary *change in params[@"item"][@"changes"]) {
            NSString *path = [change[@"path"] stringByStandardizingPath];
            if (![path hasPrefix:inside]) self.turn[@"outside"] = @YES;
            else [self.turn[@"files"] addObject:[path substringFromIndex:inside.length]];
        }
    } else if ([method isEqual:@"item/completed"] && [params[@"item"][@"type"] isEqual:@"agentMessage"]) {
        self.turn[@"summary"] = params[@"item"][@"text"] ?: @"";
    } else if ([method isEqual:@"turn/completed"]) {
        NSDictionary *turn = params[@"turn"];
        [self finishTurn:turn[@"status"] ?: @"completed" error:[turn[@"error"] isKindOfClass:NSDictionary.class] ? turn[@"error"][@"message"] : nil];
    }
}

static NSArray<NSString *> *RelativeFiles(NSURL *root) {
    NSMutableArray *paths = [NSMutableArray new];
    NSString *prefix = [root.URLByStandardizingPath.URLByResolvingSymlinksInPath.path stringByAppendingString:@"/"];
    for (NSURL *url in [NSFileManager.defaultManager enumeratorAtURL:root includingPropertiesForKeys:@[NSURLIsRegularFileKey] options:0 errorHandler:nil]) {
        NSNumber *regular; [url getResourceValue:&regular forKey:NSURLIsRegularFileKey error:NULL];
        NSString *path = url.URLByStandardizingPath.URLByResolvingSymlinksInPath.path;
        if (regular.boolValue && [path hasPrefix:prefix]) [paths addObject:[path substringFromIndex:prefix.length]];
    }
    return paths;
}

- (NSArray<NSString *> *)changedFilesFrom:(NSURL *)base to:(NSURL *)changed {
    NSMutableSet *all = [NSMutableSet setWithArray:RelativeFiles(base)];
    [all addObjectsFromArray:RelativeFiles(changed)];
    NSMutableArray *different = [NSMutableArray new];
    for (NSString *path in all) {
        NSData *before = [NSData dataWithContentsOfURL:[base URLByAppendingPathComponent:path] options:NSDataReadingMappedIfSafe error:NULL];
        NSData *after = [NSData dataWithContentsOfURL:[changed URLByAppendingPathComponent:path] options:NSDataReadingMappedIfSafe error:NULL];
        if (!(before == after || [before isEqualToData:after])) [different addObject:path];
    }
    return [different sortedArrayUsingSelector:@selector(compare:)];
}

- (void)finishTurn:(NSString *)status error:(NSString *)error {
    NSMutableDictionary *turn = self.turn;
    if (!turn) return;
    self.turn = nil;
    // Count what this change cost, per day and per conversation.
    NSDictionary *tokens = turn[@"tokens"];
    NSMutableDictionary *day = [self.usage[@"days"][self.today] mutableCopy] ?: [NSMutableDictionary new];
    NSString *thread = [turn[@"thread"] isKindOfClass:NSString.class] ? turn[@"thread"] : nil;
    NSMutableDictionary *conversation = thread ? ([self.usage[@"threads"][thread] mutableCopy] ?: [NSMutableDictionary new]) : nil;
    for (NSString *key in tokens) {
        day[key] = @([day[key] longLongValue] + [tokens[key] longLongValue]);
        if (conversation) conversation[key] = @([conversation[key] longLongValue] + [tokens[key] longLongValue]);
    }
    self.usage[@"days"][self.today] = day;
    if (conversation) {
        NSMutableArray *turns = [conversation[@"turns"] mutableCopy] ?: [NSMutableArray new];
        if (turn[@"turn"] != NSNull.null && turn[@"turn"]) [turns addObject:@{@"turn":turn[@"turn"], @"tokens":tokens, @"lessons":turn[@"lessons"]}];
        conversation[@"turns"] = turns; self.usage[@"threads"][thread] = conversation;
    }
    [self save:self.usage as:@"usage.json"];

    NSString *design = nil;
    NSArray *changed = @[];
    BOOL outside = [turn[@"outside"] boolValue];
    NSURL *base = [self designRoot:turn[@"base"]];
    if (base && [NSFileManager.defaultManager fileExistsAtPath:self.workspace.path] && !outside && ![status isEqual:@"failed"])
        changed = [self changedFilesFrom:base to:self.workspace];
    if (changed.count) {
        NSDateFormatter *format = [NSDateFormatter new];
        format.dateFormat = @"yyyyMMdd-HHmmss"; format.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
        design = [NSString stringWithFormat:@"%@-%04x", [format stringFromDate:NSDate.date], arc4random_uniform(0x10000)];
        NSURL *destination = [[self.root URLByAppendingPathComponent:@"designs" isDirectory:YES] URLByAppendingPathComponent:design isDirectory:YES];
        if ([NSFileManager.defaultManager moveItemAtURL:self.workspace toURL:destination error:NULL]) {
            NSString *prompt = turn[@"prompt"];
            [self.designs[@"designs"] addObject:[@{@"id":design, @"title":[prompt substringToIndex:MIN(prompt.length, (NSUInteger)120)],
                @"summary":turn[@"summary"] ?: @"", @"parent":turn[@"base"], @"thread":thread ?: NSNull.null, @"turn":turn[@"turn"] ?: NSNull.null,
                @"created":Milliseconds(), @"files":changed, @"tokens":tokens, @"appVersion":self.version} mutableCopy]];
            self.designs[@"active"] = design; [self save:self.designs as:@"designs.json"];
        } else design = nil;
    }
    [NSFileManager.defaultManager removeItemAtURL:self.workspace error:NULL];
    [self publish:@{@"event":@"customize-finished", @"status":status ?: @"completed", @"error":error ?: NSNull.null, @"design":design ?: NSNull.null,
                    @"tokens":tokens, @"files":changed, @"outside":@(outside), @"thread":thread ?: NSNull.null, @"lessons":turn[@"lessons"]}];
    [self publishState];
    if (design && self.onReload) self.onReload();
}

@end
