// Virtual Office installer (Setup.exe) and uninstaller (the same program, copied into the office folder as Uninstall.exe).
// Built by app/build-installer.js with the C# compiler that ships with Windows; the office files and Node.js travel
// inside it as payload.zip. Installs for the current user only (no admin rights): %LOCALAPPDATA%\VirtualOffice\app.
//   Setup.exe       unpack the office, then run app\setup.js (screensaver, shortcuts, Windows app list), start it
//   Uninstall.exe   (or Setup.exe /uninstall) run app\uninstall.js, then delete the office folder
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Threading;
using System.Windows.Forms;

static class Setup
{
    const string Title = "Virtual Office";
    static readonly string AppDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VirtualOffice", "app");
    static string NodeExe { get { return Path.Combine(AppDir, "node", "node.exe"); } }

    [STAThread]
    static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        bool uninstall = Array.Exists(args, a => a.Equals("/uninstall", StringComparison.OrdinalIgnoreCase))
            || Path.GetFileNameWithoutExtension(Application.ExecutablePath).Equals("Uninstall", StringComparison.OrdinalIgnoreCase);
        // /silent: no windows; the outcome goes to %TEMP%\VirtualOfficeSetup.log. Options: /screensaver /startup /nostart,
        // and for uninstalling /remove-settings
        bool silent = Has(args, "/silent");
        if (uninstall) return silent ? UninstallQuietly(Has(args, "/remove-settings")) : Uninstall();
        if (silent)
        {
            string logFile = Path.Combine(Path.GetTempPath(), "VirtualOfficeSetup.log");
            using (StreamWriter w = new StreamWriter(logFile, false))
                return Install(Has(args, "/screensaver"), Has(args, "/startup"), Has(args, "/nostart"), line => w.WriteLine(line)) ? 0 : 1;
        }
        Application.Run(new InstallForm());
        return 0;
    }
    static bool Has(string[] args, string flag) { return Array.Exists(args, a => a.Equals(flag, StringComparison.OrdinalIgnoreCase)); }

    // The install itself, shared by the window and /silent
    static bool Install(bool useSaver, bool atStartup, bool noStart, Action<string> say)
    {
        try
        {
            if (Directory.Exists(AppDir))
            {
                say("Stopping the office and replacing the old version (your settings and skills are kept)…");
                StopOffice();
                DeleteWithRetry(AppDir);
            }
            say("Unpacking the office and Node.js…");
            Directory.CreateDirectory(AppDir);
            using (Stream s = typeof(Setup).Assembly.GetManifestResourceStream("payload.zip"))
            using (ZipArchive zip = new ZipArchive(s, ZipArchiveMode.Read))
                zip.ExtractToDirectory(AppDir);
            File.Copy(Application.ExecutablePath, Path.Combine(AppDir, "Uninstall.exe"), true);
            say("Setting up…");
            int code = RunNode(Path.Combine("app", "setup.js"), (useSaver ? "--screensaver " : "") + (atStartup ? "--startup " : "") + (noStart ? "--no-start" : ""), say);
            say(code == 0 ? Environment.NewLine + "Done. The office is opening; on a first install it starts with its Setup page." : "Setup stopped with an error (code " + code + ").");
            return code == 0;
        }
        catch (Exception ex) { say("Could not install: " + ex.Message); return false; }
    }

    // ---------- Shared helpers ----------
    // Runs node with a script from the office folder and passes each line it prints to onLine
    static int RunNode(string script, string args, Action<string> onLine)
    {
        ProcessStartInfo si = new ProcessStartInfo(NodeExe, "\"" + Path.Combine(AppDir, script) + "\" " + args);
        si.WorkingDirectory = AppDir;
        si.UseShellExecute = false; si.CreateNoWindow = true;
        si.RedirectStandardOutput = true; si.RedirectStandardError = true;
        using (Process p = Process.Start(si))
        {
            p.OutputDataReceived += (s, e) => { if (e.Data != null) onLine(e.Data); };
            p.ErrorDataReceived += (s, e) => { if (e.Data != null) onLine(e.Data); };
            p.BeginOutputReadLine(); p.BeginErrorReadLine();
            p.WaitForExit();
            return p.ExitCode;
        }
    }

    // Asks a running office server to stop (it may be running from this folder, which is about to be replaced)
    static void StopOffice()
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:4321/shutdown");
            req.Method = "POST"; req.Headers.Add("X-Office", "stop"); req.Timeout = 1500; req.ContentLength = 0;
            using (req.GetResponse()) { }
            Thread.Sleep(800);
        }
        catch { }
    }

    // ---------- Install ----------
    class InstallForm : Form
    {
        CheckBox saver = new CheckBox(), startup = new CheckBox();
        Button go = new Button();
        TextBox log = new TextBox();
        Label intro = new Label();

        public InstallForm()
        {
            Text = Title + " Setup";
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            ClientSize = new Size(560, 400); FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Segoe UI", 9.5f);

            Label head = new Label { Text = Title, Font = new Font("Segoe UI Semibold", 16f), ForeColor = Color.FromArgb(22, 128, 61), AutoSize = true, Location = new Point(20, 16) };
            intro.Text = "A pixel office that comes alive while Claude Code, Codex, claude.ai and ChatGPT work on your requests.\n" +
                "Installs for you only, into " + AppDir + ". After installing, the office opens its Setup page, where you name your office and team and install their skills.";
            intro.Location = new Point(22, 54); intro.Size = new Size(516, 74);

            saver.Text = "Use the office as my screensaver (it locks the screen when I come back)";
            saver.Checked = true; saver.Location = new Point(22, 132); saver.AutoSize = true;
            startup.Text = "Start the office in the background when I sign in to Windows";
            startup.Checked = true; startup.Location = new Point(22, 158); startup.AutoSize = true;

            log.Multiline = true; log.ReadOnly = true; log.ScrollBars = ScrollBars.Vertical;
            log.Location = new Point(22, 190); log.Size = new Size(516, 150); log.BackColor = Color.White;

            go.Text = Directory.Exists(AppDir) ? "Update" : "Install";
            go.Location = new Point(438, 352); go.Size = new Size(100, 32);
            go.Click += (s, e) => { if (go.Tag as string == "done") Close(); else Start(); };
            AcceptButton = go;
            Controls.AddRange(new Control[] { head, intro, saver, startup, log, go });
        }

        void Say(string line)
        {
            if (InvokeRequired) { BeginInvoke(new Action<string>(Say), line); return; }
            log.AppendText(line + Environment.NewLine);
        }

        void Start()
        {
            go.Enabled = false; saver.Enabled = false; startup.Enabled = false;
            bool useSaver = saver.Checked, atStartup = startup.Checked;
            new Thread(() =>
            {
                bool ok = Install(useSaver, atStartup, false, Say);
                BeginInvoke(new Action(() => { go.Text = ok ? "Close" : "Retry"; go.Tag = ok ? "done" : null; go.Enabled = true; }));
            }) { IsBackground = true }.Start();
        }
    }

    // A just-stopped server can hold its files for a moment
    static void DeleteWithRetry(string dir)
    {
        for (int i = 0; ; i++)
        {
            try { Directory.Delete(dir, true); return; }
            catch { if (i >= 10) throw; Thread.Sleep(500); }
        }
    }

    // ---------- Uninstall ----------
    static int Uninstall()
    {
        if (MessageBox.Show("Uninstall " + Title + "?\n\nThis removes the office, its shortcuts, its Claude Code and Codex hooks, and the skills the office installed. Your own skills are kept.",
            Title, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return 0;
        DialogResult keep = MessageBox.Show("Keep your office settings and edited skills, in case you install it again?",
            Title, MessageBoxButtons.YesNo, MessageBoxIcon.Question);
        string output = RemoveAll(keep == DialogResult.No);
        MessageBox.Show(Title + " was uninstalled.\n\n" + output + "\nThe Chrome extension, if you added it, can be removed at chrome://extensions.", Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
        return 0;
    }
    static int UninstallQuietly(bool removeSettings)
    {
        File.WriteAllText(Path.Combine(Path.GetTempPath(), "VirtualOfficeUninstall.log"), RemoveAll(removeSettings));
        return 0;
    }
    static string RemoveAll(bool removeSettings)
    {
        string output = "";
        if (File.Exists(NodeExe))
            RunNode(Path.Combine("app", "uninstall.js"), removeSettings ? "--remove-settings" : "", line => output += line + "\n");
        // This program runs from the folder it deletes: hand that to a short command that waits for it to close
        string parent = Path.GetDirectoryName(AppDir);
        Process.Start(new ProcessStartInfo("cmd.exe", "/c ping -n 3 127.0.0.1 >nul & rmdir /s /q \"" + AppDir + "\" & rmdir \"" + parent + "\"")
            { CreateNoWindow = true, UseShellExecute = false });
        return output;
    }
}
