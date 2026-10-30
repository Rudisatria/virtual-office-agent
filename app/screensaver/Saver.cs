// Virtual Office screensaver (.scr). Built by app/build-screensaver.js with the C# compiler that ships with Windows.
// /s: shows the office full screen on the biggest monitor (Chrome kiosk window) and blacks out every other monitor.
//     The mouse does nothing: an invisible shield over the office catches clicks, and movement is ignored.
//     Any key press closes it; with "On resume, display logon screen" on, Windows then locks.
// /p: preview in the Settings dialog (nothing shown). /c or no argument: about box.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

static class Saver
{
    const string Title = "Virtual Office";
    const string Url = "http://127.0.0.1:4321/";

    // ---------- Keyboard only: a key press ends the screensaver, the mouse is ignored ----------
    delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int idHook, HookProc fn, IntPtr hMod, uint threadId);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    const int WH_KEYBOARD_LL = 13, WM_KEYDOWN = 0x100, WM_SYSKEYDOWN = 0x104;
    static HookProc keyboardProc;               // kept in a field so it isn't garbage-collected while hooked
    static IntPtr keyboardHook = IntPtr.Zero;
    static volatile bool keyPressed;
    static DateTime keysArmedAt;                // keys still held from starting the screensaver are ignored until then

    static void HookKeyboard()
    {
        keyboardProc = delegate (int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0 && (wParam == (IntPtr)WM_KEYDOWN || wParam == (IntPtr)WM_SYSKEYDOWN))
            {
                if (DateTime.Now >= keysArmedAt) keyPressed = true;
                return (IntPtr)1;               // swallow it: the key never reaches the office page
            }
            return CallNextHookEx(keyboardHook, nCode, wParam, lParam);
        };
        keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyboardProc, GetModuleHandle(null), 0);
    }

    // Backup check that works even if the window code is stuck: is any keyboard key down right now?
    static bool AnyKeyDown()
    {
        for (int vk = 8; vk < 255; vk++)
        {
            if (vk == 0x01 || vk == 0x02 || vk == 0x04 || vk == 0x05 || vk == 0x06) continue; // mouse buttons
            if ((GetAsyncKeyState(vk) & 0x8000) != 0) return true;
        }
        return false;
    }

    // An almost invisible window over the office that catches every click and scroll, so the mouse can't use the page
    static Form MouseShield(Screen s)
    {
        Form f = new Form();
        f.FormBorderStyle = FormBorderStyle.None;
        f.StartPosition = FormStartPosition.Manual;
        f.Bounds = s.Bounds;
        f.BackColor = Color.Black;
        f.Opacity = 0.01;
        f.TopMost = true;
        f.ShowInTaskbar = false;
        f.Show();
        return f;
    }

    static bool OfficeUp()
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(Url);
            req.Timeout = 1500;
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse()) return res.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }

    // The office folder is two levels up from this file (claude-office\app\screensaver\...scr or claude-office\app\...scr)
    static string OfficeRoot()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        for (int i = 0; i < 3 && dir != null; i++)
        {
            if (File.Exists(Path.Combine(dir, "server.js"))) return dir;
            dir = Path.GetDirectoryName(dir.TrimEnd('\\'));
        }
        return null;
    }

    static string Find(params string[] paths)
    {
        foreach (string p in paths) if (!string.IsNullOrEmpty(p) && File.Exists(p)) return p;
        return null;
    }

    static string Data()
    {
        string d = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClaudeOffice");
        Directory.CreateDirectory(d);
        return d;
    }

    static void StartServer()
    {
        if (OfficeUp()) return;
        string root = OfficeRoot();
        // the installer's own copy of Node first (node\node.exe in the office folder), else a system-wide Node
        string node = Find(Path.Combine(root ?? "", "node\\node.exe"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs\\node.exe"));
        if (root == null || node == null) return;
        ProcessStartInfo si = new ProcessStartInfo(node, "server.js");
        si.WorkingDirectory = root;
        si.UseShellExecute = false;
        si.CreateNoWindow = true;
        Process.Start(si);
        for (int i = 0; i < 40 && !OfficeUp(); i++) Thread.Sleep(250);
    }

    static string profileDir;

    static void Log(string msg)
    {
        try { File.AppendAllText(Path.Combine(Data(), "screensaver.log"), DateTime.Now.ToString("HH:mm:ss.fff") + " " + msg + Environment.NewLine); } catch { }
    }

    static void KillChrome()
    {
        // Only the Chrome windows using the screensaver's own profile, never your normal Chrome
        try
        {
            using (ManagementObjectSearcher s = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'chrome.exe'"))
                foreach (ManagementObject p in s.Get())
                {
                    string cmd = p["CommandLine"] as string;
                    if (cmd != null && cmd.IndexOf(profileDir, StringComparison.OrdinalIgnoreCase) >= 0)
                        try { Process.GetProcessById(Convert.ToInt32(p["ProcessId"])).Kill(); } catch { }
                }
        }
        catch { }
    }

    static Form Blackout(Screen s, bool topMost)
    {
        Form f = new Form();
        f.FormBorderStyle = FormBorderStyle.None;
        f.StartPosition = FormStartPosition.Manual;
        f.Bounds = s.Bounds;
        f.BackColor = Color.Black;
        f.TopMost = topMost;
        f.ShowInTaskbar = false;
        f.Cursor = Cursors.Default;
        f.Show();
        return f;
    }

    // ---------- Screen layout: the office on the biggest monitor, every other monitor black ----------
    static string chromePath;
    static Process browser;
    static Form mainCover;
    static readonly System.Collections.Generic.List<Form> covers = new System.Collections.Generic.List<Form>();
    static int coverDownAt = 20;   // timer tick at which the office's black cover steps back so Chrome shows

    static void Layout()
    {
        Screen main = Screen.PrimaryScreen;
        foreach (Screen s in Screen.AllScreens) if (s.Bounds.Width * s.Bounds.Height > main.Bounds.Width * main.Bounds.Height) main = s;
        // Black out every screen at once, so nothing on the desktop shows while the office (re)loads
        foreach (Form f in covers) { try { f.Close(); } catch { } }
        covers.Clear();
        mainCover = Blackout(main, true); covers.Add(mainCover);
        foreach (Screen s in Screen.AllScreens) if (s.DeviceName != main.DeviceName) covers.Add(Blackout(s, true));
        Application.DoEvents();
        // (Re)open the office full screen on that monitor
        try { if (browser != null && !browser.HasExited) browser.Kill(); } catch { }
        KillChrome();
        browser = null;
        if (chromePath != null && OfficeUp())
        {
            string chromeArgs = "--kiosk --app=" + Url + "?full --user-data-dir=\"" + profileDir + "\"" +
                " --window-position=" + main.Bounds.X + "," + main.Bounds.Y +
                " --no-first-run --no-default-browser-check --noerrdialogs --disable-session-crashed-bubble --hide-crash-restore-bubble" +
                " --disable-features=Translate,CalculateNativeWinOcclusion"; // keep animating under the mouse shield
            browser = Process.Start(chromePath, chromeArgs);
        }
        covers.Add(MouseShield(main));
        Log("office on " + main.DeviceName + " (" + main.Bounds.Width + "x" + main.Bounds.Height + "), " + covers.Count + " screen(s)");
    }

    [STAThread]
    static int Main(string[] args)
    {
        string a = args.Length > 0 ? args[0].ToLowerInvariant().Trim() : "/c";
        if (a.StartsWith("/p")) return 0;
        bool test = a.StartsWith("/t"); // test run: same as /s, but also closes by itself after 12 seconds
        if (!a.StartsWith("/s") && !test)
        {
            MessageBox.Show("Shows your virtual office while you're away.\n\nTurn on \"On resume, display logon screen\" in the screen saver settings so the screen locks when anyone touches the mouse or keyboard.", Title);
            return 0;
        }

        Application.EnableVisualStyles();
        Cursor.Hide();
        StartServer();
        profileDir = Path.Combine(Data(), "screensaver");
        chromePath = Find(
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google\\Chrome\\Application\\chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google\\Chrome\\Application\\chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google\\Chrome\\Application\\chrome.exe"));
        Layout();

        // Monitors changed (laptop lid closed or opened, a screen plugged in or out): Windows moves our black covers
        // onto the remaining screens, which would hide the office. Lay everything out again shortly after.
        int ticks = 0, relayoutAt = -1;
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged += delegate { relayoutAt = ticks + 8; };

        // Keys: ignore anything still held from starting it (for 1.5 s), then any key press ends it
        keysArmedAt = DateTime.Now.AddMilliseconds(1500);
        HookKeyboard();

        // Safety guard on its own thread: on any key press, force the screensaver to exit within 2 seconds even if
        // the window code is stuck, so Windows always goes on to lock the screen
        Thread guard = new Thread(delegate ()
        {
            Thread.Sleep(1600);
            while (!keyPressed && !AnyKeyDown()) Thread.Sleep(100);
            Thread.Sleep(2000);
            Log("guard: forcing exit");
            try { Process b = browser; if (b != null && !b.HasExited) b.Kill(); } catch { }
            Environment.Exit(0);
        });
        guard.IsBackground = true;
        guard.Start();

        System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
        t.Interval = 200;
        Log("started (" + (test ? "test" : "screensaver") + "), chrome " + (browser != null ? "opened" : "not opened"));
        t.Tick += delegate
        {
            try
            {
                ticks++;
                if (ticks == relayoutAt) { Log("screens changed, laying out again"); Layout(); coverDownAt = ticks + 12; }
                if (ticks == coverDownAt && browser != null && mainCover != null) { mainCover.TopMost = false; mainCover.SendToBack(); } // let the office show on top
                bool input = keyPressed;
                if (input || (test && ticks >= 60))
                {
                    t.Stop();
                    Log(input ? "key pressed, closing" : "test time is up, closing");
                    if (keyboardHook != IntPtr.Zero) UnhookWindowsHookEx(keyboardHook);
                    try { if (browser != null && !browser.HasExited) browser.Kill(); } catch { } // fast path first
                    KillChrome();
                    Application.Exit();
                }
            }
            catch (Exception e) { Log("error: " + e); t.Stop(); KillChrome(); Application.Exit(); }
        };
        t.Start();
        Application.Run();
        KillChrome();
        Log("closed");
        return 0;
    }
}
