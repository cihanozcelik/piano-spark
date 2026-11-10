#import "LessonDesk.h"
#import <AppKit/AppKit.h>

static const NSUInteger FileLimit = 40 * 1024 * 1024;
static const NSUInteger PreviewPages = 3;

static NSNumber *Now(void) { return @((long long)(NSDate.date.timeIntervalSince1970 * 1000)); }

// The 11-character id of a YouTube video link, or nil.
static NSString *YouTubeID(NSString *text) {
    NSURLComponents *parts = [NSURLComponents componentsWithString:[text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet]];
    if (!parts || ![@[@"https", @"http"] containsObject:parts.scheme.lowercaseString ?: @""] || parts.user || parts.password) return nil;
    NSString *host = parts.host.lowercaseString ?: @"";
    for (NSString *prefix in @[@"www.", @"m.", @"music."]) if ([host hasPrefix:prefix]) host = [host substringFromIndex:prefix.length];
    NSArray *path = [parts.path.pathComponents filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"SELF != '/'"]];
    NSString *identifier = nil;
    if ([host isEqual:@"youtu.be"]) identifier = path.firstObject;
    else if ([host isEqual:@"youtube.com"] || [host isEqual:@"youtube-nocookie.com"]) {
        if ([path.firstObject isEqual:@"watch"]) {
            for (NSURLQueryItem *item in parts.queryItems) if ([item.name isEqual:@"v"]) identifier = item.value;
        } else if (path.count >= 2 && [@[@"shorts", @"embed", @"live", @"v"] containsObject:path.firstObject]) identifier = path[1];
    }
    if (identifier.length != 11) return nil;
    NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:
        @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"];
    return [identifier rangeOfCharacterFromSet:allowed.invertedSet].location == NSNotFound ? identifier : nil;
}

@interface LessonDesk ()
@property (nonatomic, strong) NSURL *root;
@property (nonatomic, strong) NSMutableArray *conversation;
@property (nonatomic, strong) NSMutableDictionary *cards;
@property (nonatomic, strong) NSURLSession *session;
@end

@implementation LessonDesk

- (instancetype)initWithRoot:(NSURL *)root {
    if (!(self = [super init])) return nil;
    _root = root;
    [NSFileManager.defaultManager createDirectoryAtURL:root withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL];
    NSData *data = [NSData dataWithContentsOfURL:[root URLByAppendingPathComponent:@"desk.json"]];
    NSDictionary *saved = data ? [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:NULL] : nil;
    _conversation = [saved[@"entries"] isKindOfClass:NSArray.class] ? saved[@"entries"] : [NSMutableArray new];
    _cards = [saved[@"cards"] isKindOfClass:NSDictionary.class] ? saved[@"cards"] : [NSMutableDictionary new];
    // A lesson that was being made when rach3 quit is not being made any more.
    for (NSMutableDictionary *card in _cards.allValues) if ([card[@"state"] isEqual:@"making"]) card[@"state"] = @"shown";
    NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration;
    configuration.timeoutIntervalForRequest = 15; configuration.timeoutIntervalForResource = 120;
    configuration.HTTPCookieStorage = nil; configuration.URLCredentialStorage = nil;
    configuration.HTTPAdditionalHeaders = @{@"User-Agent":@"rach3"};
    _session = [NSURLSession sessionWithConfiguration:configuration];
    return self;
}

- (NSArray<NSDictionary *> *)entries {
    NSMutableArray *entries = [NSMutableArray new];
    for (NSDictionary *entry in self.conversation) {
        NSMutableDictionary *copy = [entry mutableCopy];
        if (entry[@"card"]) copy[@"card"] = self.cards[entry[@"card"]] ?: NSNull.null;
        [entries addObject:copy];
    }
    return entries;
}

- (void)save {
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"entries":self.conversation, @"cards":self.cards} options:0 error:NULL];
    NSURL *file = [self.root URLByAppendingPathComponent:@"desk.json"];
    [data writeToURL:file options:NSDataWritingAtomic error:NULL];
    [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions:@0600} ofItemAtPath:file.path error:NULL];
}

- (void)addEntry:(NSDictionary *)entry {
    NSMutableDictionary *saved = [entry mutableCopy];
    if ([saved[@"card"] isKindOfClass:NSDictionary.class]) saved[@"card"] = saved[@"card"][@"id"];
    saved[@"time"] = Now();
    [self.conversation addObject:saved];
    [self save];
}

- (void)clear {
    for (NSString *identifier in self.cards)
        [NSFileManager.defaultManager removeItemAtURL:[self.root URLByAppendingPathComponent:identifier isDirectory:YES] error:NULL];
    [self.conversation removeAllObjects]; [self.cards removeAllObjects];
    [self save];
}

- (NSMutableDictionary *)card:(NSString *)identifier {
    return [identifier isKindOfClass:NSString.class] ? self.cards[identifier] : nil;
}

- (void)update:(NSDictionary *)card {
    if (!card[@"id"]) return;
    self.cards[card[@"id"]] = [card mutableCopy];
    [self save];
}

- (NSURL *)folderOf:(NSString *)identifier { return [self.root URLByAppendingPathComponent:identifier isDirectory:YES]; }

- (NSURL *)fileOf:(NSString *)identifier {
    NSDictionary *card = [self card:identifier];
    if ([card[@"kind"] isEqual:@"midi"]) return [[self folderOf:identifier] URLByAppendingPathComponent:@"source.mid"];
    if ([card[@"kind"] isEqual:@"pdf"]) return [[self folderOf:identifier] URLByAppendingPathComponent:@"source.pdf"];
    return nil;
}

- (NSData *)servedFile:(NSString *)path type:(NSString **)type {
    NSArray *parts = path.pathComponents;
    if (parts.count != 3 || ![parts[0] isEqual:@"_desk"] || !self.cards[parts[1]]) return nil;
    NSString *name = parts[2];
    NSRegularExpression *pages = [NSRegularExpression regularExpressionWithPattern:@"^(page|large)-([0-9]{1,4})\\.png$" options:0 error:NULL];
    NSTextCheckingResult *match = [pages firstMatchInString:name options:0 range:NSMakeRange(0, name.length)];
    if (match) {
        if (type) *type = @"image/png";
        return [self page:[[name substringWithRange:[match rangeAtIndex:2]] integerValue]
                    large:[[name substringWithRange:[match rangeAtIndex:1]] isEqual:@"large"] of:parts[1]];
    }
    NSDictionary *types = @{@"jpg":@"image/jpeg", @"png":@"image/png", @"mid":@"audio/midi"};
    if ([name hasPrefix:@"."] || [name containsString:@"/"] || !types[name.pathExtension]) return nil;
    if (type) *type = types[name.pathExtension];
    return [NSData dataWithContentsOfURL:[[self folderOf:parts[1]] URLByAppendingPathComponent:name]];
}

#pragma mark Fetching

- (void)report:(NSDictionary *)progress {
    if (self.onProgress) self.onProgress(progress);
}

// Downloads a link; with `progress`, tells the page how far the download is.
- (void)fetch:(NSURL *)url limit:(NSUInteger)limit progress:(BOOL)progress done:(void (^)(NSData *data, NSString *error, NSInteger status))done {
    if (![url.scheme.lowercaseString isEqual:@"https"] || url.user || url.password || !url.host.length) { done(nil, @"Only https links can be opened.", 0); return; }
    __block NSTimer *timer = nil;
    NSURLSessionDataTask *task = [self.session dataTaskWithURL:url completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class] ? ((NSHTTPURLResponse *)response).statusCode : 200;
        NSString *failure = error.code == NSURLErrorTimedOut ? [NSString stringWithFormat:@"%@ did not answer.", url.host] :
            error ? error.localizedDescription : status >= 400 ? [NSString stringWithFormat:@"The site answered %ld.", (long)status] :
            data.length > limit ? @"The file is too large." : nil;
        dispatch_async(dispatch_get_main_queue(), ^{ [timer invalidate]; done(failure ? nil : data, failure, error ? 0 : status); });
    }];
    if (progress) {
        NSString *host = url.host;
        [self report:@{@"stage":@"download", @"host":host, @"received":@0}];
        __weak NSURLSessionDataTask *weakTask = task;
        timer = [NSTimer scheduledTimerWithTimeInterval:0.5 repeats:YES block:^(NSTimer *t) {
            NSURLSessionDataTask *running = weakTask;
            if (!running) { [t invalidate]; return; }
            NSMutableDictionary *state = [@{@"stage":@"download", @"host":host, @"received":@(MAX(0, running.countOfBytesReceived))} mutableCopy];
            if (running.countOfBytesExpectedToReceive > 0) state[@"total"] = @(running.countOfBytesExpectedToReceive);
            [self report:state];
        }];
    }
    [task resume];
}

- (void)show:(NSString *)source title:(NSString *)title note:(NSString *)note done:(void (^)(NSDictionary *, NSString *))done {
    NSString *identifier = [[NSUUID.UUID.UUIDString stringByReplacingOccurrencesOfString:@"-" withString:@""] substringToIndex:12].lowercaseString;
    NSURL *folder = [self folderOf:identifier];
    NSMutableDictionary *card = [@{@"id":identifier, @"title":title.length ? title : @"", @"note":note ?: @"", @"source":source ?: @"",
                                   @"state":@"shown", @"created":Now()} mutableCopy];
    void (^finish)(NSString *) = ^(NSString *error) {
        if (error) { [NSFileManager.defaultManager removeItemAtURL:folder error:NULL]; done(nil, error); return; }
        self.cards[identifier] = card; [self save]; done(card, nil);
    };
    [NSFileManager.defaultManager createDirectoryAtURL:folder withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL];
    NSString *video = YouTubeID(source ?: @"");
    if (video) {
        NSString *watch = [@"https://www.youtube.com/watch?v=" stringByAppendingString:video];
        card[@"kind"] = @"youtube"; card[@"link"] = watch;
        [self report:@{@"stage":@"video"}];
        NSURLComponents *oembed = [NSURLComponents componentsWithString:@"https://www.youtube.com/oembed"];
        oembed.queryItems = @[[NSURLQueryItem queryItemWithName:@"url" value:watch], [NSURLQueryItem queryItemWithName:@"format" value:@"json"]];
        [self fetch:oembed.URL limit:256 * 1024 progress:NO done:^(NSData *data, NSString *error, NSInteger status) {
            NSDictionary *info = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
            // YouTube answers 401 for a video that exists but may not play inside other apps.
            // It can still become a lesson; the card opens it on YouTube.
            if (status == 401) { card[@"embeddable"] = @NO; info = @{}; }
            if (![info isKindOfClass:NSDictionary.class]) {
                finish(status == 404 || status == 400 ? @"There is no YouTube video at this link." :
                       error ? [@"YouTube could not be reached: " stringByAppendingString:error] : @"YouTube did not describe this video."); return;
            }
            if (!title.length && [info[@"title"] isKindOfClass:NSString.class]) card[@"title"] = info[@"title"];
            if ([info[@"author_name"] isKindOfClass:NSString.class]) card[@"author"] = info[@"author_name"];
            NSURL *thumb = [NSURL URLWithString:[NSString stringWithFormat:@"https://i.ytimg.com/vi/%@/hqdefault.jpg", video]];
            [self fetch:thumb limit:2 * 1024 * 1024 progress:NO done:^(NSData *image, NSString *ignored, NSInteger code) {
                (void)ignored; (void)code;
                if (image && [image writeToURL:[folder URLByAppendingPathComponent:@"thumb.jpg"] atomically:YES])
                    card[@"thumb"] = [NSString stringWithFormat:@"_desk/%@/thumb.jpg", identifier];
                finish(nil);
            }];
        }];
        return;
    }
    NSURL *url = [NSURL URLWithString:[source stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet]];
    if (!url) { finish(@"That is not a link."); return; }
    [self fetch:url limit:FileLimit progress:YES done:^(NSData *data, NSString *error, NSInteger status) {
        (void)status;
        if (!data) { finish(error ?: @"Nothing was downloaded."); return; }
        if (!title.length) card[@"title"] = url.lastPathComponent.stringByDeletingPathExtension.stringByRemovingPercentEncoding ?: @"";
        card[@"size"] = @(data.length);
        if (data.length >= 4 && memcmp(data.bytes, "MThd", 4) == 0) {
            card[@"kind"] = @"midi";
            [data writeToURL:[folder URLByAppendingPathComponent:@"source.mid"] atomically:YES];
            card[@"file"] = [NSString stringWithFormat:@"_desk/%@/source.mid", identifier];
            finish(nil);
        } else if (data.length >= 5 && memcmp(data.bytes, "%PDF-", 5) == 0) {
            card[@"kind"] = @"pdf";
            [data writeToURL:[folder URLByAppendingPathComponent:@"source.pdf"] atomically:YES];
            [self report:@{@"stage":@"pages"}];
            NSInteger count = 0;
            card[@"pages"] = [self renderPages:data into:folder card:identifier count:&count];
            card[@"pageCount"] = @(count);
            if (!count) { finish(@"The PDF could not be opened."); return; }
            finish(nil);
        } else finish(@"The link is not a MIDI or PDF file. Link the file itself, not the page about it.");
    }];
}

// One PDF page as a PNG `width` pixels wide, with the empty paper around the music
// cut away so the notes fill the picture.
static NSData *RenderedPage(CGPDFDocumentRef document, size_t number, CGFloat width) {
    CGPDFPageRef page = CGPDFDocumentGetPage(document, number);
    if (!page) return nil;
    CGRect box = CGPDFPageGetBoxRect(page, kCGPDFCropBox);
    int angle = CGPDFPageGetRotationAngle(page) % 180;
    CGFloat ratio = angle ? box.size.width / box.size.height : box.size.height / box.size.width;
    size_t w = (size_t)width, h = (size_t)MAX(1, MIN(width * 4, width * ratio));
    CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
    CGContextRef context = CGBitmapContextCreate(NULL, w, h, 8, w * 4, space, (CGBitmapInfo)kCGImageAlphaNoneSkipLast);
    CGColorSpaceRelease(space);
    if (!context) return nil;
    CGContextSetRGBFillColor(context, 1, 1, 1, 1); CGContextFillRect(context, CGRectMake(0, 0, w, h));
    CGContextConcatCTM(context, CGPDFPageGetDrawingTransform(page, kCGPDFCropBox, CGRectMake(0, 0, w, h), 0, true));
    CGContextDrawPDFPage(context, page);
    // Find the ink: rows and columns with a pixel that is not near white.
    const uint8_t *pixels = CGBitmapContextGetData(context);
    size_t top = h, bottom = 0, left = w, right = 0;
    for (size_t y = 0; y < h; y++) {
        const uint8_t *row = pixels + y * w * 4;
        for (size_t x = 0; x < w; x++) {
            const uint8_t *pixel = row + x * 4;
            if (pixel[0] > 235 && pixel[1] > 235 && pixel[2] > 235) continue;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
            if (x < left) left = x;
            if (x > right) right = x;
        }
    }
    CGImageRef image = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    if (!image) return nil;
    if (top < bottom && left < right) {
        size_t margin = (size_t)(width * 0.02);
        size_t x0 = left > margin ? left - margin : 0, y0 = top > margin ? top - margin : 0;
        size_t x1 = MIN(w, right + margin + 1), y1 = MIN(h, bottom + margin + 1);
        CGImageRef cropped = CGImageCreateWithImageInRect(image, CGRectMake(x0, y0, x1 - x0, y1 - y0));
        if (cropped) { CGImageRelease(image); image = cropped; }
    }
    NSData *png = [[[NSBitmapImageRep alloc] initWithCGImage:image] representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    CGImageRelease(image);
    return png;
}

static CGPDFDocumentRef OpenPDF(NSData *data) {
    CGDataProviderRef provider = data ? CGDataProviderCreateWithCFData((__bridge CFDataRef)data) : NULL;
    CGPDFDocumentRef document = provider ? CGPDFDocumentCreateWithProvider(provider) : NULL;
    if (provider) CGDataProviderRelease(provider);
    return document;
}

// The first pages of a PDF as pictures the card can show.
- (NSArray *)renderPages:(NSData *)data into:(NSURL *)folder card:(NSString *)identifier count:(NSInteger *)count {
    NSMutableArray *pages = [NSMutableArray new];
    CGPDFDocumentRef document = OpenPDF(data);
    if (!document) { *count = 0; return pages; }
    *count = (NSInteger)CGPDFDocumentGetNumberOfPages(document);
    for (size_t number = 1; number <= MIN((size_t)*count, PreviewPages); number++) {
        NSData *png = RenderedPage(document, number, 1000);
        NSString *name = [NSString stringWithFormat:@"page-%zu.png", number];
        if ([png writeToURL:[folder URLByAppendingPathComponent:name] atomically:YES])
            [pages addObject:[NSString stringWithFormat:@"_desk/%@/%@", identifier, name]];
    }
    CGPDFDocumentRelease(document);
    return pages;
}

// Any page of a shown PDF, drawn the first time it is asked for: "page-N" for the
// card, "large-N" sharp enough to zoom into.
- (NSData *)page:(NSInteger)number large:(BOOL)large of:(NSString *)identifier {
    NSDictionary *card = [self card:identifier];
    if (![card[@"kind"] isEqual:@"pdf"] || number < 1 || number > [card[@"pageCount"] integerValue]) return nil;
    NSURL *file = [[self folderOf:identifier] URLByAppendingPathComponent:[NSString stringWithFormat:@"%@-%ld.png", large ? @"large" : @"page", (long)number]];
    NSData *saved = [NSData dataWithContentsOfURL:file];
    if (saved) return saved;
    CGPDFDocumentRef document = OpenPDF([NSData dataWithContentsOfURL:[self fileOf:identifier]]);
    if (!document) return nil;
    NSData *png = RenderedPage(document, (size_t)number, large ? 2400 : 1000);
    CGPDFDocumentRelease(document);
    [png writeToURL:file atomically:YES];
    return png;
}

@end
