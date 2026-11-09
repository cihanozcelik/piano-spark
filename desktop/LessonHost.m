// Development HTTP transport uses exactly the app's lesson lifecycle owner.
#import "LessonService.h"
#import <signal.h>
#import <unistd.h>

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc!=4) return 2;
        LessonService *service = [[LessonService alloc]
            initWithEngine:[NSURL fileURLWithPath:@(argv[1])]
            support:[NSURL fileURLWithPath:@(argv[2])] tools:[NSURL fileURLWithPath:@(argv[3])]];
        __block BOOL closing = NO;
        service.onIdle = ^{ if (closing) exit(0); };
        void (^close)(void) = ^{ closing = YES; [service cancel]; if (!service.running) exit(0); };
        pid_t parent = getppid();
        dispatch_source_t parentWatch = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER,0,0,dispatch_get_main_queue());
        dispatch_source_set_timer(parentWatch,dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC),NSEC_PER_SEC,0);
        dispatch_source_set_event_handler(parentWatch, ^{ if (getppid()!=parent) close(); });
        dispatch_resume(parentWatch);
        signal(SIGTERM,SIG_IGN);
        dispatch_source_t termination = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL,SIGTERM,0,dispatch_get_main_queue());
        dispatch_source_set_event_handler(termination,close); dispatch_resume(termination);
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0), ^{
            char *line = NULL; size_t capacity = 0;
            while (getline(&line,&capacity,stdin)>0) {
                @autoreleasepool {
                    NSData *data = [@(line) dataUsingEncoding:NSUTF8StringEncoding];
                    NSDictionary *request = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
                    dispatch_sync(dispatch_get_main_queue(), ^{
                        NSError *error = nil; id result = nil;
                        NSString *command = request[@"command"];
                        if ([command isEqual:@"lesson-state"]) result = [service snapshot];
                        else if ([command isEqual:@"lesson-tools"]) result = [service tools];
                        else if ([command isEqual:@"lesson-list"]) result = [service lessons];
                        else if ([command isEqual:@"lesson-delete"]) result = @([service deleteLesson:request[@"id"] error:&error]);
                        else if ([command isEqual:@"lesson-load"]) result = [service lesson:request[@"id"] error:&error];
                        else if ([command isEqual:@"lesson-begin"]) result = [service begin:request error:&error];
                        else if ([command isEqual:@"lesson-chunk"]) result = @([service append:request[@"data"] identifier:request[@"id"] error:&error]);
                        else if ([command isEqual:@"lesson-start"]) result = @([service start:request[@"id"] error:&error]);
                        else if ([command isEqual:@"lesson-cancel"]) { [service cancel]; result = @{}; }
                        else error = [NSError errorWithDomain:@"Rach3" code:1 userInfo:@{NSLocalizedDescriptionKey:@"Bilinmeyen ders komutu"}];
                        NSDictionary *reply = error ? @{@"error":error.localizedDescription} : @{@"result":result ?: NSNull.null};
                        NSData *encoded = [NSJSONSerialization dataWithJSONObject:reply options:0 error:NULL];
                        fwrite(encoded.bytes,1,encoded.length,stdout); fputc('\n',stdout); fflush(stdout);
                    });
                }
            }
            free(line); dispatch_async(dispatch_get_main_queue(),close);
        });
        dispatch_main();
    }
}
