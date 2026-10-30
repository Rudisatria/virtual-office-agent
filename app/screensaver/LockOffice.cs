// "Show office and lock": starts the Windows screensaver right now (the Virtual Office screensaver),
// so the office shows on the big monitor and the screen is already locked: any touch goes to the lock screen.
// Windows itself starts the screensaver, so its "On resume, display logon screen" setting applies.
// Built by app/build-screensaver.js. If no secure screensaver is set up, it simply locks the screen.
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32;

static class LockOffice
{
    [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool LockWorkStation();
    const uint WM_SYSCOMMAND = 0x0112;
    const int SC_SCREENSAVE = 0xF140;

    static int Main()
    {
        string saver = null, secure = null;
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Control Panel\Desktop"))
        {
            if (k != null) { saver = k.GetValue("SCRNSAVE.EXE") as string; secure = k.GetValue("ScreenSaverIsSecure") as string; }
        }
        // Without a screensaver that locks on resume, starting it would leave the desktop one touch away: lock instead
        if (string.IsNullOrEmpty(saver) || secure != "1") { LockWorkStation(); return 0; }
        SendMessage(GetDesktopWindow(), WM_SYSCOMMAND, (IntPtr)SC_SCREENSAVE, IntPtr.Zero);
        return 0;
    }
}
