import CryptoKit
import Foundation

// Verify against the public key embedded in the app, including on a fresh CI runner.
let arguments = CommandLine.arguments
let key = try Curve25519.Signing.PublicKey(rawRepresentation: Data(base64Encoded: arguments[1])!)
let signature = Data(base64Encoded: arguments[2])!
let archive = try Data(contentsOf: URL(fileURLWithPath: arguments[3]), options: .mappedIfSafe)
if !key.isValidSignature(signature, for: archive) {
    FileHandle.standardError.write(Data("Update signature does not match the application's public key.\n".utf8))
    exit(1)
}
