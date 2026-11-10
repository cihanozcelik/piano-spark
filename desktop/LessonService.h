#import <Foundation/Foundation.h>

@interface LessonService : NSObject
@property (nonatomic, copy) void (^onEvent)(NSDictionary *);
@property (nonatomic, copy) void (^onIdle)(void);
@property (nonatomic, readonly) BOOL running;
@property (nonatomic, readonly) NSURL *supportURL;
- (instancetype)initWithEngine:(NSURL *)engine support:(NSURL *)support tools:(NSURL *)tools;
- (NSDictionary *)snapshot;
- (NSDictionary *)tools;
- (NSArray *)lessons;
- (NSDictionary *)lesson:(NSString *)identifier error:(NSError **)error;
- (BOOL)deleteLesson:(NSString *)identifier error:(NSError **)error;
- (NSDictionary *)begin:(NSDictionary *)request error:(NSError **)error;
- (BOOL)append:(NSString *)encoded identifier:(NSString *)identifier error:(NSError **)error;
- (BOOL)start:(NSString *)identifier error:(NSError **)error;
- (BOOL)openVideo:(NSURL *)url error:(NSError **)error;
// Bytes of tools a lesson of this kind (video, youtube, midi, pdf) still has to download; 0 when ready.
- (unsigned long long)missingToolBytes:(NSString *)kind;
// Starts a lesson from a file on disk (video, midi, pdf) or a YouTube link, as Create a Lesson
// does. Returns the job's id, or nil.
- (NSString *)importFile:(NSURL *)file kind:(NSString *)kind title:(NSString *)title error:(NSError **)error;
- (NSString *)importYouTube:(NSString *)link title:(NSString *)title error:(NSError **)error;
- (void)cancel;
@end
