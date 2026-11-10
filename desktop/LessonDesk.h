#import <Foundation/Foundation.h>

// The desk behind the "With AI" tab of Create a Lesson: the conversation with
// ChatGPT about which piece to learn, and the candidates it showed (a YouTube
// video, a MIDI file or a PDF score). rach3 itself fetches every candidate, so
// Codex never downloads anything. Kept in Application Support/Rach3/Customize/desk.
@interface LessonDesk : NSObject
- (instancetype)initWithRoot:(NSURL *)root;
@property (nonatomic, readonly) NSArray<NSDictionary *> *entries;
- (void)addEntry:(NSDictionary *)entry;
// Forgets the conversation and its candidates.
- (void)clear;
// Fetches a candidate: `source` is a YouTube link or an https link to a MIDI or PDF file.
// Calls back on the main queue with the card to show, or an error for ChatGPT.
- (void)show:(NSString *)source title:(NSString *)title note:(NSString *)note
        done:(void (^)(NSDictionary *card, NSString *error))done;
- (NSMutableDictionary *)card:(NSString *)identifier;
- (void)update:(NSDictionary *)card;
// The downloaded file of a MIDI or PDF candidate.
- (NSURL *)fileOf:(NSString *)identifier;
// Called on the main queue while a candidate is fetched: {stage: download|video|pages,
// host, received, total}, so the page can say what is happening.
@property (nonatomic, copy) void (^onProgress)(NSDictionary *progress);
// Files the page may load, at "_desk/<card>/<name>".
- (NSData *)servedFile:(NSString *)path type:(NSString **)type;
@end
