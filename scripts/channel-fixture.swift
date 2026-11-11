import AppKit
import SwiftUI

/// The app `make channel-check` drives through its `SupportKitDriving` channel.
///
/// Compiled together with swift-support-kit's `Sources/SupportKitDriving` and
/// `-DDEBUG`, and bundled as `CupertinoChannelFixture.app` so that
/// `apple_desktop_launch` can start it by bundle identifier. Every count it
/// keeps is a label with an accessibility identifier, so the check reads the
/// effect of each command through Accessibility, as an agent would.
///
/// `stallButton` blocks the main thread for 3 s, which is how the check makes
/// an ack arrive late.

final class Counts: ObservableObject {
  @Published var swiftTaps = 0
}

struct Panel: View {
  @ObservedObject var counts: Counts
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Button("SwiftUI button") { counts.swiftTaps += 1 }
          .accessibilityIdentifier("swiftButton")
        Text("\(counts.swiftTaps)").accessibilityIdentifier("swiftTaps")
      }
      Button("Stall") { Thread.sleep(forTimeInterval: 3) }
        .accessibilityIdentifier("stallButton")
    }
    .padding(8)
  }
}

@MainActor
final class Fixture: NSObject, NSApplicationDelegate {
  let counts = Counts()
  var window: NSWindow!
  let nsField = NSTextField(frame: NSRect(x: 10, y: 160, width: 340, height: 24))
  let nsButton = NSButton(frame: NSRect(x: 10, y: 120, width: 160, height: 30))
  let nsTaps = NSTextField(labelWithString: "0")
  var driving: Driving?

  func applicationDidFinishLaunching(_ note: Notification) {
    // A bare NSApplication has no main menu, and a shortcut is matched against it.
    let main = NSMenu()
    let editItem = NSMenuItem()
    let edit = NSMenu(title: "Edit")
    edit.addItem(
      NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
    editItem.submenu = edit
    main.addItem(editItem)
    NSApp.mainMenu = main

    let screen = NSScreen.main!.visibleFrame
    window = NSWindow(
      contentRect: NSRect(x: screen.maxX - 380, y: screen.minY + 20, width: 360, height: 200),
      styleMask: [.titled], backing: .buffered, defer: false)
    window.title = "channel fixture"
    window.isReleasedWhenClosed = false
    let content = window.contentView!

    nsField.identifier = NSUserInterfaceItemIdentifier("nsField")
    content.addSubview(nsField)
    nsButton.title = "AppKit button"
    nsButton.bezelStyle = .push
    nsButton.target = self
    nsButton.action = #selector(tapped)
    nsButton.identifier = NSUserInterfaceItemIdentifier("nsButton")
    content.addSubview(nsButton)
    nsTaps.frame = NSRect(x: 180, y: 126, width: 60, height: 20)
    nsTaps.identifier = NSUserInterfaceItemIdentifier("nsTaps")
    content.addSubview(nsTaps)

    let hosting = NSHostingView(rootView: Panel(counts: counts))
    hosting.frame = NSRect(x: 10, y: 10, width: 340, height: 100)
    content.addSubview(hosting)

    window.orderFrontRegardless()
    driving = Driving.startIfRequested()
  }

  @objc func tapped() { nsTaps.stringValue = "\(Int(nsTaps.stringValue)! + 1)" }
}

@main
enum ChannelFixtureMain {
  @MainActor static func main() {
    let delegate = Fixture()
    NSApplication.shared.setActivationPolicy(.regular)
    NSApplication.shared.delegate = delegate
    NSApplication.shared.run()
  }
}
