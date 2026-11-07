#import <Foundation/Foundation.h>

@interface BLEMIDIDecoder : NSObject
- (BOOL)decode:(NSData *)packet
       handler:(void (^)(uint8_t status, uint8_t first, uint8_t second, uint16_t timestamp))handler
         error:(NSError **)error;
@end
