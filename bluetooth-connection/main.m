#import <Foundation/Foundation.h>
#import <CoreBluetooth/CoreBluetooth.h>
#import "BLEMIDI.h"
#import "BLEMIDIOutput.h"
#import <mach/mach_time.h>
#import <sys/file.h>
#import <sys/socket.h>
#import <sys/un.h>
#import <sys/stat.h>
#import <fcntl.h>
#import <signal.h>
#import <unistd.h>
#import <errno.h>
#import <math.h>

static NSString *const ServiceUUID = @"03B80E5A-EDE8-4B33-A751-6CE34EC4C700";
static NSString *const CharacteristicUUID = @"7772E5DB-3868-4112-A1A9-F2669D106BF3";
static mach_timebase_info_data_t Timebase;

static NSData *JSONLine(NSDictionary *value) {
    NSMutableData *data = [[NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:NULL] mutableCopy];
    [data appendBytes:"\n" length:1];
    return data;
}

static BOOL SendData(int fd, NSData *data) {
    NSUInteger offset = 0;
    while (offset < data.length) {
        ssize_t count = send(fd, (const char *)data.bytes + offset, data.length - offset, 0);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return NO;
        offset += (NSUInteger)count;
    }
    return YES;
}

static void Emit(NSString *event, NSDictionary *details) {
    NSMutableDictionary *value = [details mutableCopy];
    value[@"event"] = event;
    value[@"time_unix"] = @([NSDate.date timeIntervalSince1970]);
    NSData *data = JSONLine(value);
    fwrite(data.bytes, 1, data.length, stdout);
    fflush(stdout);
}

static NSString *Normalized(NSString *value) {
    NSCharacterSet *separators = [NSCharacterSet alphanumericCharacterSet].invertedSet;
    return [[[value uppercaseString] componentsSeparatedByCharactersInSet:separators] componentsJoinedByString:@""];
}

static BOOL Matches(NSString *name, NSString *target) {
    NSString *normalized = Normalized(name);
    NSString *wanted = Normalized(target);
    return [normalized isEqualToString:wanted] || [normalized isEqualToString:[wanted stringByAppendingString:@"MIDI"]];
}

static int ControlSocket(NSString *path, BOOL server) {
    struct sockaddr_un address = {0};
    address.sun_family = AF_UNIX;
    address.sun_len = sizeof(address);
    if ([path lengthOfBytesUsingEncoding:NSUTF8StringEncoding] >= sizeof(address.sun_path)) {
        errno = ENAMETOOLONG;
        return -1;
    }
    strlcpy(address.sun_path, path.fileSystemRepresentation, sizeof(address.sun_path));
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    int noSignal = 1; setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, sizeof(noSignal));
    fcntl(fd, F_SETFD, FD_CLOEXEC);
    int result = server ? bind(fd, (struct sockaddr *)&address, sizeof(address))
                        : connect(fd, (struct sockaddr *)&address, sizeof(address));
    if (result < 0) {
        int error = errno;
        close(fd);
        errno = error;
        return -1;
    }
    return fd;
}

NSDictionary *PianoBluetoothCommand(NSString *runtime, NSDictionary *request, NSError **error) {
    int fd = ControlSocket([runtime stringByAppendingPathComponent:@"control.sock"], NO);
    if (fd < 0) {
        if (error) *error = [NSError errorWithDomain:NSPOSIXErrorDomain code:errno userInfo:nil];
        return nil;
    }
    struct timeval timeout = {.tv_sec = 3};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    NSData *body = JSONLine(request);
    BOOL sent = SendData(fd, body);
    NSMutableData *reply = [NSMutableData new]; char buffer[1024]; ssize_t count = 0;
    if (sent) while ((count = recv(fd, buffer, sizeof(buffer), 0)) > 0) {
        [reply appendBytes:buffer length:(NSUInteger)count];
        if (reply.length > 65536) break;
    }
    close(fd);
    if (!sent || count < 0 || !reply.length) {
        if (error) *error = [NSError errorWithDomain:@"PianoMan.MIDIOutput" code:1
            userInfo:@{NSLocalizedDescriptionKey:@"Piyano çalma komutuna yanıt alınamadı."}];
        return nil;
    }
    return [NSJSONSerialization JSONObjectWithData:reply options:0 error:error];
}

@interface PianoConnection : NSObject <CBCentralManagerDelegate, CBPeripheralDelegate> {
    BLEMIDIDecoder *_decoder;
    BLEMIDIOutput *_output;
    CBCentralManager *_central;
    CBPeripheral *_peripheral;
    CBCharacteristic *_midiCharacteristic;
    dispatch_source_t _server;
    dispatch_source_t _interrupt;
    dispatch_source_t _terminate;
    dispatch_source_t _hangup;
    NSTimer *_deadline;
    NSTimer *_cleanupDeadline;
    NSTimer *_releaseDeadline;
    NSTimer *_duration;
    NSString *_target;
    NSUUID *_identifier;
    NSString *_phase;
    NSString *_socketPath;
    NSTimeInterval _timeoutSeconds;
    NSTimeInterval _durationSeconds;
    int _lockFD;
    BOOL _ready;
    BOOL _deviceSeen;
    BOOL _linkEstablished;
    NSDictionary *_diagnostic;
    BOOL _stopping;
    NSString *_stopReason;
    int _exitCode;
}
- (instancetype)initWithTarget:(NSString *)target identifier:(NSUUID *)identifier runtime:(NSString *)runtime timeout:(double)timeout duration:(double)duration;
- (void)start;
- (void)finish;
- (void)stop:(NSString *)reason code:(int)code;
- (void)reportIssue:(NSString *)code error:(NSError *)error;
@end

@implementation PianoConnection

- (instancetype)initWithTarget:(NSString *)target identifier:(NSUUID *)identifier runtime:(NSString *)runtime timeout:(double)timeout duration:(double)duration {
    self = [super init];
    if (self) {
        _target = target;
        _identifier = identifier;
        _socketPath = [runtime stringByAppendingPathComponent:@"control.sock"];
        _timeoutSeconds = timeout;
        _durationSeconds = duration;
        _phase = @"starting";
        _lockFD = -1;
        _decoder = [BLEMIDIDecoder new];
    }
    return self;
}

- (NSDictionary *)status {
    return @{@"event":@"status", @"pid":@(getpid()), @"phase":_phase,
             @"target":_target, @"ready":@(_ready && !_stopping),
             @"peripheral_uuid":_peripheral.identifier.UUIDString ?: @""};
}

- (void)fail:(NSString *)operation status:(long long)status {
    [self reportIssue:@"service_failed" error:[NSError errorWithDomain:NSPOSIXErrorDomain code:(NSInteger)status userInfo:nil]];
    [self stop:operation code:1];
}

- (void)reportIssue:(NSString *)code error:(NSError *)error {
    if (_diagnostic) return; // Cleanup must not erase the original cause.
    NSMutableDictionary *diagnostic = [@{@"code":code, @"stage":_phase,
        @"deviceSeen":@(_deviceSeen), @"linkEstablished":@(_linkEstablished)} mutableCopy];
    if (error) {
        diagnostic[@"domain"] = error.domain;
        diagnostic[@"osCode"] = @(error.code);
        diagnostic[@"detail"] = error.localizedDescription;
    }
    _diagnostic = diagnostic;
    Emit(@"connection_issue", @{@"diagnostic":diagnostic});
}

- (void)openControl {
    NSString *directory = _socketPath.stringByDeletingLastPathComponent;
    NSError *error = nil;
    if (![[NSFileManager defaultManager] createDirectoryAtPath:directory
                                 withIntermediateDirectories:YES
                                                  attributes:@{NSFilePosixPermissions:@0700}
                                                       error:&error]) {
        Emit(@"error", @{@"operation":@"runtime_directory", @"message":error.localizedDescription});
        exit(1);
    }
    struct stat directoryInfo;
    if (lstat(directory.fileSystemRepresentation, &directoryInfo) != 0 ||
        !S_ISDIR(directoryInfo.st_mode) || directoryInfo.st_uid != getuid()) {
        Emit(@"error", @{@"operation":@"runtime_directory", @"message":@"Expected a directory owned by this user."});
        exit(1);
    }
    chmod(directory.fileSystemRepresentation, 0700);
    NSString *lock = [directory stringByAppendingPathComponent:@"instance.lock"];
    _lockFD = open(lock.fileSystemRepresentation, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (_lockFD < 0) {
        Emit(@"error", @{@"operation":@"instance_lock", @"code":@(errno)});
        exit(1);
    }
    if (flock(_lockFD, LOCK_EX | LOCK_NB) < 0) {
        Emit(@"error", @{@"operation":@"start", @"message":@"An instance is already running. Use status or stop."});
        exit(2);
    }
    // Only the lock holder may remove a stale control socket.
    unlink(_socketPath.fileSystemRepresentation);
    int fd = ControlSocket(_socketPath, YES);
    if (fd < 0 || listen(fd, 4) < 0) [self fail:@"control_socket" status:errno];
    chmod(_socketPath.fileSystemRepresentation, 0600);
    fcntl(fd, F_SETFL, O_NONBLOCK);
    _server = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, fd, 0,
                                     dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
    __weak PianoConnection *weakSelf = self;
    dispatch_source_set_event_handler(_server, ^{
        int peer = accept(fd, NULL, NULL);
        if (peer < 0) return;
        // Darwin inherits O_NONBLOCK from the listening socket. This reader
        // deliberately waits on a background queue for one complete JSON line.
        int flags = fcntl(peer, F_GETFL, 0);
        if (flags < 0 || fcntl(peer, F_SETFL, flags & ~O_NONBLOCK) < 0) { close(peer); return; }
        fcntl(peer, F_SETFD, FD_CLOEXEC);
        int noSignal = 1; setsockopt(peer, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, sizeof(noSignal));
        uid_t uid;
        gid_t gid;
        if (getpeereid(peer, &uid, &gid) < 0 || uid != getuid()) {
            close(peer);
            return;
        }
        struct timeval timeout = {.tv_sec = 1};
        setsockopt(peer, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
        setsockopt(peer, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
        NSMutableData *request = [NSMutableData new]; char buffer[8192];
        while (request.length <= 4 * 1024 * 1024) {
            ssize_t size = recv(peer, buffer, sizeof(buffer), 0);
            if (size < 0 && errno == EINTR) continue;
            if (size <= 0) { close(peer); return; }
            [request appendBytes:buffer length:(NSUInteger)size];
            if (memchr(buffer, '\n', (NSUInteger)size)) break;
        }
        if (request.length > 4 * 1024 * 1024) { close(peer); return; }
        NSString *command = [[[NSString alloc] initWithData:request encoding:NSUTF8StringEncoding]
                             stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        id payload = [NSJSONSerialization JSONObjectWithData:request options:0 error:NULL];
        dispatch_async(dispatch_get_main_queue(), ^{
            PianoConnection *owner = weakSelf;
            NSDictionary *response = [command isEqualToString:@"status"] ? [owner status] :
                [command isEqualToString:@"stop"] ? @{@"event":@"stopping", @"pid":@(getpid())} : @{@"event":@"invalid_command"};
            if ([payload isKindOfClass:NSDictionary.class]) {
                response = owner->_ready && !owner->_stopping ? [owner->_output command:payload] :
                    @{@"error":@"Piyano bağlı değil."};
            }
            NSData *reply = JSONLine(response);
            BOOL stopRequested = [command isEqualToString:@"stop"];
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
                SendData(peer, reply); close(peer);
                if (stopRequested) dispatch_async(dispatch_get_main_queue(), ^{ [owner stop:@"requested" code:0]; });
            });
        });
    });
    dispatch_source_set_cancel_handler(_server, ^{ close(fd); });
    dispatch_resume(_server);
}

- (void)start {
    [self openControl];
    __weak PianoConnection *weakSelf = self;
    signal(SIGINT, SIG_IGN);
    signal(SIGTERM, SIG_IGN);
    signal(SIGHUP, SIG_IGN);
    _interrupt = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGINT, 0, dispatch_get_main_queue());
    _terminate = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(_interrupt, ^{ [weakSelf stop:@"interrupt" code:0]; });
    dispatch_source_set_event_handler(_terminate, ^{ [weakSelf stop:@"terminate" code:0]; });
    dispatch_resume(_interrupt);
    dispatch_resume(_terminate);
    _hangup = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGHUP, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(_hangup, ^{ [weakSelf stop:@"terminal_closed" code:0]; });
    dispatch_resume(_hangup);

    Emit(@"started", @{@"pid":@(getpid()), @"target":_target, @"transport":@"BLE MIDI"});
    NSTimeInterval timeout = _timeoutSeconds;
    _deadline = [NSTimer scheduledTimerWithTimeInterval:timeout repeats:NO block:^(NSTimer *timer) {
        (void)timer;
        PianoConnection *owner = weakSelf;
        NSString *reason = CBCentralManager.authorization == CBManagerAuthorizationNotDetermined ? @"permission_pending" :
            owner->_central.state != CBManagerStatePoweredOn ? @"mac_bluetooth_unavailable" :
            owner->_linkEstablished ? @"midi_timeout" : @"piano_unreachable";
        [owner stop:reason code:3];
    }];
    _central = [[CBCentralManager alloc] initWithDelegate:self queue:dispatch_get_main_queue()
                                                options:@{CBCentralManagerOptionShowPowerAlertKey:@YES}];
}

- (void)centralManagerDidUpdateState:(CBCentralManager *)central {
    if (_stopping) return;
    switch (central.state) {
        case CBManagerStatePoweredOn: {
            if (_ready || _peripheral) return;
            _phase = @"scanning";
            if (_identifier) {
                NSArray<CBPeripheral *> *known = [central retrievePeripheralsWithIdentifiers:@[_identifier]];
                if (known.count) {
                    Emit(@"known_peripheral", @{@"uuid":_identifier.UUIDString, @"state":@(known.firstObject.state)});
                    [self connect:known.firstObject];
                    return;
                }
            }
            CBUUID *service = [CBUUID UUIDWithString:ServiceUUID];
            for (CBPeripheral *peripheral in [central retrieveConnectedPeripheralsWithServices:@[service]]) {
                if (_identifier ? [peripheral.identifier isEqual:_identifier] : Matches(peripheral.name ?: @"", _target)) {
                    [self connect:peripheral];
                    return;
                }
            }
            [central scanForPeripheralsWithServices:@[service]
                                           options:@{CBCentralManagerScanOptionAllowDuplicatesKey:@NO}];
            Emit(@"scanning", @{@"target":_target});
            break;
        }
        case CBManagerStateUnauthorized:
            [self stop:CBCentralManager.authorization == CBManagerAuthorizationRestricted ?
                @"permission_restricted" : @"permission_denied" code:4];
            break;
        case CBManagerStatePoweredOff:
            [self stop:@"mac_bluetooth_off" code:4];
            break;
        case CBManagerStateUnsupported:
            [self stop:@"mac_bluetooth_unsupported" code:4];
            break;
        case CBManagerStateResetting:
            if (_ready || _peripheral) { [self stop:@"mac_bluetooth_reset" code:4]; break; }
            _phase = @"waiting_for_bluetooth";
            Emit(@"bluetooth_waiting", @{@"reason":@"resetting"});
            break;
        default:
            if (_ready) { [self stop:@"mac_bluetooth_unavailable" code:4]; break; }
            _phase = @"waiting_for_bluetooth";
            Emit(@"bluetooth_waiting", @{@"reason":@"initializing"});
            break;
    }
}

- (void)centralManager:(CBCentralManager *)central didDiscoverPeripheral:(CBPeripheral *)peripheral
    advertisementData:(NSDictionary<NSString *,id> *)advertisementData RSSI:(NSNumber *)RSSI {
    (void)central;
    NSString *name = advertisementData[CBAdvertisementDataLocalNameKey] ?: peripheral.name ?: @"";
    BOOL matches = _identifier ? [peripheral.identifier isEqual:_identifier] : Matches(name, _target);
    if (!matches || _peripheral || _ready || _stopping) return;
    _deviceSeen = YES;
    Emit(@"discovered", @{@"name":name, @"uuid":peripheral.identifier.UUIDString, @"rssi":RSSI});
    [self connect:peripheral];
}

- (void)connect:(CBPeripheral *)peripheral {
    _peripheral = peripheral;
    _peripheral.delegate = self;
    _phase = @"connecting";
    [_central stopScan];
    Emit(@"connecting", @{@"name":peripheral.name ?: _target, @"uuid":peripheral.identifier.UUIDString});
    [_central connectPeripheral:peripheral options:nil];
}

- (void)centralManager:(CBCentralManager *)central didConnectPeripheral:(CBPeripheral *)peripheral {
    (void)central;
    if (_stopping) return;
    _linkEstablished = YES;
    _phase = @"discovering_midi_service";
    Emit(@"midi_discovery", @{});
    [peripheral discoverServices:@[[CBUUID UUIDWithString:ServiceUUID]]];
}

- (void)peripheral:(CBPeripheral *)peripheral didDiscoverServices:(NSError *)error {
    if (error) {
        [self reportIssue:@"midi_discovery_failed" error:error];
        [self stop:@"discover_services" code:1];
        return;
    }
    for (CBService *service in peripheral.services) {
        if ([service.UUID isEqual:[CBUUID UUIDWithString:ServiceUUID]]) {
            [peripheral discoverCharacteristics:@[[CBUUID UUIDWithString:CharacteristicUUID]] forService:service];
            return;
        }
    }
    [self stop:@"midi_service_missing" code:1];
}

- (void)peripheral:(CBPeripheral *)peripheral didDiscoverCharacteristicsForService:(CBService *)service
             error:(NSError *)error {
    (void)peripheral;
    if (error) {
        [self reportIssue:@"midi_discovery_failed" error:error];
        [self stop:@"discover_characteristics" code:1];
        return;
    }
    for (CBCharacteristic *characteristic in service.characteristics) {
        if ([characteristic.UUID isEqual:[CBUUID UUIDWithString:CharacteristicUUID]]) {
            _midiCharacteristic = characteristic;
            _phase = @"authenticating_midi";
            Emit(@"midi_initial_read", @{@"properties":@(characteristic.properties)});
            // BLE-MIDI 1.0 section 5: read the I/O characteristic after connecting.
            // The peripheral normally returns an empty value; encryption/pairing may occur here.
            [peripheral readValueForCharacteristic:characteristic];
            return;
        }
    }
    [self stop:@"midi_characteristic_missing" code:1];
}

- (void)peripheral:(CBPeripheral *)peripheral didUpdateValueForCharacteristic:(CBCharacteristic *)characteristic
             error:(NSError *)error {
    if (_stopping || characteristic != _midiCharacteristic) return;
    if (error) {
        BOOL authorization = ([error.domain isEqual:CBATTErrorDomain] &&
            (error.code == CBATTErrorInsufficientAuthentication || error.code == CBATTErrorInsufficientEncryption ||
             error.code == CBATTErrorInsufficientAuthorization)) ||
            ([error.domain isEqual:CBErrorDomain] && error.code == CBErrorPeerRemovedPairingInformation);
        [self reportIssue:authorization ? @"pairing_failed" : @"midi_read_failed" error:error];
        [self stop:@"midi_read_failed" code:1];
        return;
    }
    if ([_phase isEqualToString:@"authenticating_midi"]) {
        Emit(@"midi_handshake_complete", @{@"bytes":@(characteristic.value.length)});
        _phase = @"subscribing";
        [peripheral setNotifyValue:YES forCharacteristic:characteristic];
        return; // The initial GATT read is a handshake, not a MIDI notification.
    }
    if (characteristic.value.length) {
        double received = (double)mach_absolute_time() * Timebase.numer / Timebase.denom / 1e9;
        NSError *decodeError = nil;
        BOOL valid = [_decoder decode:characteristic.value handler:^(uint8_t status, uint8_t first, uint8_t second, uint16_t timestamp) {
            [self receiveStatus:status first:first second:second deviceTime:timestamp received:received];
        } error:&decodeError];
        if (!valid) {
            [self reportIssue:@"invalid_ble_midi" error:decodeError];
            [self stop:@"invalid_ble_midi" code:1];
        }
    }
}

- (void)peripheral:(CBPeripheral *)peripheral didUpdateNotificationStateForCharacteristic:(CBCharacteristic *)characteristic
             error:(NSError *)error {
    (void)peripheral;
    if (_stopping || characteristic != _midiCharacteristic) return;
    if (error || !characteristic.isNotifying) {
        [self reportIssue:@"midi_subscription_failed" error:error];
        [self stop:@"midi_subscription_failed" code:1];
        return;
    }
    _ready = YES;
    _output = [[BLEMIDIOutput alloc] initWithPeripheral:peripheral characteristic:characteristic
        onError:^(NSString *message) { Emit(@"output_error", @{@"message":message}); }];
    _phase = @"listening";
    [_deadline invalidate];
    BOOL outputCapable = (characteristic.properties & CBCharacteristicPropertyWriteWithoutResponse) != 0;
    Emit(@"ready", @{@"target":_target, @"uuid":_peripheral.identifier.UUIDString,
        @"output_capable":@(outputCapable)});
    if (_durationSeconds > 0) {
        __weak PianoConnection *weakSelf = self;
        _duration = [NSTimer scheduledTimerWithTimeInterval:_durationSeconds repeats:NO block:^(NSTimer *timer) {
            (void)timer;
            [weakSelf stop:@"duration_elapsed" code:0];
        }];
    }
}

- (void)peripheralIsReadyToSendWriteWithoutResponse:(CBPeripheral *)peripheral {
    (void)peripheral; [_output flush];
}

- (void)receiveStatus:(uint8_t)status first:(uint8_t)data1 second:(uint8_t)data2
          deviceTime:(uint16_t)timestamp received:(double)received {
    if (_stopping) return;
    unsigned kind = status & 0xF0;
    NSMutableDictionary *value = [@{@"channel":@((status & 15) + 1),
        @"device_time_ms":@(timestamp), @"received_monotonic_seconds":@(received)} mutableCopy];
    if (kind == 0x80 || kind == 0x90) {
        static NSArray<NSString *> *names;
        static dispatch_once_t once;
        dispatch_once(&once, ^{ names = @[@"C",@"C#",@"D",@"D#",@"E",@"F",@"F#",@"G",@"G#",@"A",@"A#",@"B"]; });
        value[@"note"] = @(data1);
        value[@"name"] = [NSString stringWithFormat:@"%@%d", names[data1 % 12], (int)data1 / 12 - 1];
        value[@"velocity"] = @(data2);
        Emit(kind == 0x90 && data2 != 0 ? @"note_on" : @"note_off", value);
    } else if (kind == 0xB0) {
        value[@"controller"] = @(data1);
        value[@"value"] = @(data2);
        if (data1 == 64 || data1 == 66 || data1 == 67) {
            value[@"pedal"] = data1 == 64 ? @"sustain" : data1 == 66 ? @"sostenuto" : @"soft";
            value[@"pressed"] = @(data2 >= 64);
            Emit(@"pedal", value);
        } else {
            Emit(@"control_change", value);
        }
    } else {
        value[@"status"] = @(status);
        value[@"data1"] = @(data1);
        value[@"data2"] = @(data2);
        Emit(@"midi_message", value);
    }
}

- (void)centralManager:(CBCentralManager *)central didFailToConnectPeripheral:(CBPeripheral *)peripheral error:(NSError *)error {
    (void)central;
    (void)peripheral;
    if (_stopping) { [self finish]; return; }
    [self reportIssue:([error.domain isEqual:CBErrorDomain] && error.code == CBErrorPeerRemovedPairingInformation) ?
        @"pairing_failed" : @"connect_failed" error:error];
    [self stop:@"connect_failed" code:1];
}

- (void)centralManager:(CBCentralManager *)central didDisconnectPeripheral:(CBPeripheral *)peripheral error:(NSError *)error {
    (void)central;
    (void)peripheral;
    if (_stopping) { [self finish]; return; }
    [self reportIssue:@"connection_lost" error:error];
    [self stop:@"bluetooth_disconnected" code:5];
}

- (void)stop:(NSString *)reason code:(int)code {
    if (_stopping) return;
    if (code != 0) [self reportIssue:reason error:nil];
    _stopping = YES;
    _phase = @"stopping";
    _stopReason = reason;
    _exitCode = code;
    [_deadline invalidate];
    [_duration invalidate];
    [_central stopScan];
    [_output stop];
    if (_peripheral && _peripheral.state != CBPeripheralStateDisconnected) {
        _phase = @"disconnecting";
        __weak PianoConnection *weakSelf = self;
        _cleanupDeadline = [NSTimer scheduledTimerWithTimeInterval:4 repeats:NO block:^(NSTimer *timer) {
            (void)timer;
            PianoConnection *owner = weakSelf;
            [owner reportIssue:@"disconnect_unconfirmed" error:nil];
            if (!owner->_exitCode) owner->_exitCode = 1;
            [owner finish];
        }];
        // Drain our note-offs and sustain release before closing our BLE link.
        __weak PianoConnection *closingOwner = self;
        double started = NSProcessInfo.processInfo.systemUptime;
        _releaseDeadline = [NSTimer scheduledTimerWithTimeInterval:.01 repeats:YES block:^(NSTimer *timer) {
            PianoConnection *owner = closingOwner;
            if (!owner) { [timer invalidate]; return; }
            if (!owner->_output || owner->_output.drained || NSProcessInfo.processInfo.systemUptime - started > 1) {
                [timer invalidate];
                if (owner->_output && !owner->_output.drained)
                    Emit(@"output_error", @{@"message":@"Nota bırakma gönderimi tamamlanmadan bağlantı kapanıyor."});
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
                    [owner->_central cancelPeripheralConnection:owner->_peripheral];
                });
            }
        }];
        return;
    }
    [self finish];
}

- (void)finish {
    [_releaseDeadline invalidate];
    [_cleanupDeadline invalidate];
    BOOL closed = !_peripheral || _peripheral.state == CBPeripheralStateDisconnected;
    NSMutableDictionary *result = [@{@"event":@"stopped", @"reason":_stopReason, @"exit_code":@(_exitCode),
                             @"pid":@(getpid()), @"own_connection_closed":@(closed)} mutableCopy];
    if (_diagnostic) {
        NSMutableDictionary *diagnostic = [_diagnostic mutableCopy];
        diagnostic[@"cleanupConfirmed"] = @(closed);
        result[@"diagnostic"] = diagnostic;
    }
    NSString *receipt = [_socketPath.stringByDeletingLastPathComponent stringByAppendingPathComponent:@"last-exit.json"];
    NSError *receiptError = nil;
    if (![JSONLine(result) writeToFile:receipt options:NSDataWritingAtomic error:&receiptError]) {
        Emit(@"error", @{@"operation":@"shutdown_receipt", @"message":receiptError.localizedDescription});
        if (!_exitCode) _exitCode = 1;
        result[@"exit_code"] = @(_exitCode);
    }
    _peripheral.delegate = nil;
    _central.delegate = nil;
    _peripheral = nil;
    _central = nil;
    if (_server) dispatch_source_cancel(_server);
    unlink(_socketPath.fileSystemRepresentation);
    Emit(@"stopped", result);
    if (_lockFD >= 0) close(_lockFD);
    exit(_exitCode);
}
@end

static int Control(NSString *runtime, NSString *command) {
    NSString *path = [runtime stringByAppendingPathComponent:@"control.sock"];
    int fd = ControlSocket(path, NO);
    if (fd < 0) {
        if (errno == ENOENT || errno == ECONNREFUSED) {
            Emit(@"not_running", @{});
            return 0;
        }
        Emit(@"error", @{@"operation":@"control_connect", @"code":@(errno)});
        return 1;
    }
    struct timeval timeout = {.tv_sec = 3};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    NSData *request = [[command stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
    if (send(fd, request.bytes, request.length, 0) != (ssize_t)request.length) {
        int error = errno;
        close(fd);
        Emit(@"error", @{@"operation":@"control_send", @"code":@(error)});
        return 1;
    }
    NSMutableData *response = [NSMutableData data];
    char buffer[512];
    ssize_t count;
    while ((count = recv(fd, buffer, sizeof(buffer), 0)) > 0) [response appendBytes:buffer length:(NSUInteger)count];
    int readError = errno;
    close(fd);
    if (count < 0 || !response.length) {
        Emit(@"error", @{@"operation":@"control_reply", @"code":@(readError)});
        return 1;
    }
    fwrite(response.bytes, 1, response.length, stdout);
    fflush(stdout);
    if ([command isEqualToString:@"stop"]) {
        NSString *lock = [runtime stringByAppendingPathComponent:@"instance.lock"];
        int lockFD = open(lock.fileSystemRepresentation, O_RDWR | O_NOFOLLOW | O_CLOEXEC);
        if (lockFD >= 0) {
            // Confirm the owner completed cleanup before reporting stop success.
            for (int i = 0; i < 50; i++) {
                if (flock(lockFD, LOCK_EX | LOCK_NB) == 0) {
                    close(lockFD);
                    NSDictionary *ack = [NSJSONSerialization JSONObjectWithData:response options:0 error:NULL];
                    NSString *receipt = [runtime stringByAppendingPathComponent:@"last-exit.json"];
                    NSData *resultData = [NSData dataWithContentsOfFile:receipt];
                    NSDictionary *result = resultData ? [NSJSONSerialization JSONObjectWithData:resultData options:0 error:NULL] : nil;
                    if (![result[@"pid"] isEqual:ack[@"pid"]]) {
                        Emit(@"error", @{@"operation":@"stop", @"message":@"No matching cleanup receipt."});
                        return 1;
                    }
                    Emit(@"cleanup_complete", result);
                    return [result[@"exit_code"] intValue];
                }
                usleep(100000);
            }
            close(lockFD);
            Emit(@"error", @{@"operation":@"stop", @"message":@"Cleanup did not finish within five seconds; no forced kill was used."});
            return 1;
        }
    }
    return 0;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        signal(SIGPIPE, SIG_IGN);
        mach_timebase_info(&Timebase);
        if (argc < 3) {
            fprintf(stderr, "Usage: piano start|stop|status [--name CLP-835] [--timeout 60] [--duration 0]\n");
            return 64;
        }
        NSString *runtime = [NSString stringWithUTF8String:argv[1]];
        NSString *command = [NSString stringWithUTF8String:argv[2]];
        if ([command isEqualToString:@"stop"] || [command isEqualToString:@"status"]) return Control(runtime, command);
        if (![command isEqualToString:@"start"]) return 64;
        NSString *name = @"CLP-835";
        NSUUID *identifier = nil;
        double timeout = 60;
        double duration = 0;
        for (int i = 3; i < argc; i += 2) {
            if (i + 1 >= argc) return 64;
            NSString *option = [NSString stringWithUTF8String:argv[i]];
            NSString *value = [NSString stringWithUTF8String:argv[i + 1]];
            if ([option isEqualToString:@"--name"]) name = value;
            else if ([option isEqualToString:@"--uuid"]) {
                identifier = [[NSUUID alloc] initWithUUIDString:value];
                if (!identifier) return 64;
            }
            else {
                char *end;
                double number = strtod(argv[i + 1], &end);
                if (*end || !isfinite(number)) return 64;
                if ([option isEqualToString:@"--timeout"] && number > 0) timeout = number;
                else if ([option isEqualToString:@"--duration"] && number >= 0) duration = number;
                else return 64;
            }
        }
        if (!Normalized(name).length) return 64;
        PianoConnection *connection = [[PianoConnection alloc] initWithTarget:name identifier:identifier runtime:runtime timeout:timeout duration:duration];
        [connection start];
        [[NSRunLoop mainRunLoop] run];
    }
    return 0;
}
