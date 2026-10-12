// fgwatch (dsh-pet-claude, macOS) — tells the host which app is in front, and nothing else.
//
// The macOS counterpart of fgwatch.cs. Event-driven: listens for the workspace's
// "app activated" notification and sleeps in the run loop, so it costs nothing
// between app switches. Prints the frontmost app's executable name once at
// start and again only when it changes.
//
// Exits when its parent (the pet's host process, pid in argv[1]) exits, or when
// the pipe it writes to breaks — it never outlives the pet.
//
// Built on first use by src/host/claude-sessions.ts into ~/.dsh/dsh-pet/ with
// swiftc from the Xcode Command Line Tools; without them the pet still works,
// it just cannot tell that you came back to a session.

import AppKit

signal(SIGPIPE, SIG_IGN)
var last: String?

func report(_ app: NSRunningApplication?) {
    let name = app?.executableURL?.lastPathComponent ?? app?.localizedName ?? ""
    if name == last { return }
    last = name
    if fputs(name + "\n", stdout) < 0 || fflush(stdout) != 0 { exit(0) } // the reader is gone
}

if CommandLine.arguments.count > 1, let parent = Int32(CommandLine.arguments[1]), parent > 0 {
    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
        if kill(parent, 0) != 0 && errno == ESRCH { exit(0) }
    }
}

NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { note in
    report(note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
}
report(NSWorkspace.shared.frontmostApplication)
RunLoop.main.run()
