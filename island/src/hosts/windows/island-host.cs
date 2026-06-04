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
// Also handles WM_NCHITTEST to keep the whole window click-through:
// every mouse event passes to the windows underneath.
sealed class IslandForm : Form
{
    const int WM_WINDOWPOSCHANGING = 0x0046;
    const uint SWP_NOZORDER = 0x0004;

    const int WM_NCHITTEST  = 0x0084;
    const int HTTRANSPARENT = -1;
    const int HTCLIENT      = 1;

    // Hittable rectangles in client pixels — set from WebView "hitrects" messages.
    // Only these regions receive clicks; the rest of the window stays click-through.
    public Rectangle[] HitRects = Array.Empty<Rectangle>();

    [StructLayout(LayoutKind.Sequential)]
    struct WINDOWPOS
    {
        public IntPtr hwnd, hwndInsertAfter;
        public int x, y, cx, cy;
        public uint flags;
    }

    public bool StayOnTop { get; set; }
    public bool HitTestEnabled { get; set; }

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
            // Click-through everywhere EXCEPT the reported hit rects (× strip + collapse btn).
            var rects = HitRects;
            if (rects.Length > 0)
            {
                int sx = unchecked((short)(long)m.LParam);
                int sy = unchecked((short)((long)m.LParam >> 16));
                var pt = PointToClient(new Point(sx, sy));
                foreach (var r in rects)
                {
                    if (r.Contains(pt)) { m.Result = (IntPtr)HTCLIENT; return; }
                }
            }
            m.Result = (IntPtr)HTTRANSPARENT;
            return;
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

                // hit rects are consumed locally (for WM_NCHITTEST), not forwarded.
                // Everything else (dismiss, collapseChanged) is forwarded to companion.
                if (msg?["type"]?.GetValue<string>() == "hitrects")
                { UpdateHitRects(msg!); return; }

                var output = new JsonObject { ["type"] = "message" };
                output["data"] = JsonNode.Parse(raw);
                Stdout.Write(output);
            }
            catch { }
        };

        _webView.CoreWebView2.NavigationCompleted += (_, _) => { EmitReady(); };
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
            default:
                Log.Info($"Unknown command: {type}");
                break;
        }
    }


    private void UpdateHitRects(JsonNode msg)
    {
        var arr = msg["rects"]?.AsArray();
        double dpr = msg["dpr"]?.GetValue<double>() ?? 1.0;
        if (arr == null) { Form.HitRects = Array.Empty<Rectangle>(); return; }
        var list = new List<Rectangle>(arr.Count);
        foreach (var r in arr)
        {
            if (r == null) continue;
            int x = (int)Math.Floor((r["x"]?.GetValue<double>() ?? 0) * dpr);
            int y = (int)Math.Floor((r["y"]?.GetValue<double>() ?? 0) * dpr);
            int w = (int)Math.Ceiling((r["w"]?.GetValue<double>() ?? 0) * dpr);
            int h = (int)Math.Ceiling((r["h"]?.GetValue<double>() ?? 0) * dpr);
            list.Add(new Rectangle(x, y, w, h));
        }
        Form.HitRects = list.ToArray();
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
