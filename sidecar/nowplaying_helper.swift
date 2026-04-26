// nowplaying_helper.swift
//
// Long-lived stdin-driven helper that reads macOS's private MediaRemote
// framework (where Djay Pro publishes Now Playing info) and prints one
// JSON object per line on stdout, in response to single-character commands
// on stdin:
//
//   "p\n"  -> poll once, emit one JSON line
//   "q\n"  -> quit
//
// Output shape (fields may be null):
//   {"title":"...","artist":"...","album":"...","durationSec":210.5,
//    "elapsedSec":45.2,"timestamp":1714065613.2,"playbackRate":1.0,
//    "contentItemId":"abc","artworkB64":"...","artworkMime":"image/jpeg"}
// Or, when nothing is playing:
//   {"empty":true}
//
// Build:
//   swiftc -O nowplaying_helper.swift -o nowplaying_helper
//
// macOS only. Uses private SPI; not for App Store distribution.

import Foundation
import CoreFoundation

// ---------------------------------------------------------------------------
// MediaRemote SPI binding
// ---------------------------------------------------------------------------

typealias MRMediaRemoteGetNowPlayingInfoFunction = @convention(c) (
    DispatchQueue,
    @escaping ([String: Any]) -> Void
) -> Void

let bundleURL = URL(fileURLWithPath:
    "/System/Library/PrivateFrameworks/MediaRemote.framework")

guard let bundle = CFBundleCreate(kCFAllocatorDefault, bundleURL as CFURL) else {
    FileHandle.standardError.write(Data(
        "[helper] failed to load MediaRemote.framework\n".utf8))
    exit(2)
}

guard let getNowPlayingInfoPtr = CFBundleGetFunctionPointerForName(
    bundle, "MRMediaRemoteGetNowPlayingInfo" as CFString)
else {
    FileHandle.standardError.write(Data(
        "[helper] MRMediaRemoteGetNowPlayingInfo not found\n".utf8))
    exit(2)
}

let MRMediaRemoteGetNowPlayingInfo = unsafeBitCast(
    getNowPlayingInfoPtr,
    to: MRMediaRemoteGetNowPlayingInfoFunction.self)

// MediaRemote callbacks are reliable on the main queue (delivered via the
// main RunLoop); custom dispatch queues sometimes never receive them under
// XPC backpressure. The stdin thread asks the main thread to do the poll.
let mainQueue = DispatchQueue.main

// ---------------------------------------------------------------------------
// JSON helpers — minimal hand-rolled writer so we never blow up on weird types.
// ---------------------------------------------------------------------------

func jsonEscape(_ s: String) -> String {
    var out = ""
    out.reserveCapacity(s.count + 2)
    out.append("\"")
    for c in s.unicodeScalars {
        switch c {
        case "\"": out.append("\\\"")
        case "\\": out.append("\\\\")
        case "\n": out.append("\\n")
        case "\r": out.append("\\r")
        case "\t": out.append("\\t")
        case "\u{08}": out.append("\\b")
        case "\u{0C}": out.append("\\f")
        default:
            if c.value < 0x20 {
                out.append(String(format: "\\u%04x", c.value))
            } else {
                out.append(Character(c))
            }
        }
    }
    out.append("\"")
    return out
}

func jsonValue(_ v: Any?) -> String {
    guard let v = v else { return "null" }
    if let s = v as? String { return jsonEscape(s) }
    if let b = v as? Bool { return b ? "true" : "false" }
    if let n = v as? Double {
        if n.isNaN || n.isInfinite { return "null" }
        return String(n)
    }
    if let n = v as? Int { return String(n) }
    return "null"
}

func emitLine(_ pairs: [(String, Any?)]) {
    var parts: [String] = []
    parts.reserveCapacity(pairs.count)
    for (k, v) in pairs {
        parts.append(jsonEscape(k) + ":" + jsonValue(v))
    }
    let line = "{" + parts.joined(separator: ",") + "}\n"
    FileHandle.standardOutput.write(Data(line.utf8))
}

func emitEmpty() {
    FileHandle.standardOutput.write(Data("{\"empty\":true}\n".utf8))
}

// ---------------------------------------------------------------------------
// Poll once, synchronous from caller's POV (uses semaphore to bridge async cb).
// ---------------------------------------------------------------------------

// Holder so we can mutate from a closure dispatched on the main queue.
// Synchronization is provided by DispatchSemaphore at the call site.
final class PollResult: @unchecked Sendable {
    var info: [String: Any] = [:]
    var responded: Bool = false
}

func pollOnce() {
    let sem = DispatchSemaphore(value: 0)
    let result = PollResult()

    // Dispatch the MediaRemote call onto the main queue. The framework
    // delivers callbacks via the main run loop, which `RunLoop.main.run()`
    // below keeps spinning, so the closure reliably fires.
    mainQueue.async {
        MRMediaRemoteGetNowPlayingInfo(mainQueue) { info in
            result.info = info
            result.responded = true
            sem.signal()
        }
    }

    let waitResult = sem.wait(timeout: .now() + .seconds(1))
    let captured = result.info
    if waitResult == .timedOut || !result.responded || captured.isEmpty {
        emitEmpty()
        return
    }

    let title  = captured["kMRMediaRemoteNowPlayingInfoTitle"]  as? String
    let artist = captured["kMRMediaRemoteNowPlayingInfoArtist"] as? String
    let album  = captured["kMRMediaRemoteNowPlayingInfoAlbum"]  as? String

    // If we have neither title nor artist, treat as empty.
    if (title == nil || title!.isEmpty) && (artist == nil || artist!.isEmpty) {
        emitEmpty()
        return
    }

    let duration = (captured["kMRMediaRemoteNowPlayingInfoDuration"] as? NSNumber)?
        .doubleValue
    let elapsed  = (captured["kMRMediaRemoteNowPlayingInfoElapsedTime"] as? NSNumber)?
        .doubleValue
    let rate     = (captured["kMRMediaRemoteNowPlayingInfoPlaybackRate"] as? NSNumber)?
        .doubleValue
    let contentItemId =
        (captured["kMRMediaRemoteNowPlayingInfoContentItemIdentifier"] as? String)
        ?? (captured["kMRMediaRemoteNowPlayingInfoUniqueIdentifier"] as? NSNumber)
            .map { String($0.int64Value) }

    // Anchor for the elapsed time. MediaRemote provides this as a Date in
    // kMRMediaRemoteNowPlayingInfoTimestamp; fall back to "now" if missing.
    var timestamp: Double = Date().timeIntervalSince1970
    if let ts = captured["kMRMediaRemoteNowPlayingInfoTimestamp"] as? Date {
        timestamp = ts.timeIntervalSince1970
    }

    var artworkB64: String? = nil
    var artworkMime: String? = nil
    if let data = captured["kMRMediaRemoteNowPlayingInfoArtworkData"] as? Data {
        artworkB64 = data.base64EncodedString()
        artworkMime = (captured["kMRMediaRemoteNowPlayingInfoArtworkMIMEType"]
                       as? String) ?? "image/jpeg"
    }

    emitLine([
        ("title",         title),
        ("artist",        artist),
        ("album",         album),
        ("durationSec",   duration),
        ("elapsedSec",    elapsed),
        ("timestamp",     timestamp),
        ("playbackRate",  rate),
        ("contentItemId", contentItemId),
        ("artworkB64",    artworkB64),
        ("artworkMime",   artworkMime),
    ])
}

// ---------------------------------------------------------------------------
// stdin-driven loop. We read on a background thread so the main thread is
// free to run a CFRunLoop (some MediaRemote callbacks have historically
// needed one). On each "p" we synchronously poll; on "q" or EOF we exit.
// ---------------------------------------------------------------------------

let stdinThread = Thread {
    let stdin = FileHandle.standardInput
    var buffer = Data()
    while true {
        let chunk = stdin.availableData
        if chunk.isEmpty {
            // EOF — parent went away.
            DispatchQueue.main.async { exit(0) }
            return
        }
        buffer.append(chunk)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer.subdata(in: 0..<nl)
            buffer.removeSubrange(0...nl)
            guard let line = String(data: lineData, encoding: .utf8) else { continue }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed == "p" {
                pollOnce()
            } else if trimmed == "q" {
                DispatchQueue.main.async { exit(0) }
                return
            }
            // Unknown commands: ignore.
        }
    }
}
stdinThread.stackSize = 512 * 1024
stdinThread.start()

// Park main thread on the run loop so async callbacks (and DispatchQueue.main
// dispatches like our exit) can fire.
RunLoop.main.run()
