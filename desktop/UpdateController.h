#import <AppKit/AppKit.h>

@interface UpdateController : NSObject
@property (nonatomic, copy) void (^onChange)(NSDictionary *);
@property (nonatomic, readonly) BOOL installing;
- (void)start;
- (NSDictionary *)snapshot;
- (void)check:(id)sender;
- (void)acknowledge;
- (void)stop;
@end
