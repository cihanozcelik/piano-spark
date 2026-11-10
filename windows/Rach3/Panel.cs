using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Rach3
{
    /// <summary>
    /// The Customize panel (desktop/customize/panel.js, with core.js doing the work) in a web
    /// view of its own beside the page, so a version changed by ChatGPT can't hide it, cover it,
    /// read it or catch its keys. As on the Mac: open, it takes the right side of the window;
    /// closed, only its button shows, at the end of the page's header.
    /// </summary>
    sealed partial class MainForm
    {
        const string PanelUrl = "https://panel." + Host + "/";

        WebView2 panel;
        bool panelOpen;
        double toggleWidth = 110;

        // The panel's own bridge: window.webkit.messageHandlers.native for core.js, and
        // rach3's messages for core.js handed to window.rach3Core.receive, in order.
        const string PanelBridge = @"(() => {
  const webview = window.chrome && window.chrome.webview;
  if (!webview || window.top !== window || location.href !== '" + PanelUrl + @"') return;
  const pending = new Map();
  let next = 1;
  webview.addEventListener('message', ({ data }) => {
    if (data && data.reply !== undefined) {
      const call = pending.get(data.reply);
      if (!call) return;
      pending.delete(data.reply);
      if (data.error != null) call.reject(new Error(data.error)); else call.resolve(data.value);
    } else if (data && data.core) {
      try { window.rach3Core?.receive(data.core); } catch (error) { console.error(error); }
    }
  });
  const native = Object.freeze({
    postMessage(body) {
      return new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        webview.postMessage({ id, body });
      });
    }
  });
  Object.defineProperty(window, 'webkit', { value: Object.freeze({ messageHandlers: Object.freeze({ native }) }) });
  Object.defineProperty(window, 'PianoPlatform', { value: 'windows' });
})();";

        // Closed, the view around the button shows what the page's header would: its colour and its bottom line.
        const string PanelPage = "<!doctype html><html><head><meta charset=\"utf-8\"><style>" +
            "html,body{margin:0;background:#202023;overflow:hidden}" +
            "html::before{content:'';position:fixed;left:0;right:0;top:47px;height:1px;background:#ffffff12}" +
            "</style></head><body><script src=\"core.js\"></script><script src=\"panel.js\"></script></body></html>";

        async Task MakePanel()
        {
            var folder = Path.Combine(paths.Resources, "Customize");
            if (!File.Exists(Path.Combine(folder, "core.js")) || !File.Exists(Path.Combine(folder, "panel.js"))) return;
            var view = new WebView2 { DefaultBackgroundColor = Color.FromArgb(32, 32, 35) };
            panel = view;
            Controls.Add(view);
            view.BringToFront();
            var choices = environment.CreateCoreWebView2ControllerOptions();
            choices.IsInPrivateModeEnabled = true;   // nothing the panel stores outlives it, as on the Mac
            await view.EnsureCoreWebView2Async(environment, choices);
            if (panel != view) return;
            var core = view.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            await core.AddScriptToExecuteOnDocumentCreatedAsync(PanelBridge);
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (sender, args) =>
            {
                Tuple<byte[], string> file = null;
                if (args.Request.Uri == PanelUrl) file = Tuple.Create(Encoding.UTF8.GetBytes(PanelPage), "text/html; charset=utf-8");
                else if (args.Request.Uri == PanelUrl + "core.js" || args.Request.Uri == PanelUrl + "panel.js")
                    file = Tuple.Create(File.ReadAllBytes(Path.Combine(folder, args.Request.Uri.Substring(PanelUrl.Length))), "text/javascript; charset=utf-8");
                args.Response = Answer(core.Environment, file);
            };
            // The panel never leaves its own page; links it opens go to the browser.
            core.NavigationStarting += (sender, args) => { if (args.Uri != PanelUrl) args.Cancel = true; };
            core.NewWindowRequested += (sender, args) => args.Handled = true;
            core.WebMessageReceived += OnPanelMessage;
            core.ProcessFailed += (sender, args) =>
            {
                if (args.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited) return;
                // core.js starts over in a new panel; what it was doing is gone with it.
                panelOpen = false;
                customize.CoreRestarted();
                core.Reload();
                LayoutCustomize();
            };
            view.PreviewKeyDown += OnKey;
            customize.OnCore = message =>
            {
                if (panel?.CoreWebView2 == null) return;
                panel.CoreWebView2.PostWebMessageAsJson("{\"core\":" + Json.Write(message) + "}");
            };
            core.Navigate(PanelUrl);
        }

        async void OnPanelMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            if (args.Source != PanelUrl) return;
            Dictionary<string, object> message;
            try { message = Json.Object(args.WebMessageAsJson); } catch (Exception) { return; }
            if (message == null || !(message.TryGetValue("body", out var raw) && raw is Dictionary<string, object> body)) return;
            var id = message.Number("id");
            object value = null;
            string error = null;
            try { value = await customize.Native(body); }
            catch (NativeError refusal) { error = refusal.Message; }
            catch (Exception failure) when (!(failure is OutOfMemoryException)) { error = "failed"; }
            if (panel?.CoreWebView2 == null) return;
            panel.CoreWebView2.PostWebMessageAsJson("{\"reply\":" + id + ",\"value\":" + Json.Write(value) + ",\"error\":" + Json.Write(error) + "}");
        }

        void ToggleCustomize() => _ = panel?.CoreWebView2?.ExecuteScriptAsync("window.rach3Customize?.toggle();");

        void LayoutCustomize()
        {
            var bounds = ClientRectangle;
            if (bounds.Width <= 0 || bounds.Height <= 0) return;
            var scale = DeviceDpi / 96.0;
            if (panel == null) { web.Bounds = bounds; return; }
            if (panelOpen)
            {
                var width = (int)Math.Round(Math.Min(400, Math.Max(300, bounds.Width / scale - 480)) * scale);
                web.Bounds = new Rectangle(0, 0, bounds.Width - width, bounds.Height);
                panel.Bounds = new Rectangle(bounds.Width - width, 0, width, bounds.Height);
            }
            else
            {
                var button = (int)Math.Round((toggleWidth + 28) * scale);
                web.Bounds = bounds;
                panel.Bounds = new Rectangle(bounds.Width - button, 0, button, (int)Math.Round(48 * scale));
            }
            panel.BringToFront();
            MakeRoomForToggle();
        }

        // Keeps the end of the page's header clear for the button while the panel is closed.
        void MakeRoomForToggle()
        {
            if (!pageReady || panel == null || web.CoreWebView2 == null) return;
            var room = panelOpen ? 0 : toggleWidth + 28;
            _ = PageScript("(() => { const room = " + room.ToString(System.Globalization.CultureInfo.InvariantCulture) + ";" +
                "let style = document.getElementById('rach3-room');" +
                "if (!style) { style = document.createElement('style'); style.id = 'rach3-room'; document.head.appendChild(style); }" +
                "style.textContent = room ? `.app-bar { padding-right: ${room}px !important; }` : ''; })();");
        }

        #region The window menu

        // rach3's own commands, in the window menu (Alt+Space), as the Mac has them in its app menu.
        const int CustomizeCommand = 0x1110, OriginalCommand = 0x1120;

        void AddWindowMenu()
        {
            if (!customize.Available) return;
            GetSystemMenu(Handle, true);   // back to Windows's own items, then rach3's in the current language
            var menu = GetSystemMenu(Handle, false);
            AppendMenu(menu, 0x800, IntPtr.Zero, null);
            AppendMenu(menu, 0, (IntPtr)CustomizeCommand, Localization.Text("rach3’ü değiştir…") + "\tCtrl+K");
            AppendMenu(menu, 0, (IntPtr)OriginalCommand, Localization.Text("Orijinal rach3’ü etkinleştir"));
        }

        protected override void WndProc(ref Message message)
        {
            const int WM_SYSCOMMAND = 0x0112, WM_INPUT = 0x00FF;
            if (message.Msg == WM_SYSCOMMAND)
            {
                var command = (int)((long)message.WParam & 0xFFF0);
                if (command == CustomizeCommand) { ToggleCustomize(); return; }
                if (command == OriginalCommand) { RestoreOriginalDesign(); return; }
            }
            else if (message.Msg == WM_INPUT) NoteInput(message.LParam);
            base.WndProc(ref message);
        }

        [DllImport("user32.dll")]
        static extern IntPtr GetSystemMenu(IntPtr window, bool revert);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern bool AppendMenu(IntPtr menu, uint flags, IntPtr identifier, string text);

        #endregion

        #region A real click or key press on the page

        // When the person last clicked the page or typed in it, with a real mouse or keyboard.
        DateTime pageInput = DateTime.MinValue;
        bool pageFocused;

        /// <summary>
        /// Windows reports every mouse button and key press to rach3's window, the page's too
        /// (WebView2 draws it in another process). Input another program made up has no device.
        /// </summary>
        void WatchInput()
        {
            var devices = new[]
            {
                new RAWINPUTDEVICE { usUsagePage = 1, usUsage = 2, dwFlags = 0x100, hwndTarget = Handle },   // mouse, RIDEV_INPUTSINK
                new RAWINPUTDEVICE { usUsagePage = 1, usUsage = 6, dwFlags = 0x100, hwndTarget = Handle },   // keyboard
            };
            RegisterRawInputDevices(devices, (uint)devices.Length, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)));
        }

        void NoteInput(IntPtr handle)
        {
            uint size = 0;
            var header = (uint)Marshal.SizeOf(typeof(RAWINPUTHEADER));
            GetRawInputData(handle, 0x10000003, IntPtr.Zero, ref size, header);
            if (size == 0) return;
            var buffer = Marshal.AllocHGlobal((int)size);
            try
            {
                if (GetRawInputData(handle, 0x10000003, buffer, ref size, header) != size) return;
                var input = (RAWINPUTHEADER)Marshal.PtrToStructure(buffer, typeof(RAWINPUTHEADER));
#if !PIANO_CAPTURE
                if (input.hDevice == IntPtr.Zero) return;   // made up by a program, not a device
#endif
                if (GetForegroundWindow() != Handle) return;
                var data = buffer + (int)header;
                if (input.dwType == 0)
                {
                    // RI_MOUSE_LEFT_BUTTON_DOWN, after usFlags (2 bytes) and its padding (2 bytes)
                    var buttons = (ushort)Marshal.ReadInt16(data, 4);
                    if ((buttons & 0x0001) == 0) return;
                    var point = PointToClient(Cursor.Position);
                    var overPanel = panel != null && panel.Bounds.Contains(point);
                    var overVideo = videoClip != null && videoClip.Visible && videoClip.Bounds.Contains(point);
                    if (web.Bounds.Contains(point) && !overPanel && !overVideo) pageInput = DateTime.UtcNow;
                }
                else if (input.dwType == 1)
                {
                    // RAWKEYBOARD: MakeCode, Flags (RI_KEY_BREAK = 1 on release)
                    var flags = (ushort)Marshal.ReadInt16(data, 2);
                    if ((flags & 1) == 0 && pageFocused) pageInput = DateTime.UtcNow;
                }
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        [StructLayout(LayoutKind.Sequential)]
        struct RAWINPUTDEVICE { public ushort usUsagePage, usUsage; public uint dwFlags; public IntPtr hwndTarget; }

        [StructLayout(LayoutKind.Sequential)]
        struct RAWINPUTHEADER { public uint dwType, dwSize; public IntPtr hDevice, wParam; }

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] devices, uint count, uint size);

        [DllImport("user32.dll")]
        static extern uint GetRawInputData(IntPtr input, uint command, IntPtr data, ref uint size, uint headerSize);

        [DllImport("user32.dll")]
        static extern IntPtr GetForegroundWindow();

        #endregion
    }
}
