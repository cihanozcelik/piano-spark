#import <Foundation/Foundation.h>
#import <CoreBluetooth/CoreBluetooth.h>

@interface BLEMIDIOutput : NSObject
@property (nonatomic, readonly) BOOL drained;
- (instancetype)initWithPeripheral:(CBPeripheral *)peripheral characteristic:(CBCharacteristic *)characteristic
                           onError:(void (^)(NSString *))onError;
- (NSDictionary *)command:(NSDictionary *)request;
- (void)flush;
- (void)stop;
@end

NSDictionary *PianoBluetoothCommand(NSString *runtime, NSDictionary *request, NSError **error);
