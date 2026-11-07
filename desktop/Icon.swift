import AppKit
let destination = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        let transform = AffineTransform(scale: CGFloat(pixels) / 1024)
        (transform as NSAffineTransform).concat()
        NSColor(srgbRed: 0.12, green: 0.13, blue: 0.16, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 32, y: 32, width: 960, height: 960), xRadius: 210, yRadius: 210).fill()
        NSColor(srgbRed: 0.46, green: 0.65, blue: 1.0, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 160, y: 700, width: 704, height: 32), xRadius: 12, yRadius: 12).fill()
        for key in 0..<7 {
            NSColor(srgbRed: 0.95, green: 0.96, blue: 0.98, alpha: 1).setFill()
            NSBezierPath(roundedRect: NSRect(x: 160 + key * 102, y: 230, width: 92, height: 450), xRadius: 14, yRadius: 14).fill()
        }
        for key in [0, 1, 3, 4, 5] {
            NSColor(srgbRed: 0.10, green: 0.11, blue: 0.14, alpha: 1).setFill()
            NSBezierPath(roundedRect: NSRect(x: 230 + key * 102, y: 420, width: 62, height: 260), xRadius: 10, yRadius: 10).fill()
        }
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 2 ? "@2x" : ""
        let name = "icon_\(size)x\(size)\(suffix).png"
        try bitmap.representation(using: .png, properties: [:])!.write(to: destination.appendingPathComponent(name))
    }
}
