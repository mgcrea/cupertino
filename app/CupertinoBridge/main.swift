// cupertino-bridge — what an MCP host actually spawns.
//
// ## Why this exists
//
// macOS attributes access to a process's *responsible process*. When Claude
// spawns an MCP server directly, that is Claude (or VS Code, or Terminal), so
// the server can only read Mail if the whole editor is granted Full Disk
// Access. `native/launcher.c` escaped that with the private
// `responsibility_spawnattrs_setdisclaim` SPI.
//
// This takes the other route. The Cupertino app is a normal signed .app, so it
// is already its own responsible process, and — measured in
// scripts/spike-app-tcc — so is everything it spawns, two levels deep. The
// privileged work therefore happens over there.
//
// What is left here is a relay: bytes from stdin to a unix socket and back.
// **It never opens a protected path**, which is the whole point — its own TCC
// identity is irrelevant, so no SPI is needed to give it a good one.
//
// stdout is the JSON-RPC channel. Every diagnostic goes to stderr.

import Foundation

let stderrHandle = FileHandle.standardError

func warn(_ message: String) {
  stderrHandle.write(Data("[cupertino-bridge] \(message)\n".utf8))
}

func die(_ message: String, code: Int32 = 1) -> Never {
  warn(message)
  exit(code)
}

// MARK: - Which server

// A NAME from a closed set, never a path. `native/launcher.c` refused to run
// what it was told because a launcher that does is a way for any local process
// to read the whole disk with a permission granted for mail. The app validates
// this against its own table too; this check is here so a typo fails fast.
let known = ["mail", "notes"]

var requested: String?
for argument in CommandLine.arguments.dropFirst() {
  if argument.hasPrefix("--server=") {
    requested = String(argument.dropFirst("--server=".count))
  }
}
guard let server = requested else {
  die("usage: cupertino-bridge --server=<\(known.joined(separator: "|"))>", code: 2)
}
guard known.contains(server) else {
  die("unknown server '\(server)'; expected one of \(known.joined(separator: ", "))", code: 2)
}

// MARK: - Connect, launching the app if it is not up yet

let path = BridgeProtocol.socketPath
guard let address = unixAddress(path) else {
  die("socket path is too long for a unix address (\(path.utf8.count) bytes): \(path)")
}

func connectOnce() -> Int32? {
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else { return nil }
  let rc = address.withSockaddr { pointer, length in connect(fd, pointer, length) }
  if rc == 0 { return fd }
  close(fd)
  return nil
}

/// Ask LaunchServices to start Cupertino, then wait for it to listen.
///
/// `-g` keeps it from stealing focus: this runs while someone is typing at an
/// AI assistant, not while they are looking at the screen.
func launchApp() {
  let open = Process()
  open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
  open.arguments = ["-g", "-b", "io.mgcrea.cupertino"]
  do { try open.run(); open.waitUntilExit() } catch {
    warn("could not launch Cupertino: \(error.localizedDescription)")
  }
}

var socketFD: Int32! = connectOnce()
if socketFD == nil {
  warn("Cupertino is not running; launching it")
  launchApp()
  // Cold start of a signed app is well under a second; ten is for a machine
  // that is busy, or a first launch that has to clear Gatekeeper.
  let deadline = Date().addingTimeInterval(10)
  while socketFD == nil, Date() < deadline {
    usleep(150_000)
    socketFD = connectOnce()
  }
}
guard let sock = socketFD else {
  die("""
    could not reach Cupertino at \(path).
    Open Cupertino once from /Applications, then retry.
    """)
}

// MARK: - Handshake

func writeAll(_ fd: Int32, _ bytes: [UInt8]) -> Bool {
  var offset = 0
  while offset < bytes.count {
    let written = bytes.withUnsafeBufferPointer {
      write(fd, $0.baseAddress! + offset, bytes.count - offset)
    }
    if written <= 0 {
      if errno == EINTR { continue }
      return false
    }
    offset += written
  }
  return true
}

guard writeAll(sock, Array(BridgeProtocol.handshake(server: server).utf8)) else {
  die("handshake write failed: \(String(cString: strerror(errno)))")
}

// Read the status line one byte at a time. It is a few dozen bytes, and
// buffering here would risk swallowing JSON-RPC that follows it.
var statusLine = ""
while true {
  var byte: UInt8 = 0
  let n = read(sock, &byte, 1)
  if n == 0 { die("Cupertino closed the connection during the handshake") }
  if n < 0 {
    if errno == EINTR { continue }
    die("handshake read failed: \(String(cString: strerror(errno)))")
  }
  if byte == UInt8(ascii: "\n") { break }
  statusLine.append(Character(UnicodeScalar(byte)))
  if statusLine.count > 512 { die("handshake reply was not a line") }
}

if statusLine != BridgeProtocol.ok {
  let detail = statusLine.hasPrefix(BridgeProtocol.errorPrefix)
    ? String(statusLine.dropFirst(BridgeProtocol.errorPrefix.count))
    : statusLine
  die("Cupertino refused the connection: \(detail)")
}

// MARK: - Pump

// Two directions, two threads, blocking reads. The process exits when either
// side reaches EOF, which is what an MCP host expects when it closes stdin.
let group = DispatchGroup()

func pump(from source: Int32, to sink: Int32, label: String) {
  DispatchQueue.global(qos: .userInitiated).async(group: group) {
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      let n = buffer.withUnsafeMutableBufferPointer { read(source, $0.baseAddress, $0.count) }
      if n < 0 {
        if errno == EINTR { continue }
        warn("\(label): read failed: \(String(cString: strerror(errno)))")
        break
      }
      if n == 0 { break }  // EOF
      if !writeAll(sink, Array(buffer[0..<n])) {
        warn("\(label): write failed: \(String(cString: strerror(errno)))")
        break
      }
    }
    // Half-close so the far end sees EOF rather than hanging.
    shutdown(sink, SHUT_WR)
  }
}

pump(from: STDIN_FILENO, to: sock, label: "stdin->app")
pump(from: sock, to: STDOUT_FILENO, label: "app->stdout")

group.wait()
close(sock)
exit(0)
