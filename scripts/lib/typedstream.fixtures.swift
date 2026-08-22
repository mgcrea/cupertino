// Regenerates the blobs pinned in `typedstream.test.mjs`.
//
//     swift scripts/lib/typedstream.fixtures.swift /tmp/out
//
// `NSArchiver` is deprecated and still ships on macOS 26 — and it is what wrote
// every `attributedBody` in `chat.db`. Producing the fixtures through it is what
// makes the test suite ground truth rather than a test of the decoder against
// its own assumptions. Every string here is written here: no fixture carries
// anybody's messages.
import Foundation

let dir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."

func write(_ name: String, _ s: NSAttributedString) {
  let data = NSArchiver.archivedData(withRootObject: s)
  try! data.write(to: URL(fileURLWithPath: dir + "/ts-" + name + ".bin"))
  print("\(name) \(data.count) bytes  \(data.map { String(format: "%02x", $0) }.joined())")
}

write("plain", NSAttributedString(string: "Hello, world"))
// Byte length 36 against 21 UTF-16 units — the length-in-bytes trap.
write("unicode", NSAttributedString(string: "Café ☕️ déjà vu — 日本語"))
// 400 bytes, so the length takes the 0x81 int16 form.
write("long", NSAttributedString(string: String(repeating: "abcdefghij", count: 40)))
write("empty", NSAttributedString(string: ""))
write("newlines", NSAttributedString(string: "line one\nline two\ttabbed"))

// Messages' attachment shape: the object-replacement character carrying a GUID.
let attachment = NSMutableAttributedString(string: "\u{FFFC}")
attachment.addAttribute(
  NSAttributedString.Key("__kIMFileTransferGUIDAttributeName"),
  value: "at_0_ABCDEF12-3456-7890-ABCD-EF1234567890",
  range: NSRange(location: 0, length: 1))
write("attachment", attachment)

// A float-valued attribute between runs — where a parser desynchronises.
let runs = NSMutableAttributedString(string: "before BOLD after")
runs.addAttribute(
  NSAttributedString.Key("NSFontSize"), value: 17.5, range: NSRange(location: 7, length: 4))
runs.addAttribute(
  NSAttributedString.Key("__kIMMessagePartAttributeName"), value: 0,
  range: NSRange(location: 0, length: 17))
write("runs", runs)

let link = NSMutableAttributedString(string: "see https://example.com now")
link.addAttribute(
  NSAttributedString.Key("__kIMLinkAttributeName"), value: "https://example.com",
  range: NSRange(location: 4, length: 19))
write("link", link)

// The shape that broke this decoder on real data: long text carrying MANY
// attribute runs. Both real-world failures had already read their payload and
// then exhausted the walk on the runs after it.
let heavy = NSMutableAttributedString(string: String(repeating: "the quick brown fox ", count: 105))
for i in stride(from: 0, to: heavy.length - 4, by: 4) {
  heavy.addAttribute(
    NSAttributedString.Key("__kIMMessagePartAttributeName"), value: i / 4,
    range: NSRange(location: i, length: 4))
}
write("heavy", heavy)
