#import "BLEMIDIOutput.h"
#import <math.h>

// The BLE connection owns this sender. All methods run on its main queue.
@implementation BLEMIDIOutput {
    CBPeripheral *_peripheral;
    CBCharacteristic *_characteristic;
    void (^_onError)(NSString *);
    NSArray<NSArray<NSNumber *> *> *_events;
    NSArray<NSArray<NSNumber *> *> *_releases;
    NSUInteger _index, _releaseIndex;
    NSUInteger _held[2][128];
    BOOL _used[2];
    NSString *_session;
    NSTimer *_timer;
    double _anchor, _lease, _end;
}

- (instancetype)initWithPeripheral:(CBPeripheral *)peripheral characteristic:(CBCharacteristic *)characteristic
                           onError:(void (^)(NSString *))onError {
    if ((self = [super init])) {
        _peripheral = peripheral; _characteristic = characteristic; _onError = [onError copy];
    }
    return self;
}

- (BOOL)drained { return _releaseIndex >= _releases.count; }

- (void)startTimer {
    if (_timer) return;
    __weak BLEMIDIOutput *weakSelf = self;
    _timer = [NSTimer timerWithTimeInterval:.005 repeats:YES block:^(NSTimer *timer) {
        (void)timer; [weakSelf flush];
    }];
    [NSRunLoop.mainRunLoop addTimer:_timer forMode:NSRunLoopCommonModes];
}

- (NSDictionary *)command:(NSDictionary *)request {
    NSString *kind = request[@"command"], *session = request[@"session"];
    if (![session isKindOfClass:NSString.class] || session.length > 80 || !session.length)
        return @{@"error":@"Geçersiz çalma oturumu."};
    if ([kind isEqual:@"output-stop"]) {
        if ([_session isEqual:session]) [self stop];
        return @{@"ok":@YES};
    }
    if ([kind isEqual:@"output-heartbeat"]) {
        if ([_session isEqual:session]) _lease = NSProcessInfo.processInfo.systemUptime;
        return @{@"ok":@YES};
    }
    if (![kind isEqual:@"output-start"]) return @{@"error":@"Geçersiz MIDI çıkış komutu."};
    if (_session || !self.drained) return @{@"error":@"Önce mevcut piyano çalmasını durdur."};
    if (_peripheral.state != CBPeripheralStateConnected ||
        !(_characteristic.properties & CBCharacteristicPropertyWriteWithoutResponse))
        return @{@"error":@"Bu bağlantıda MIDI gönderimi hazır değil."};
    NSArray *events = request[@"events"];
    double duration = [request[@"duration"] doubleValue], previous = -1;
    if (![events isKindOfClass:NSArray.class] || events.count > 100000 ||
        !isfinite(duration) || duration < 0 || duration > 86400)
        return @{@"error":@"Ders MIDI çıkışı için çok büyük veya geçersiz."};
    for (id item in events) {
        if (![item isKindOfClass:NSArray.class] || [item count] != 4)
            return @{@"error":@"Geçersiz MIDI olayı."};
        for (id value in item) if (![value isKindOfClass:NSNumber.class])
            return @{@"error":@"Geçersiz MIDI değeri."};
        double at = [item[0] doubleValue]; int status = [item[1] intValue];
        int first = [item[2] intValue], second = [item[3] intValue], type = status & 0xF0;
        if (!isfinite(at) || at < previous || at < 0 || at > duration ||
            (status & 15) > 1 || (type != 0x80 && type != 0x90 && type != 0xB0) ||
            status > 255 || status < 0 || first < 0 || first > 127 || second < 0 || second > 127 ||
            (type == 0xB0 && first != 64)) return @{@"error":@"Desteklenmeyen MIDI olayı."};
        previous = at;
    }
    _events = events; _index = 0; _session = session;
    _lease = NSProcessInfo.processInfo.systemUptime; _anchor = _lease + .12; _end = duration;
    [self startTimer];
    return @{@"ok":@YES, @"start_unix_ms":@(([NSDate.date timeIntervalSince1970] + .12) * 1000)};
}

- (void)write:(NSArray<NSNumber *> *)event {
    uint8_t status = event[1].unsignedCharValue, first = event[2].unsignedCharValue, second = event[3].unsignedCharValue;
    unsigned channel = status & 15, type = status & 0xF0;
    if (type == 0x80 || (type == 0x90 && !second)) {
        if (_held[channel][first] > 1) { _held[channel][first]--; return; }
        _held[channel][first] = 0;
    } else if (type == 0x90) _held[channel][first]++;
    _used[channel] = YES;
    uint16_t timestamp = (uint16_t)((uint64_t)(NSProcessInfo.processInfo.systemUptime * 1000) & 8191);
    uint8_t packet[] = {0x80 | (timestamp >> 7), 0x80 | (timestamp & 127), status, first, second};
    [_peripheral writeValue:[NSData dataWithBytes:packet length:sizeof(packet)]
         forCharacteristic:_characteristic type:CBCharacteristicWriteWithoutResponse];
}

- (void)flush {
    if (_peripheral.state != CBPeripheralStateConnected) {
        [_timer invalidate]; _timer = nil; _session = nil; _events = nil; _releases = nil;
        return;
    }
    double now = NSProcessInfo.processInfo.systemUptime;
    if (_session && now - _lease > 2) {
        [self stop]; _onError(@"Çalma sayfasıyla iletişim kesildi; piyano çalması durduruldu."); return;
    }
    while (!self.drained && _peripheral.canSendWriteWithoutResponse) [self write:_releases[_releaseIndex++]];
    if (!self.drained) return;
    if (_releases) {
        _releases = nil; _releaseIndex = 0;
        memset(_used, 0, sizeof(_used));
    }
    if (!_session) { [_timer invalidate]; _timer = nil; return; }
    double time = now - _anchor;
    if (_index < _events.count && time - [_events[_index][0] doubleValue] > .35) {
        [self stop]; _onError(@"Bluetooth MIDI gönderimi gecikti; çalma durduruldu."); return;
    }
    while (_index < _events.count && [_events[_index][0] doubleValue] <= time &&
           _peripheral.canSendWriteWithoutResponse) [self write:_events[_index++]];
    if (_index == _events.count && time >= _end) [self stop];
}

- (void)stop {
    _session = nil; _events = nil;
    NSMutableArray *releases = [NSMutableArray new];
    for (unsigned channel = 0; channel < 2; channel++) {
        if (!_used[channel]) continue;
        [releases addObject:@[@0,@(0xB0 | channel),@64,@0]];
        for (unsigned pitch = 0; pitch < 128; pitch++) {
            if (!_held[channel][pitch]) continue;
            _held[channel][pitch] = 1;
            [releases addObject:@[@0,@(0x80 | channel),@(pitch),@0]];
        }
    }
    _releases = releases; _releaseIndex = 0;
    [self startTimer]; [self flush];
}

- (void)dealloc { [_timer invalidate]; }
@end
