// Sparkle for the Electron shell: desktop/UpdateController.m, unchanged, as a Node addon.
// The Mac app keeps its update system exactly: the same signed feed, key and patches.
// JavaScript side: electron/updates.js.
#import <AppKit/AppKit.h>
#import <node_api.h>
#import "../../desktop/UpdateController.h"

static UpdateController *controller;
static napi_threadsafe_function notify;

static NSString *Json(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
    return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"null";
}

static napi_value Text(napi_env env, NSString *text) {
    napi_value value;
    napi_create_string_utf8(env, text.UTF8String, NAPI_AUTO_LENGTH, &value);
    return value;
}

static napi_value Nothing(napi_env env) {
    napi_value value;
    napi_get_undefined(env, &value);
    return value;
}

// Runs on the JavaScript thread with one update event as JSON text.
static void Deliver(napi_env env, napi_value callback, void *context, void *data) {
    (void)context;
    NSString *json = CFBridgingRelease(data);
    if (!env || !callback) return;
    napi_value argument = Text(env, json), result;
    napi_call_function(env, Nothing(env), callback, 1, &argument, &result);
}

// create(onChange): onChange receives every update event as JSON text.
static napi_value Create(napi_env env, napi_callback_info info) {
    size_t count = 1;
    napi_value arguments[1];
    napi_get_cb_info(env, info, &count, arguments, NULL, NULL);
    if (controller || count < 1) return Nothing(env);
    if (napi_create_threadsafe_function(env, arguments[0], NULL, Text(env, @"rach3-updates"), 0, 1, NULL, NULL, NULL, Deliver, &notify) != napi_ok)
        return Nothing(env);
    napi_unref_threadsafe_function(env, notify);
    controller = [UpdateController new];
    controller.onChange = ^(NSDictionary *event) {
        napi_call_threadsafe_function(notify, (void *)CFBridgingRetain(Json(event)), napi_tsfn_nonblocking);
    };
    return Nothing(env);
}

static napi_value Snapshot(napi_env env, napi_callback_info info) { (void)info; return Text(env, controller ? Json([controller snapshot]) : @"null"); }
static napi_value Start(napi_env env, napi_callback_info info) { (void)info; [controller start]; return Nothing(env); }
static napi_value Check(napi_env env, napi_callback_info info) { (void)info; [controller check:nil]; return Nothing(env); }
static napi_value Acknowledge(napi_env env, napi_callback_info info) { (void)info; [controller acknowledge]; return Nothing(env); }
static napi_value Stop(napi_env env, napi_callback_info info) { (void)info; [controller stop]; return Nothing(env); }

NAPI_MODULE_INIT() {
    struct { const char *name; napi_callback function; } methods[] = {
        {"create", Create}, {"snapshot", Snapshot}, {"start", Start}, {"check", Check}, {"acknowledge", Acknowledge}, {"stop", Stop},
    };
    for (size_t i = 0; i < sizeof methods / sizeof *methods; i++) {
        napi_value function;
        napi_create_function(env, methods[i].name, NAPI_AUTO_LENGTH, methods[i].function, NULL, &function);
        napi_set_named_property(env, exports, methods[i].name, function);
    }
    return exports;
}
