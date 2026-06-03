// island-host.cs — Windows native host for claude-island
// --------------------------------------------------------
// WinForms + WebView2 host that speaks stdin/stdout JSON-line protocol.
// Transparency via TransparencyKey trick (magenta = see-through).
//
// Protocol (stdin):  { "type": "html"|"eval"|"close", ... }
// Protocol (stdout): { "type": "ready"|"closed", ... }
//
// Build: dotnet publish -c Release -r win-x64 --self-contained false

using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ClaudeIsland;

static class Stdout
{
    private static readonly object Lock = new();
    public static void Write(JsonObject obj)
    {
        var json = obj.ToJsonString(new JsonSerializerOptions { WriteIndented = false });
        lock (Lock) { Console.Out.WriteLine(json); Console.Out.Flush(); }
    }
}

static class Log
{
    public static void Info(string msg) => Console.Error.WriteLine($"[island-host] {msg}");
}

class Config
{
    public int Width = 640;
    public int Height = 420;
    public string Title = "Claude Island";
    public bool Frameless;
    public bool Floating;
    public bool Transparent;
    public int? X;
    public int? Y;
    public bool ClickThrough;
    public bool NoDock;
    public bool Hidden;

    public static Config Parse(string[] args)
    {
        var c = new Config();
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--width":  if (++i < args.Length && int.TryParse(args[i], out var w)) c.Width = w; break;
                case "--height": if (++i < args.Length && int.TryParse(args[i], out var h)) c.Height = h; break;
                case "--title":  if (++i < args.Length) c.Title = args[i]; break;
                case "--x":      if (++i < args.Length && int.TryParse(args[i], out var x)) c.X = x; break;
                case "--y":      if (++i < args.Length && int.TryParse(args[i], out var y)) c.Y = y; break;
                case "--frameless":     c.Frameless = true; break;
                case "--floating":      c.Floating = true; break;
                case "--transparent":   c.Transparent = true; break;
                case "--click-through": c.ClickThrough = true; break;
                case "--no-dock":       c.NoDock = true; break;
                case "--hidden":        c.Hidden = true; break;
            }
        }
        return c;
    }
}

// Custom Form subclass that intercepts WM_WINDOWPOSCHANGING to prevent
// any other window from pushing this one below TOPMOST level.
// Also handles WM_NCHITTEST for precise click-through: only the focus-button
// area on each row receives mouse events; everything else passes through.
sealed class IslandForm : Form
{
    const int WM_WINDOWPOSCHANGING = 0x0046;
    const uint SWP_NOZORDER = 0x0004;

    const int WM_NCHITTEST  = 0x0084;
    const int WM_LBUTTONDOWN = 0x0201;
    const int HTTRANSPARENT = -1;
    const int HTCLIENT      = 1;

    [StructLayout(LayoutKind.Sequential)]
    struct WINDOWPOS
    {
        public IntPtr hwnd, hwndInsertAfter;
        public int x, y, cx, cy;
        public uint flags;
    }

    public bool StayOnTop { get; set; }
    public bool HitTestEnabled { get; set; }
    public Action<int>? OnButtonRowClick { get; set; }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_WINDOWPOSCHANGING && StayOnTop && m.LParam != IntPtr.Zero)
        {
            var wp = Marshal.PtrToStructure<WINDOWPOS>(m.LParam);
            // Only intercept when the caller intends to change Z-order
            if ((wp.flags & SWP_NOZORDER) == 0)
            {
                wp.hwndInsertAfter = new IntPtr(-1); // HWND_TOPMOST
                Marshal.StructureToPtr(wp, m.LParam, false);
            }
        }

        if (m.Msg == WM_NCHITTEST && HitTestEnabled)
        {
            // Default: pass clicks through to windows below
            m.Result = (IntPtr)HTTRANSPARENT;

            // Calculate which row(s) the cursor is over
            var screenX = (int)(m.LParam.ToInt64() & 0xFFFF);
            var screenY = (int)((m.LParam.ToInt64() >> 16) & 0xFFFF);
            var clientPt = PointToClient(new Point(screenX, screenY));

            int rowCount = Math.Max(1, (ClientSize.Height - 8) / 36);
            for (int i = 0; i < rowCount; i++)
            {
                // Button hit area: generous 64x24px zone at left edge of each row
                var btnRect = new Rectangle(18, 9 + i * 36, 68, 24);
                if (btnRect.Contains(clientPt))
                {
                    m.Result = (IntPtr)HTCLIENT;
                    return;
                }
            }
            return;
        }

        // WM_LBUTTONDOWN: lParam has client coords directly (unlike WM_NCHITTEST)
        if (m.Msg == WM_LBUTTONDOWN && HitTestEnabled)
        {
            var cx = (int)(short)(m.LParam.ToInt64() & 0xFFFF);
            var cy = (int)(short)((m.LParam.ToInt64() >> 16) & 0xFFFF);
            int rowCount = Math.Max(1, (ClientSize.Height - 8) / 36);
            for (int i = 0; i < rowCount; i++)
            {
                if (new Rectangle(18, 9 + i * 36, 68, 24).Contains(cx, cy))
                {
                    OnButtonRowClick?.Invoke(i);
                    return;
                }
            }
        }

        base.WndProc(ref m);
    }
}

sealed class IslandHost : IDisposable
{
    const int GWL_EXSTYLE      = -20;
    const int WS_EX_TRANSPARENT = 0x00000020;
    const int WS_EX_TOOLWINDOW  = 0x00000080;
    const int WS_EX_TOPMOST     = 0x00000008;
    const int WS_EX_NOACTIVATE  = 0x08000000;

    static readonly IntPtr HWND_TOPMOST = new(-1);
    const uint SWP_NOMOVE     = 0x0002;
    const uint SWP_NOSIZE     = 0x0001;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_SHOWWINDOW = 0x0040;

    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int ht, uint f);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out NativePoint cp);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int nCmdShow);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int dwProcessId);
    [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    // Process tree walking via Toolhelp snapshot
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);
    [DllImport("kernel32.dll")] static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
    [DllImport("kernel32.dll")] static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr hObject);

    const uint TH32CS_SNAPPROCESS = 2;
    const int SW_RESTORE = 9;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)] struct NativePoint { public int X; public int Y; }

    const string BridgeJs = """
        window.islandHost = {
            cursorTip: null,
            send: function(data) {
                window.chrome.webview.postMessage(JSON.stringify(data));
            },
            close: function() {
                window.chrome.webview.postMessage(JSON.stringify({__islandHost_close: true}));
            }
        };
        """;

    private readonly Config _config;
    private readonly WebView2 _webView;
    private int _exiting;
    private System.Windows.Forms.Timer? _hoverTimer;
    private bool _isHovered;
    private bool _prevMouseDown;

    public IslandForm Form { get; }

    public IslandHost(Config config)
    {
        _config = config;

        Form = new IslandForm
        {
            StayOnTop = config.Floating,
            HitTestEnabled = config.ClickThrough,
            Text = config.Title,
            Width = config.Width,
            Height = config.Height,
            ShowInTaskbar = false,
            StartPosition = (config.X.HasValue && config.Y.HasValue)
                ? FormStartPosition.Manual
                : FormStartPosition.CenterScreen,
        };

        if (config.Frameless)
            Form.FormBorderStyle = FormBorderStyle.None;

        if (config.Transparent)
        {
            Form.AllowTransparency = true;
            Form.BackColor = Color.Magenta;
            Form.TransparencyKey = Color.Magenta;
        }

        if (config.X.HasValue && config.Y.HasValue)
            Form.Location = new Point(config.X.Value, config.Y.Value);

        if (config.Hidden)
            Form.Opacity = 0;

        _webView = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = config.Transparent ? Color.Transparent : Color.White,
        };
        Form.Controls.Add(_webView);

        Form.Load += async (_, _) => await InitializeAsync();
        Form.HandleCreated += (_, _) => ApplyExtendedStyles();
        Form.Shown += (_, _) =>
        {
            if (config.ClickThrough)
                ShowPassive();
            if (config.Hidden)
            {
                Form.Hide();
                Form.Opacity = 1;
            }
        };
        Form.FormClosing += (_, _) => CloseAndExit();

        _ = Task.Run(ReadStdinAsync);
    }

    private void ApplyExtendedStyles()
    {
        if (!Form.IsHandleCreated) return;
        var style = GetWindowLong(Form.Handle, GWL_EXSTYLE);
        // WM_NCHITTEST in IslandForm handles click-through instead of WS_EX_TRANSPARENT
        if (_config.NoDock) style |= WS_EX_TOOLWINDOW;
        style |= WS_EX_NOACTIVATE;
        SetWindowLong(Form.Handle, GWL_EXSTYLE, style);
        if (_config.Floating)
            SetWindowPos(Form.Handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    private void ShowPassive()
    {
        SetWindowPos(Form.Handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }

    private async Task InitializeAsync()
    {
        try
        {
            var userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "claude-island", "webview2");
            var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
            await _webView.EnsureCoreWebView2Async(env);
        }
        catch (Exception ex)
        {
            Log.Info($"WebView2 init failed: {ex.Message}");
            Log.Info("Install WebView2 Runtime: https://developer.microsoft.com/en-us/microsoft-edge/webview2/");
            CloseAndExit();
            return;
        }

        await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(BridgeJs);
        _webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
        _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
        _webView.CoreWebView2.Settings.IsZoomControlEnabled = false;

        _webView.CoreWebView2.WebMessageReceived += (_, args) =>
        {
            try
            {
                var raw = args.TryGetWebMessageAsString();
                if (raw == null) return;
                var msg = JsonNode.Parse(raw);
                if (msg?["__islandHost_close"]?.GetValue<bool>() == true)
                { CloseAndExit(); return; }

                // Handle focus-session with ppid directly — no round-trip to companion.
                // This avoids Windows foreground lock because SetForegroundWindow is
                // called from the UI thread that just processed the button click.
                if (msg?["type"]?.GetValue<string>() == "focus-session")
                {
                    var ppid = msg["ppid"]?.GetValue<int>() ?? 0;
                    if (ppid > 0) ActivateWindow(ppid);
                }

                var output = new JsonObject { ["type"] = "message" };
                output["data"] = JsonNode.Parse(raw);
                Stdout.Write(output);
            }
            catch { }
        };

        // C# intercepts WM_LBUTTONDOWN for button area; resolve session id via JS
        Form.OnButtonRowClick = (rowIndex) =>
        {
            _prevMouseDown = true; // prevent hover timer from re-triggering the same click
            var js = $"(function(){{var w=document.querySelectorAll('.row-wrap')[{rowIndex}];if(w){{var b=w.querySelector('.focus-btn');if(b&&window.islandHost)window.islandHost.send({{type:'focus-session',id:b.getAttribute('data-id'),ppid:parseInt(b.getAttribute('data-ppid'),10)||0}});}}}})()";
            _ = _webView.CoreWebView2?.ExecuteScriptAsync(js);
        };

        _webView.CoreWebView2.NavigationCompleted += (_, _) => { EmitReady(); StartHoverDetection(); };
        _webView.CoreWebView2.NavigateToString("<html><body></body></html>");
    }

    private async Task ReadStdinAsync()
    {
        try
        {
            string? line;
            while ((line = await Console.In.ReadLineAsync()) != null)
            {
                var trimmed = line.Trim();
                if (string.IsNullOrEmpty(trimmed)) continue;
                try
                {
                    var json = JsonNode.Parse(trimmed);
                    var type = json?["type"]?.GetValue<string>();
                    if (type == null) continue;
                    Form.Invoke(() => HandleCommand(type, json!));
                }
                catch (Exception ex) { Log.Info($"Bad JSON: {trimmed} ({ex.Message})"); }
            }
        }
        catch { }
        try { Form.Invoke(CloseAndExit); } catch { }
        Thread.Sleep(1000);
        Environment.Exit(0);
    }

    private void HandleCommand(string type, JsonNode json)
    {
        switch (type)
        {
            case "html":
            {
                var b64 = json["html"]?.GetValue<string>();
                if (b64 == null) { Log.Info("html: missing payload"); return; }
                try
                {
                    var html = Encoding.UTF8.GetString(Convert.FromBase64String(b64));
                    _webView.CoreWebView2?.NavigateToString(html);
                }
                catch (Exception ex) { Log.Info($"html: {ex.Message}"); }
                break;
            }
            case "eval":
            {
                var js = json["js"]?.GetValue<string>();
                if (js == null) { Log.Info("eval: missing js"); return; }
                _ = _webView.CoreWebView2?.ExecuteScriptAsync(js);
                break;
            }
            case "close":
                CloseAndExit();
                break;
            case "resize":
            {
                var w = json["width"]?.GetValue<int>() ?? 640;
                var h = json["height"]?.GetValue<int>() ?? 60;
                Form.Invoke(() => {
                    // Keep centered horizontally, anchored to top
                    var scr = Screen.FromHandle(Form.Handle) ?? Screen.PrimaryScreen;
                    if (scr != null) {
                        Form.Left = scr.Bounds.Left + (scr.Bounds.Width - w) / 2;
                    }
                    Form.Size = new Size(w, h);
                });
                break;
            }
            case "activate":
            {
                var ppid = json["ppid"]?.GetValue<int>() ?? 0;
                if (ppid <= 0) { Log.Info("activate: missing ppid"); break; }
                ActivateWindow(ppid);
                break;
            }
            default:
                Log.Info($"Unknown command: {type}");
                break;
        }
    }

    private static bool TryGetParentPid(int pid, out int parentPid)
    {
        parentPid = 0;
        var snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1)) return false;
        try
        {
            var pe = new PROCESSENTRY32();
            pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (Process32First(snapshot, ref pe))
            {
                do
                {
                    if (pe.th32ProcessID == pid)
                    {
                        parentPid = (int)pe.th32ParentProcessID;
                        return true;
                    }
                } while (Process32Next(snapshot, ref pe));
            }
        }
        finally { CloseHandle(snapshot); }
        return false;
    }

    private void ActivateWindow(int ppid)
    {
        // Walk process tree up from ppid to find the first process with a visible window.
        //
        // Bypass sequence (Windows foreground lock is strict — needs multiple layers):
        //   1. ShowWindow(SW_RESTORE)       – un-minimize if needed
        //   2. SetWindowPos(HWND_TOPMOST)   – force visual top (always works)
        //   3. SetWindowPos(HWND_NOTOPMOST) – remove topmost flag
        //   4. BringWindowToTop             – bring to top of normal Z-order
        //   5. AllowSetForegroundWindow(-1) – grant foreground rights to anyone
        //   6. keybd_event(ALT DOWN)        – classic trick: system gives foreground
        //      SetForegroundWindow(target)    rights while ALT is "held down"
        //   7. keybd_event(ALT UP)          – release ALT
        //   8. AttachThreadInput fallback   – merge input queues with foreground thread
        int pid = ppid;
        while (pid > 0)
        {
            try
            {
                var proc = System.Diagnostics.Process.GetProcessById(pid);
                if (proc.MainWindowHandle != IntPtr.Zero)
                {
                    var hwnd = proc.MainWindowHandle;

                    // 1. Restore from minimized
                    ShowWindow(hwnd, SW_RESTORE);

                    // 2. Force to top of Z-order visually (works regardless of foreground lock)
                    SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE);
                    SetWindowPos(hwnd, new IntPtr(-2), 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE); // HWND_NOTOPMOST = -2
                    BringWindowToTop(hwnd);

                    // 3. Grant foreground rights
                    AllowSetForegroundWindow(-1);

                    // 4. ALT trick: SetForegroundWindow must happen BETWEEN ALT down and up.
                    //    While ALT is pressed, the system gives the calling thread
                    //    foreground activation permission.
                    keybd_event(0x12, 0, 0, UIntPtr.Zero);       // VK_MENU down
                    var result = SetForegroundWindow(hwnd);       // activate
                    keybd_event(0x12, 0, 2, UIntPtr.Zero);       // VK_MENU up

                    // 5. AttachThreadInput as additional cover
                    var fg = GetForegroundWindow();
                    if (fg != IntPtr.Zero && fg != hwnd)
                    {
                        var fgTid = GetWindowThreadProcessId(fg, IntPtr.Zero);
                        var curTid = GetCurrentThreadId();
                        if (fgTid != 0 && fgTid != curTid)
                        {
                            AttachThreadInput(curTid, fgTid, true);
                            SetForegroundWindow(hwnd);
                            AttachThreadInput(curTid, fgTid, false);
                        }
                    }

                    Log.Info($"activate: {proc.ProcessName} (pid={pid}) hwnd={hwnd} SetForegroundWindow={result} fgHwnd={fg}");
                    return;
                }
            }
            catch (Exception ex)
            {
                Log.Info($"activate: GetProcessById({pid}) failed: {ex.Message}");
            }
            if (!TryGetParentPid(pid, out pid)) break;
        }
        Log.Info($"activate: no windowed process found in tree from ppid={ppid}");
    }

    private void StartHoverDetection()
    {
        if (_hoverTimer != null) return;
        _hoverTimer = new System.Windows.Forms.Timer { Interval = 60 };
        _hoverTimer.Tick += (_, _) =>
        {
            if (!Form.IsHandleCreated) return;
            GetCursorPos(out var cp);
            var b = Form.Bounds;
            var over = cp.X >= b.Left && cp.X < b.Right && cp.Y >= b.Top && cp.Y < b.Bottom;
            if (over != _isHovered)
            {
                _isHovered = over;
                var js = over
                    ? "document.body.classList.add('island-hover')"
                    : "document.body.classList.remove('island-hover')";
                _ = _webView.CoreWebView2?.ExecuteScriptAsync(js);
            }

            // Detect left-click rising edge in button area (bypasses WebView2 message routing)
            // Check both bit15 (currently down) and bit0 (was pressed since last poll) to catch fast clicks
            const int VK_LBUTTON = 0x01;
            bool mouseDown = (GetAsyncKeyState(VK_LBUTTON) & 0x8001) != 0;
            if (over && mouseDown && !_prevMouseDown)
            {
                var clientPt = Form.PointToClient(new Point(cp.X, cp.Y));
                int rowCount = Math.Max(1, (Form.ClientSize.Height - 8) / 36);
                for (int i = 0; i < rowCount; i++)
                {
                    if (new Rectangle(18, 9 + i * 36, 68, 24).Contains(clientPt))
                    {
                        var js2 = string.Format(
                            "(function(){{var w=document.querySelectorAll('.row-wrap')[{0}];if(w){{var b=w.querySelector('.focus-btn');if(b&&window.islandHost)window.islandHost.send({{type:'focus-session',id:b.getAttribute('data-id'),ppid:parseInt(b.getAttribute('data-ppid'),10)||0}});}}}})();",
                            i);
                        _ = _webView.CoreWebView2?.ExecuteScriptAsync(js2);
                        break;
                    }
                }
            }
            // Only update _prevMouseDown when cursor is over the island.
            // If updated while cursor is outside (e.g. user clicking in another app),
            // _prevMouseDown becomes true and the next real button click is missed.
            if (over) _prevMouseDown = mouseDown;
        };
        _hoverTimer.Start();
    }

    private void EmitReady()
    {
        var ready = new JsonObject { ["type"] = "ready" };
        try
        {
            var scr = Screen.PrimaryScreen;
            if (scr != null)
            {
                ready["screen"] = new JsonObject
                {
                    ["width"] = scr.Bounds.Width,
                    ["height"] = scr.Bounds.Height,
                    ["visibleWidth"] = scr.WorkingArea.Width,
                    ["visibleHeight"] = scr.WorkingArea.Height,
                };
            }
        }
        catch { }
        Stdout.Write(ready);
    }

    private void CloseAndExit()
    {
        if (Interlocked.Exchange(ref _exiting, 1) == 1) return;
        try { _hoverTimer?.Stop(); _hoverTimer?.Dispose(); } catch { }
        try { Stdout.Write(new JsonObject { ["type"] = "closed" }); } catch { }
        Environment.Exit(0);
    }

    public void Dispose() => _webView.Dispose();
}

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = Encoding.UTF8;
        ApplicationConfiguration.Initialize();
        var config = Config.Parse(args);
        using var host = new IslandHost(config);
        Application.Run(host.Form);
    }
}
