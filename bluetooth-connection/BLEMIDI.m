#import "BLEMIDI.h"

@implementation BLEMIDIDecoder {
    BOOL _sysex;
}

- (BOOL)invalid:(NSString *)message at:(NSUInteger)position error:(NSError **)error {
    _sysex = NO;
    if (error) *error = [NSError errorWithDomain:@"Rach3.BLEMIDI" code:1
        userInfo:@{NSLocalizedDescriptionKey:[NSString stringWithFormat:@"%@ (byte %lu)", message, (unsigned long)position]}];
    return NO;
}

- (BOOL)decode:(NSData *)packet
       handler:(void (^)(uint8_t, uint8_t, uint8_t, uint16_t))handler
         error:(NSError **)error {
    const uint8_t *bytes = packet.bytes;
    NSUInteger length = packet.length;
    if (!length) return YES;
    if ((bytes[0] & 0xC0) != 0x80)
        return [self invalid:@"Invalid BLE-MIDI header" at:0 error:error];
    uint8_t high = bytes[0] & 0x3F, running = 0;
    int previousLow = -1;
    uint16_t timestamp = 0;
    BOOL timestampRequired = YES;
    NSUInteger position = 1;
    while (position < length) {
        // Only SysEx may continue across packets. Its payload is deliberately not retained.
        if (_sysex && bytes[position] < 0x80) {
            position++;
            continue;
        }
        BOOL hasTimestamp = bytes[position] >= 0x80;
        if (hasTimestamp) {
            uint8_t low = bytes[position++] & 0x7F;
            if (previousLow >= 0 && low < previousLow) high = (high + 1) & 0x3F;
            previousLow = low;
            timestamp = ((uint16_t)high << 7) | low;
            if (position == length)
                return [self invalid:@"Timestamp without MIDI message" at:position error:error];
        } else if (timestampRequired) {
            return [self invalid:@"Missing MIDI timestamp" at:position error:error];
        }
        uint8_t status;
        if (bytes[position] >= 0x80) {
            if (!hasTimestamp)
                return [self invalid:@"Status without timestamp" at:position error:error];
            status = bytes[position++];
        } else {
            if (!running || _sysex)
                return [self invalid:@"Running status without a channel message" at:position error:error];
            status = running;
        }
        if (_sysex) {
            if (status == 0xF7) _sysex = NO;
            else if (status < 0xF8)
                return [self invalid:@"Unexpected status inside SysEx" at:position - 1 error:error];
            timestampRequired = YES;
            continue;
        }
        if (status == 0xF0) {
            _sysex = YES;
            timestampRequired = YES;
            continue;
        }
        if (status >= 0xF8) {
            // Timing clock/active sensing are not piano key or pedal events.
            timestampRequired = YES;
            continue;
        }
        unsigned count;
        if (status < 0xF0) {
            running = status;
            unsigned kind = status & 0xF0;
            count = kind == 0xC0 || kind == 0xD0 ? 1 : 2;
            timestampRequired = NO;
        } else {
            count = status == 0xF2 ? 2 : (status == 0xF1 || status == 0xF3 ? 1 : 0);
            timestampRequired = YES;
        }
        if (position + count > length)
            return [self invalid:@"Truncated MIDI message" at:position error:error];
        for (unsigned i = 0; i < count; i++)
            if (bytes[position + i] >= 0x80)
                return [self invalid:@"Status inside MIDI data" at:position + i error:error];
        uint8_t first = count ? bytes[position] : 0;
        uint8_t second = count > 1 ? bytes[position + 1] : 0;
        position += count;
        handler(status, first, second, timestamp);
    }
    return YES;
}
@end
