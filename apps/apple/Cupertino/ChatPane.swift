import SwiftUI

/// Talk to the on-device model with one surface's MCP tools loaded.
///
/// The point of this pane is to make a tool call something you can *try*. Every
/// other screen in the app describes the servers — what they expose, whether
/// they are running, what a client asked for. Nothing exercised them, so the
/// only way to see Cupertino work was to install an editor, wire it, and ask it
/// a question. Here you ask, and every call the model makes appears inline with
/// the arguments it invented.
///
/// The calls are real. They go over the same socket `cupertino-bridge` uses, to
/// the same supervised child, under the same write gate — see `MCPChatClient`
/// for why that route was chosen over spawning a private server. They appear in
/// the Log and in Connections like anybody else's.
///
/// A pane rather than a window: `MainView.Pane` already carries the sidebar and
/// the `@AppStorage` selection, so this costs four small edits there and no
/// window plumbing at all.
struct ChatPane: View {
  /// Owned by `MainView`, not by this struct.
  ///
  /// The pane is one arm of a `switch`, so a trip to the Log and back would
  /// otherwise destroy it — taking the transcript, the tool selection, a live
  /// `LanguageModelSession` and the MCP connection underneath it.
  let chat: ChatConversation

  /// The one piece of state that genuinely belongs to the view: a popover that
  /// survived navigation would be a popover with no anchor.
  @State private var showingTools = false

  /// Which surface the picker offers.
  ///
  /// Enabled surfaces only. A switched-off one is refused at the handshake with
  /// a sentence about turning it back on, which is a fine sentence to read
  /// after a mistake and a poor one to reach by picking the row the app just
  /// offered you.
  private var picks: [Surface] { Surface.all.filter { SurfaceSettings.isEnabled($0) } }

  var body: some View {
    Group {
      if !ChatConversation.isAvailable {
        unavailable
      } else {
        // Three views rather than one, and this is a performance fix rather
        // than tidying. `@Observable` registers dependencies per *body*, so a
        // single body reading `chat.messages` would re-run the surface picker,
        // the budget arithmetic and every banner on each streamed token. Only
        // `TranscriptList` reads the messages.
        TranscriptList(chat: chat)
      }
    }
    .safeAreaInset(edge: .top) {
      ChatHeader(chat: chat, picks: picks, showingTools: $showingTools)
    }
    .safeAreaInset(edge: .bottom, spacing: 0) { ChatComposer(chat: chat) }
    // Hang up when the pane goes away, keeping the transcript. Nothing else
    // closes this connection — `deinit` is not a place to put it, because
    // `MainView` holds the object across pane switches — and without it the
    // node child for the last surface picked stays resident for the life of the
    // app.
    .onDisappear { chat.close() }
    // The staged driver reaches this pane by relaunching onto it, so the
    // fixture is applied on appearance rather than by anything being clicked.
    .onAppear { if DemoSeed.isEnabled { DemoSeed.chatSession(chat) } }
    .confirmationDialog(
      "Switch to \(chat.pendingSwitch?.displayName ?? "")?",
      isPresented: Binding(
        get: { chat.pendingSwitch != nil }, set: { if !$0 { chat.pendingSwitch = nil } }),
      titleVisibility: .visible
    ) {
      Button("Switch and start over") {
        if let pick = chat.pendingSwitch { chat.load(pick) }
        chat.pendingSwitch = nil
      }
      Button("Cancel", role: .cancel) { chat.pendingSwitch = nil }
    } message: {
      Text(
        "A conversation is tied to the tools it was started with, so changing surface ends this "
          + "one. Nothing on your Mac is affected.")
    }
  }

  private var unavailable: some View {
    VStack(spacing: 8) {
      Image(systemName: "sparkles.slash").font(.largeTitle).foregroundStyle(.tertiary)
      Text("The on-device model is not available").font(.headline)
      // No `fixedSize` on this sentence: it replaces the whole detail pane, and
      // `LogPane.disclaimer` documents what that costs in a split view — a
      // wrapping caption that answers its height only once given a width makes
      // the detail column resolve against the unwrapped sentence, and the
      // result is a blank window rather than a wide one.
      Text(
        ChatConversation.unavailableReason
          + " Everything else in Cupertino works without it — this pane is the only thing that "
          + "needs it."
      )
      .font(.caption).foregroundStyle(.secondary)
      .multilineTextAlignment(.center)
      .frame(maxWidth: 380)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

// MARK: - Header

/// The picker, the budget and the banners. Reads everything about the
/// conversation except its messages.
private struct ChatHeader: View {
  let chat: ChatConversation
  let picks: [Surface]
  @Binding var showingTools: Bool

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Picker("Surface", selection: surfaceBinding) {
          Text("Choose a surface…").tag(String?.none)
          ForEach(picks) { surface in
            Text(surface.displayName).tag(String?.some(surface.id))
          }
        }
        .labelsHidden()
        .frame(maxWidth: 200)

        if chat.isLoading { ProgressView().controlSize(.small) }

        Spacer(minLength: 0)

        if chat.isReady {
          Button {
            showingTools = true
          } label: {
            // The budget, always on screen. It is the constraint the whole pane
            // is shaped by, and hiding it behind a disclosure would make every
            // "why didn't it use tool X" question unanswerable at a glance.
            HStack(spacing: 6) {
              Text("\(chat.selected.count) of \(chat.tools.count) tools")
              Text(
                "\(chat.used.formatted(.number.grouping(.never)))/"
                  + "\(ChatConversation.budget.formatted(.number.grouping(.never)))"
              )
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(chat.isOverBudget ? .orange : .secondary)
            }
          }
          .popover(isPresented: $showingTools, arrowEdge: .bottom) { ToolPicker(chat: chat) }

          Button("Clear") { chat.clear() }
            .disabled(!chat.hasTranscript || chat.isResponding)
        }
      }
      .controlSize(.small)
      .padding(.horizontal, 12).padding(.vertical, 8)

      // One banner at a time, most urgent first. Two stacked banners in a pane
      // this size is most of the pane.
      if let failure = chat.loadFailure {
        banner(failure, tint: .red, symbol: "xmark.circle.fill")
      } else if let gone = chat.disconnected {
        banner(gone, tint: .orange, symbol: "bolt.horizontal.circle.fill")
      } else if chat.allowsWrites, !chat.acknowledgedWrites, chat.isReady {
        writesBanner
      } else if chat.trims > 0 {
        banner(
          "The conversation outgrew the model's \(ChatConversation.contextSize)-token window, so "
            + "the earliest \(chat.trims == 1 ? "exchange was" : "\(chat.trims) exchanges were") "
            + "dropped. Anything said there has been forgotten.",
          tint: .orange, symbol: "scissors")
      }

      Divider()
    }
    .background(.bar)
  }

  /// The one gate the pane holds on its own.
  ///
  /// Writes are a per-surface setting and this pane honours it, so with writes
  /// on the model really can delete a note or send a message. Naming the
  /// surface rather than saying "writes are enabled" is the difference between
  /// a warning somebody reads and one they dismiss.
  private var writesBanner: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
      // No `fixedSize` in this column — see `ChatPane.unavailable`.
      Text(
        "\(chat.surface?.displayName ?? "This surface") has writes enabled, so the tools loaded "
          + "here can change your data. The model decides which to call and what to pass it."
      )
      .font(.caption)
      Spacer(minLength: 8)
      Button("I understand") { chat.acknowledgedWrites = true }
        .controlSize(.small)
    }
    .padding(.horizontal, 12).padding(.vertical, 6)
  }

  private func banner(_ text: String, tint: Color, symbol: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: symbol).foregroundStyle(tint)
      Text(text).font(.caption).foregroundStyle(.secondary)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12).padding(.vertical, 6)
  }

  private var surfaceBinding: Binding<String?> {
    Binding(
      get: { chat.surface?.id },
      set: { id in
        guard let id, let pick = picks.first(where: { $0.id == id }) else { return }
        // Only worth a dialog when there is something to lose.
        if chat.hasTranscript {
          chat.pendingSwitch = pick
        } else {
          chat.load(pick)
        }
      })
  }
}

// MARK: - Tools

private struct ToolPicker: View {
  let chat: ChatConversation

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Tools loaded into the conversation").font(.headline)
      ProgressView(
        value: Double(min(chat.used, ChatConversation.budget)),
        total: Double(ChatConversation.budget)
      )
      .tint(chat.isOverBudget ? .orange : .accentColor)
      Text(
        "The model holds \(ChatConversation.contextSize) tokens in total — instructions, tools, "
          + "the conversation and its reply. Every tool spends part of that budget for the whole "
          + "conversation, so this is a choice about what to make reachable, not a preference."
      )
      .font(.caption).foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)

      Divider()

      ScrollView {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(chat.tools) { tool in
            Toggle(
              isOn: Binding(
                get: { chat.selected.contains(tool.name) }, set: { _ in chat.toggle(tool) })
            ) {
              HStack(spacing: 6) {
                Text(tool.name).font(.system(.caption, design: .monospaced))
                // The one mark the server makes about itself. Shown rather than
                // trusted: `packages/core/src/facade.ts` classifies writes by
                // running the registrar twice precisely because thirteen
                // mutating tools ship with no hint at all.
                if tool.readOnlyHint != true {
                  Image(systemName: "pencil").font(.caption2).foregroundStyle(.orange)
                }
                Spacer(minLength: 8)
                Text("\(ChatBudget.cost(of: tool))")
                  .font(.system(.caption2, design: .monospaced)).foregroundStyle(.tertiary)
              }
            }
            .toggleStyle(.checkbox)
          }
        }
      }
      .frame(height: 240)
      // Changing the selection rebuilds the session, which discards the
      // conversation a reply is still being written into. `ChatConversation`
      // refuses too — that is the invariant, this is the explanation of it.
      .disabled(chat.isResponding)
      .help(
        chat.isResponding
          ? "Finish or stop the reply first — changing the tools starts a new conversation." : "")

      if !chat.unusable.isEmpty {
        Divider()
        DisclosureGroup("\(chat.unusable.count) not offered") {
          VStack(alignment: .leading, spacing: 2) {
            ForEach(chat.unusable, id: \.self) { line in
              Text("• \(line)")
                .font(.caption2).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
          }
          .padding(.top, 3)
        }
        .font(.caption)
      }
    }
    .padding(12)
    .frame(width: 420)
  }
}

// MARK: - Transcript

/// The only view that reads `chat.messages`, and therefore the only one a
/// streamed token invalidates.
private struct TranscriptList: View {
  let chat: ChatConversation

  private static let tailAnchor = "chat-tail"

  var body: some View {
    ScrollViewReader { proxy in
      List {
        if chat.messages.isEmpty {
          placeholder
        } else {
          ForEach(chat.messages) { message in
            MessageRow(message: message)
              .listRowSeparator(.hidden)
          }
        }
        // A dedicated anchor rather than the last message: the last message
        // grows while it streams, and scrolling to a moving target lands
        // somewhere different every time.
        Color.clear.frame(height: 1).id(Self.tailAnchor).listRowSeparator(.hidden)
      }
      .listStyle(.plain)
      .textSelection(.enabled)
      .onChange(of: chat.messages.last?.text) {
        // No animation while a reply streams: at ten pulses a second, each
        // moving the tail a few points, an animation per pulse is a queue of
        // animations that never lands.
        proxy.scrollTo(Self.tailAnchor, anchor: .bottom)
      }
      .onChange(of: chat.messages.count) {
        withAnimation(.linear(duration: 0.12)) { proxy.scrollTo(Self.tailAnchor, anchor: .bottom) }
      }
    }
  }

  @ViewBuilder
  private var placeholder: some View {
    VStack(alignment: .leading, spacing: 6) {
      if chat.isReady {
        Text("Ask something that needs one of the loaded tools.")
          .font(.callout).foregroundStyle(.secondary)
        Text(
          "Every call runs against the real \(chat.surface?.displayName ?? "surface") data on "
            + "this Mac, through the same connection an editor would use, and shows up in the "
            + "Log pane too. It works without a licence — what a licence buys is letting other "
            + "apps in."
        )
        .font(.caption).foregroundStyle(.tertiary)
        .fixedSize(horizontal: false, vertical: true)
      } else {
        Text("Choose a surface to load its tools.")
          .font(.callout).foregroundStyle(.secondary)
      }
    }
    .listRowSeparator(.hidden)
    .padding(.vertical, 6)
  }
}

/// One turn.
///
/// The calls are drawn ABOVE the prose, deliberately. They are the evidence;
/// the prose is a small model's account of them, and when the two disagree the
/// evidence is the part worth reading first.
private struct MessageRow: View {
  let message: ChatConversation.Message

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(message.role == .you ? "You" : "On-device model")
        .font(.caption2).foregroundStyle(.tertiary)

      ForEach(message.calls) { call in CallRow(call: call) }

      if !message.text.isEmpty {
        Text(message.text).font(.callout)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
      }

      if let failure = message.failure {
        Label(failure, systemImage: "exclamationmark.triangle.fill")
          .font(.caption).foregroundStyle(.orange)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.vertical, 4)
  }
}

/// One tool call, with the arguments the model invented.
///
/// The arguments are shown verbatim rather than pretty-printed from a parse:
/// the whole value of showing them is that they are what was actually sent.
private struct CallRow: View {
  let call: ChatCall
  @State private var expanded = false

  private var duration: String {
    call.seconds < 1
      ? "\(Int(call.seconds * 1000))ms"
      : "\(call.seconds.formatted(.number.precision(.fractionLength(1))))s"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        Image(systemName: call.failed ? "xmark.circle.fill" : "checkmark.circle.fill")
          .foregroundStyle(call.failed ? .red : .green)
        Text(call.tool).font(.system(.caption, design: .monospaced))
        Spacer(minLength: 8)
        Text(duration).font(.caption2).foregroundStyle(.tertiary)
      }
      Text(call.arguments)
        .font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      if !call.output.isEmpty {
        Text(expanded || call.output.count <= 240 ? call.output : String(call.output.prefix(240)))
          .font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        if call.output.count > 240, !expanded {
          Button("Show all \(call.output.count) characters") { expanded = true }
            .buttonStyle(.link).font(.caption2)
        }
      }
    }
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.quaternary.opacity(0.35), in: .rect(cornerRadius: 6))
  }
}

// MARK: - Composer

private struct ChatComposer: View {
  @Bindable var chat: ChatConversation

  var body: some View {
    VStack(spacing: 0) {
      Divider()
      HStack(alignment: .bottom, spacing: 8) {
        // The box is what stops the composer reading as text falling off the
        // bottom of the window: `.plain` draws no border of its own, and in dark
        // mode `.bar` over the transcript is the same colour as the transcript.
        // Same fill and corner as the tool-call blocks above, one step up in
        // radius for a control rather than a readout.
        TextField(prompt, text: $chat.draft, axis: .vertical)
          .textFieldStyle(.plain)
          .lineLimit(1...6)
          .disabled(!chat.canSend)
          // No `.onSubmit`, deliberately. An AppKit key equivalent is consulted
          // before the responder chain, so the button's `.defaultAction` below
          // sends on plain Return; Shift-Return does not match it, falls
          // through to the field, and inserts a newline — which is the
          // multiline behaviour `axis: .vertical` was asking for. Binding
          // Return here as well would swallow it first and take that away.
          //
          // 6, with `.controlSize(.large)` on the button: that pairing is what
          // makes the two the same height, so they share a top and bottom edge
          // rather than only meeting at the baseline.
          .padding(.horizontal, 10).padding(.vertical, 6)
          .background(.quaternary.opacity(0.35), in: .rect(cornerRadius: 8))
          .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary, lineWidth: 1))

        // One control that swaps role rather than two that take turns
        // appearing: the button is the composer's anchor, and a Stop that
        // arrives somewhere else is a Stop you have to look for.
        // Named, because a call can block for a minute and a spinner that does
        // not say what it is waiting on is indistinguishable from a hang.
        if let tool = chat.activeTool {
          HStack(spacing: 6) {
            ProgressView().controlSize(.small)
            Text(tool)
              .font(.system(.caption2, design: .monospaced))
              .foregroundStyle(.secondary)
              .lineLimit(1)
              .truncationMode(.middle)
              .frame(maxWidth: 180, alignment: .leading)
          }
          .help("Waiting on this tool. Cupertino gives a call a minute before giving up.")
        }

        Button(chat.isResponding ? "Stop" : "Send") {
          if chat.isResponding { chat.stop() } else { chat.submit() }
        }
        .controlSize(.large)
        .keyboardShortcut(chat.isResponding ? .cancelAction : .defaultAction)
        .disabled(
          chat.isResponding
            ? false
            : (!chat.canSend
              || chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
      }
      .padding(.horizontal, 12).padding(.vertical, 8)
    }
    .background(.bar)
  }

  /// The placeholder carries the reason sending is refused, because a disabled
  /// field with a generic prompt is indistinguishable from a broken one.
  private var prompt: String {
    if chat.disconnected != nil { return "The connection ended" }
    if !chat.isReady { return "Choose a surface first" }
    if chat.allowsWrites && !chat.acknowledgedWrites { return "Acknowledge the notice above" }
    return "Ask something…"
  }
}
