#import <Foundation/Foundation.h>

@interface LessonService : NSObject
@property (nonatomic, copy) void (^onEvent)(NSDictionary *);
@property (nonatomic, copy) void (^onIdle)(void);
@property (nonatomic, readonly) BOOL running;
@property (nonatomic, readonly) NSURL *supportURL;
- (instancetype)initWithEngine:(NSURL *)engine support:(NSURL *)support;
- (NSDictionary *)snapshot;
- (NSDictionary *)tools;
- (NSArray *)lessons;
- (NSDictionary *)lesson:(NSString *)identifier error:(NSError **)error;
- (BOOL)deleteLesson:(NSString *)identifier error:(NSError **)error;
- (NSDictionary *)begin:(NSDictionary *)request error:(NSError **)error;
- (BOOL)append:(NSString *)encoded identifier:(NSString *)identifier error:(NSError **)error;
- (BOOL)start:(NSString *)identifier error:(NSError **)error;
- (BOOL)openVideo:(NSURL *)url error:(NSError **)error;
- (void)cancel;
@end
