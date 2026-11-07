#import <Foundation/Foundation.h>

// One persisted language for native controls and the embedded application.
FOUNDATION_EXPORT NSString *PianoLanguage(void);
FOUNDATION_EXPORT void PianoSetLanguage(NSString *language);
FOUNDATION_EXPORT NSString *PianoText(NSString *text);
// Translate only app-owned status text, preserving user titles and external diagnostics.
FOUNDATION_EXPORT NSDictionary *PianoLocalizedStatus(NSDictionary *status);
