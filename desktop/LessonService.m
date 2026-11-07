#import "Localization.h"
#import "LessonService.h"
#import <signal.h>
#import <unistd.h>

@interface LessonService ()
@property (nonatomic, strong) NSURL *engine;
@property (nonatomic, strong) NSURL *toolsURL;
@property (nonatomic, readwrite, strong) NSURL *supportURL;
@property (nonatomic, strong) NSURL *jobURL;
@property (nonatomic, strong) NSFileHandle *upload;
@property (nonatomic, strong) NSTask *task;
@property (nonatomic, strong) NSDictionary *state;
@property (nonatomic, strong) NSString *identifier;
@property (nonatomic) BOOL cancelling;
@property (nonatomic) unsigned long long expectedSize;
@property (nonatomic) unsigned long long uploadedSize;
@end

@implementation LessonService
- (instancetype)initWithEngine:(NSURL *)engine support:(NSURL *)support tools:(NSURL *)tools {
    if ((self = [super init])) {
        self.engine = engine; self.supportURL = support; self.toolsURL = tools;
        self.state = @{@"event":@"lesson-progress",@"phase":@"idle",@"message":@"",@"progress":@0};
        NSURL *jobs = [support URLByAppendingPathComponent:@"Jobs"];
        for (NSURL *old in [NSFileManager.defaultManager contentsOfDirectoryAtURL:jobs includingPropertiesForKeys:nil options:0 error:NULL]) {
            NSString *pidText = [NSString stringWithContentsOfURL:[old URLByAppendingPathComponent:@"owner.pid"] encoding:NSUTF8StringEncoding error:NULL];
            pid_t pid = (pid_t)pidText.intValue;
            if (pid <= 1 || kill(pid,0) != 0) [NSFileManager.defaultManager removeItemAtURL:old error:NULL];
        }
    }
    return self;
}
- (BOOL)running { return self.identifier != nil; }
- (NSDictionary *)snapshot { return PianoLocalizedStatus(self.state); }
- (NSDictionary *)tools {
    NSData *data = [NSData dataWithContentsOfURL:[self.engine URLByAppendingPathComponent:@"tools.json"]];
    NSDictionary *catalog = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
    NSURL *cache = self.toolsURL;
    NSMutableDictionary *artifacts = [NSMutableDictionary new];
    for (NSString *key in catalog[@"artifacts"]) {
        NSMutableDictionary *artifact = [catalog[@"artifacts"][key] mutableCopy];
        NSString *hash = artifact[@"sha256"];
        NSURL *marker = [cache URLByAppendingPathComponent:[NSString stringWithFormat:@"artifacts/%@/.ready",hash]];
        NSString *installed = [NSString stringWithContentsOfURL:marker encoding:NSUTF8StringEncoding error:NULL];
        artifact[@"ready"] = @([installed isEqual:hash]);
        NSURL *partial = [cache URLByAppendingPathComponent:[NSString stringWithFormat:@"downloads/%@.part",hash]];
        NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:partial.path error:NULL];
        artifact[@"received"] = @(MIN([attributes fileSize],[artifact[@"size"] unsignedLongLongValue]));
        artifacts[key] = artifact;
    }
    return @{@"groups":catalog[@"groups"],@"artifacts":artifacts};
}
- (void)publish:(NSDictionary *)state {
    self.state = state;
    [NSFileManager.defaultManager createDirectoryAtURL:self.supportURL withIntermediateDirectories:YES attributes:nil error:NULL];
    [[NSJSONSerialization dataWithJSONObject:state options:0 error:NULL]
        writeToURL:[self.supportURL URLByAppendingPathComponent:@"LastJob.json"] options:NSDataWritingAtomic error:NULL];
    if (self.onEvent) self.onEvent([self snapshot]);
}
- (BOOL)fail:(NSString *)message error:(NSError **)error {
    if (error) *error = [NSError errorWithDomain:@"PianoMan.Lessons" code:1 userInfo:@{NSLocalizedDescriptionKey:PianoText(message)}];
    return NO;
}
- (NSURL *)libraryURL { return [self.supportURL URLByAppendingPathComponent:@"Lessons"]; }
- (NSArray *)lessons {
    NSMutableArray *list = [NSMutableArray new];
    for (NSURL *url in [NSFileManager.defaultManager contentsOfDirectoryAtURL:[self libraryURL] includingPropertiesForKeys:nil options:0 error:NULL]) {
        if (![url.pathExtension isEqual:@"json"]) continue;
        NSData *data = [NSData dataWithContentsOfURL:url];
        NSDictionary *lesson = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
        if ([lesson isKindOfClass:NSDictionary.class] && lesson[@"id"] && lesson[@"title"]) {
            [list addObject:@{@"id":lesson[@"id"],@"title":lesson[@"title"],@"noteCount":lesson[@"noteCount"] ?: @0}];
        }
    }
    [list sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) { return [a[@"title"] localizedCaseInsensitiveCompare:b[@"title"]]; }];
    return list;
}
- (NSDictionary *)lesson:(NSString *)identifier error:(NSError **)error {
    if (![[NSUUID alloc] initWithUUIDString:identifier]) { [self fail:@"Geçersiz ders kimliği" error:error]; return nil; }
    NSURL *url = [[self libraryURL] URLByAppendingPathComponent:[identifier stringByAppendingPathExtension:@"json"]];
    NSData *data = [NSData dataWithContentsOfURL:url options:0 error:error];
    return data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:error] : nil;
}
- (BOOL)deleteLesson:(NSString *)identifier error:(NSError **)error {
    if (![[NSUUID alloc] initWithUUIDString:identifier]) return [self fail:@"Geçersiz ders kimliği" error:error];
    NSURL *lesson = [[self libraryURL] URLByAppendingPathComponent:[identifier stringByAppendingPathExtension:@"json"]];
    if (![NSFileManager.defaultManager removeItemAtURL:lesson error:error]) return NO;
    NSURL *assets = [[self libraryURL] URLByAppendingPathComponent:[identifier stringByAppendingPathExtension:@"assets"]];
    if ([NSFileManager.defaultManager fileExistsAtPath:assets.path] && ![NSFileManager.defaultManager removeItemAtURL:assets error:error]) return NO;
    if ([self.state[@"id"] isEqual:identifier])
        [self publish:@{@"event":@"lesson-progress",@"phase":@"idle",@"message":@"",@"progress":@0}];
    return YES;
}
- (NSDictionary *)begin:(NSDictionary *)request error:(NSError **)error {
    if (self.running) { [self fail:@"Önce mevcut işlemi tamamla veya iptal et." error:error]; return nil; }
    NSString *name = [request[@"name"] isKindOfClass:NSString.class] ? request[@"name"] : @"video.mp4";
    NSString *title = [request[@"title"] isKindOfClass:NSString.class] ? request[@"title"] : name.stringByDeletingPathExtension;
    NSString *url = [request[@"url"] isKindOfClass:NSString.class] ? request[@"url"] : @"";
    if (url.length) {
        NSURLComponents *parts = [NSURLComponents componentsWithString:url];
        if (![parts.scheme isEqual:@"https"] || ![parts.host isEqual:@"www.youtube.com"] || ![parts.path isEqual:@"/watch"] || parts.user || parts.password || parts.port) {
            [self fail:@"Geçerli bir YouTube bağlantısı seç." error:error]; return nil;
        }
    }
    self.identifier = NSUUID.UUID.UUIDString;
    self.jobURL = [[self.supportURL URLByAppendingPathComponent:@"Jobs"] URLByAppendingPathComponent:self.identifier];
    self.cancelling = NO; self.expectedSize = [request[@"size"] unsignedLongLongValue]; self.uploadedSize = 0;
    if (self.expectedSize > 4ULL*1024*1024*1024) { self.identifier = nil; [self fail:@"En fazla 4 GB video seçebilirsin." error:error]; return nil; }
    if (![NSFileManager.defaultManager createDirectoryAtURL:self.jobURL withIntermediateDirectories:YES attributes:nil error:error]) { self.identifier = nil; return nil; }
    [@(getpid()).stringValue writeToURL:[self.jobURL URLByAppendingPathComponent:@"owner.pid"] atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    NSString *kind = [request[@"kind"] isEqual:@"pdf"] ? @"pdf" : [request[@"kind"] isEqual:@"midi"] ? @"midi" : @"video";
    NSString *inputName = [@"input." stringByAppendingString:kind];
    NSDictionary *job = @{@"id":self.identifier,@"title":title,@"input":inputName,@"kind":kind,@"sourceName":name,@"tempo":request[@"tempo"] ?: @60,@"url":url,@"separate":request[@"separate"] ?: @YES};
    NSData *data = [NSJSONSerialization dataWithJSONObject:job options:0 error:error];
    if (![data writeToURL:[self.jobURL URLByAppendingPathComponent:@"request.json"] options:NSDataWritingAtomic error:error]) { [self cancel]; return nil; }
    if (!url.length) {
        NSURL *input = [self.jobURL URLByAppendingPathComponent:inputName];
        [NSFileManager.defaultManager createFileAtPath:input.path contents:nil attributes:nil];
        self.upload = [NSFileHandle fileHandleForWritingToURL:input error:error];
        if (!self.upload) { [self cancel]; return nil; }
    }
    [self publish:@{@"event":@"lesson-progress",@"phase":@"upload",@"message":@"Dosya hazırlanıyor…",@"progress":@0,@"title":title}];
    return @{@"id":self.identifier};
}
- (BOOL)append:(NSString *)encoded identifier:(NSString *)identifier error:(NSError **)error {
    if (![identifier isEqual:self.identifier] || !self.upload) return [self fail:@"Video aktarımı kapalı." error:error];
    NSData *data = [[NSData alloc] initWithBase64EncodedString:encoded options:0];
    if (!data || data.length>2*1024*1024 || self.uploadedSize+data.length>self.expectedSize)
        return [self fail:@"Video aktarım boyutu geçersiz." error:error];
    if (![self.upload writeData:data error:error]) return NO;
    self.uploadedSize += data.length;
    return YES;
}
- (BOOL)start:(NSString *)identifier error:(NSError **)error {
    if (![identifier isEqual:self.identifier] || self.task) return [self fail:@"Ders işlemi bulunamadı." error:error];
    if (self.upload && self.uploadedSize != self.expectedSize) return [self fail:@"Video aktarımı tamamlanmadı." error:error];
    [self.upload closeAndReturnError:NULL]; self.upload = nil;
    NSURL *engine = self.engine;
    NSTask *task = [NSTask new];
    task.executableURL = [engine URLByAppendingPathComponent:@"python/bin/python3.12"];
    task.arguments = @[@"-u",[engine URLByAppendingPathComponent:@"worker.py"].path,@"--job",self.jobURL.path,
                       @"--tools",self.toolsURL.path,
                       @"--library",[self libraryURL].path,@"--parent",@(getpid()).stringValue];
    NSMutableDictionary *environment = [NSProcessInfo.processInfo.environment mutableCopy];
    environment[@"PYTHONHOME"] = [engine URLByAppendingPathComponent:@"python"].path;
    environment[@"PYTHONPATH"] = engine.path;
    environment[@"PYTHONNOUSERSITE"] = @"1"; environment[@"PYTHONDONTWRITEBYTECODE"] = @"1";
    environment[@"PATH"] = @"/usr/bin:/bin";
    NSURL *temp = [self.jobURL URLByAppendingPathComponent:@"tmp"];
    [NSFileManager.defaultManager createDirectoryAtURL:temp withIntermediateDirectories:YES attributes:nil error:NULL];
    environment[@"TMPDIR"] = temp.path; task.environment = environment;
    task.currentDirectoryURL = self.jobURL;
    NSPipe *pipe = NSPipe.pipe; task.standardOutput = pipe; task.standardError = pipe;
    if (![task launchAndReturnError:error]) { [self cancel]; return NO; }
    self.task = task;
    [self publish:@{@"event":@"lesson-progress",@"phase":@"starting",@"message":@"Ders motoru başlatılıyor…",@"progress":@0}];
    __weak LessonService *weakSelf = self;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0), ^{
        NSMutableData *buffer = [NSMutableData new];
        NSFileHandle *reader = pipe.fileHandleForReading;
        for (;;) {
            @autoreleasepool {
                NSData *chunk = reader.availableData; if (!chunk.length) break;
                [buffer appendData:chunk];
                for (;;) {
                    const void *newline = memchr(buffer.bytes,'\n',buffer.length); if (!newline) break;
                    NSUInteger length = (const char *)newline-(const char *)buffer.bytes;
                    NSData *line = [buffer subdataWithRange:NSMakeRange(0,length)];
                    [buffer replaceBytesInRange:NSMakeRange(0,length+1) withBytes:NULL length:0];
                    NSDictionary *event = [NSJSONSerialization JSONObjectWithData:line options:0 error:NULL];
                    if (![event isKindOfClass:NSDictionary.class] || ![event[@"event"] isEqual:@"lesson-progress"]) continue;
                    dispatch_async(dispatch_get_main_queue(), ^{
                        if (weakSelf.task==task && !weakSelf.cancelling) {
                            if ([@[@"complete",@"error"] containsObject:event[@"phase"]]) weakSelf.state = event;
                            else [weakSelf publish:event];
                        }
                    });
                }
                if (buffer.length>1024*1024) [buffer setLength:0];
            }
        }
        [reader closeFile]; [task waitUntilExit];
        dispatch_async(dispatch_get_main_queue(), ^{
            LessonService *owner = weakSelf; if (owner.task!=task) return;
            NSString *finishedID = owner.identifier;
            owner.task = nil; owner.identifier = nil;
            [NSFileManager.defaultManager removeItemAtURL:owner.jobURL error:NULL]; owner.jobURL = nil;
            if (owner.cancelling) {
                [NSFileManager.defaultManager removeItemAtURL:[[owner libraryURL] URLByAppendingPathComponent:[finishedID stringByAppendingPathExtension:@"json"]] error:NULL];
                [owner publish:@{@"event":@"lesson-progress",@"phase":@"cancelled",@"message":@"İşlem iptal edildi",@"progress":@0}];
            }
            else if ([@[@"complete",@"error"] containsObject:owner.state[@"phase"]]) [owner publish:owner.state];
            else if (![owner.state[@"phase"] isEqual:@"complete"] && ![owner.state[@"phase"] isEqual:@"error"])
                [owner publish:@{@"event":@"lesson-progress",@"phase":@"error",@"message":@"Ders oluşturulamadı. İşlem beklenmedik şekilde kapandı.",@"progress":@0}];
            if (owner.onIdle) owner.onIdle();
        });
    });
    return YES;
}
- (BOOL)openVideo:(NSURL *)url error:(NSError **)error {
    NSNumber *size; if (![url getResourceValue:&size forKey:NSURLFileSizeKey error:error]) return NO;
    NSDictionary *job = [self begin:@{@"name":url.lastPathComponent,@"size":size,@"separate":@YES} error:error];
    if (!job) return NO;
    [self.upload closeAndReturnError:NULL]; self.upload = nil;
    NSURL *input = [self.jobURL URLByAppendingPathComponent:@"input.video"];
    [NSFileManager.defaultManager removeItemAtURL:input error:NULL];
    if (![NSFileManager.defaultManager copyItemAtURL:url toURL:input error:error]) { [self cancel]; return NO; }
    self.uploadedSize = size.unsignedLongLongValue;
    return [self start:job[@"id"] error:error];
}
- (void)cancel {
    self.cancelling = YES;
    if (self.task) {
        pid_t pid = self.task.processIdentifier;
        if (getpgid(pid)==pid) kill(-pid,SIGTERM); else if (self.task.running) [self.task terminate];
        [self publish:@{@"event":@"lesson-progress",@"phase":@"cancelling",@"message":@"İşlem durduruluyor…",@"progress":@0}];
    } else if (self.identifier) {
        [self.upload closeAndReturnError:NULL]; self.upload = nil;
        [NSFileManager.defaultManager removeItemAtURL:self.jobURL error:NULL];
        self.identifier = nil; self.jobURL = nil;
        [self publish:@{@"event":@"lesson-progress",@"phase":@"cancelled",@"message":@"İşlem iptal edildi",@"progress":@0}];
        if (self.onIdle) self.onIdle();
    }
}
@end
