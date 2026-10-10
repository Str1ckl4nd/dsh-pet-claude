// fgwatch (dsh-pet-claude) — tells the host which program is in front, and nothing else.
//
// Event-driven: registers for EVENT_SYSTEM_FOREGROUND and sleeps in a message
// loop, so it costs nothing between window switches. Prints the foreground
// process's name once at start and again only when it changes.
//
// Exits when its parent (the pet's host process, pid in argv[0]) exits, or when
// the pipe it writes to breaks — it never outlives the pet.
//
// Built on first use by src/host/claude-sessions.ts into ~/.dsh/dsh-pet/ with
// the C# compiler that ships with Windows (.NET Framework 4.x, csc.exe) —
// nothing is downloaded.

using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

static class FgWatch
{
    delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

    [DllImport("user32.dll")]
    static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc proc, uint pid, uint tid, uint flags);

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

    [DllImport("user32.dll")]
    static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

    const uint EVENT_SYSTEM_FOREGROUND = 3;
    const uint WINEVENT_OUTOFCONTEXT = 0;

    // Held in a static so the GC never collects the callback the OS calls.
    static WinEventProc callback;
    static string last;

    static void Report(IntPtr hwnd)
    {
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        string name = "";
        try { name = Process.GetProcessById((int)pid).ProcessName; } catch { }
        if (name == last) return;
        last = name;
        try
        {
            Console.Out.WriteLine(name);
            Console.Out.Flush();
        }
        catch
        {
            Environment.Exit(0); // the reader is gone
        }
    }

    static void Main(string[] args)
    {
        int parent;
        if (args.Length > 0 && int.TryParse(args[0], out parent))
        {
            var watcher = new Thread(() =>
            {
                try { Process.GetProcessById(parent).WaitForExit(); } catch { }
                Environment.Exit(0);
            });
            watcher.IsBackground = true;
            watcher.Start();
        }

        callback = (hook, ev, hwnd, idObject, idChild, thread, time) => Report(hwnd);
        SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, callback, 0, 0, WINEVENT_OUTOFCONTEXT);
        Report(GetForegroundWindow());

        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
    }
}
