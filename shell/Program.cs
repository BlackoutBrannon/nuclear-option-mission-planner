using System.Diagnostics;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Mask;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        // Started by a previous MASK to finish installing an update. Runs from
        // a temp copy of this executable, never shows the planner, and exits.
        if (args.Length > 0 && args[0] == "--apply-update")
            return Updater.RunApply(args);

        Updater.SweepHelper();
        Application.Run(new PlannerWindow());
        return 0;
    }
}

internal sealed class PlannerWindow : Form
{
    // MASK: Mission Analysis and Strike Kit. The mark is a threat ring
    // with terrain bitten out of it, which is what masking means here.
    private const string APP_NAME = "MASK - Mission Analysis & Strike Kit";

    // The planner's files are served from a made-up host rather than loaded as
    // file:// URLs. A file:// page is its own opaque origin, so fetch is blocked
    // across it and units.json never loads - the same failure the README warns
    // about when someone double-clicks index.html. Mapping a virtual host makes
    // the app a normal https origin with no server and no port to collide with.
    private const string VirtualHost = "planner.assets";

    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private HostBridge? _bridge;

    // Kept so a second window can share them rather than starting its own
    // browser environment and re-mapping the content folder.
    private CoreWebView2Environment? _env;
    private string? _content;

    // The update notice. A strip across the top of the window rather than a
    // dialog: it says its piece every launch without getting in the way of
    // the map, and it can show download progress in place.
    private readonly Panel _notice = new() { Dock = DockStyle.Top, Height = 40, Visible = false };
    private readonly Label _noticeText = new() { AutoSize = true, ForeColor = Color.White };
    private readonly Button _btnInstall = new() { Text = "Download and install", AutoSize = true };
    private readonly Button _btnNotes = new() { Text = "What changed", AutoSize = true };
    private readonly Button _btnLater = new() { Text = "Not today", AutoSize = true };
    private readonly ProgressBar _progress = new() { Width = 220, Height = 14, Visible = false, Style = ProgressBarStyle.Continuous };
    private Updater.Release? _release;
    private CancellationTokenSource? _updateCts;

    public PlannerWindow()
    {
        Text = APP_NAME;

        // ApplicationIcon in the csproj is what Explorer reads off the file.
        // The taskbar and the title bar read Form.Icon, which defaults to the
        // stock WinForms icon - so without this the app ships a good icon and
        // still shows a generic one everywhere you actually look at it.
        Icon = LoadAppIcon();
        // Matches the app's own background, so a slow WebView2 start shows the
        // right colour rather than a white flash.
        BackColor = Color.FromArgb(11, 14, 18);
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1500, 950);
        MinimumSize = new Size(900, 600);
        WindowState = FormWindowState.Maximized;

        BuildNotice();
        Controls.Add(_notice);
        Controls.Add(_web);
        // Docking is resolved from the back of the z-order forward, so the
        // Fill control has to be in front for the Top strip to take its space
        // off the top rather than being painted over.
        _web.BringToFront();

        Load += async (_, _) => await StartWebView();
        FormClosing += (_, _) => _updateCts?.Cancel();
    }

    private void BuildNotice()
    {
        _notice.BackColor = Color.FromArgb(28, 52, 70);
        _notice.Padding = new Padding(10, 0, 10, 0);

        var row = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            AutoSize = false,
        };
        _noticeText.Margin = new Padding(0, 11, 14, 0);
        foreach (var b in new[] { _btnInstall, _btnNotes, _btnLater })
        {
            b.Margin = new Padding(0, 7, 8, 0);
            b.FlatStyle = FlatStyle.Flat;
            b.ForeColor = Color.White;
            b.FlatAppearance.BorderColor = Color.FromArgb(120, 170, 200);
        }
        _progress.Margin = new Padding(0, 13, 8, 0);

        row.Controls.AddRange(new Control[] { _noticeText, _progress, _btnInstall, _btnNotes, _btnLater });
        _notice.Controls.Add(row);

        _btnNotes.Click += (_, _) => { if (_release is not null) OpenExternally(_release.PageUrl); };
        _btnLater.Click += (_, _) => { Updater.SnoozeUntilTomorrow(); _notice.Visible = false; };
        _btnInstall.Click += async (_, _) => await InstallUpdate();
    }

    private async Task StartWebView()
    {
        var content = ContentRoot();
        if (content is null)
        {
            Fail("Could not find the planner's files.\n\n" +
                 "Expected an 'app' folder next to MASK.exe " +
                 "containing index.html.");
            return;
        }

        try
        {
            // Keep the browser profile beside the user's own data rather than
            // next to the executable, which may sit in Program Files.
            var profile = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "MASK", "WebView2");
            Directory.CreateDirectory(profile);

            // --debug opens the DevTools protocol on 9222 so the page can be
            // inspected from outside the app. Off by default: it is a port
            // anything on the machine could talk to.
            var options = new CoreWebView2EnvironmentOptions();
            if (Environment.GetCommandLineArgs().Contains("--debug"))
            {
                options.AdditionalBrowserArguments = "--remote-debugging-port=9222";
            }

            _env = await CoreWebView2Environment.CreateAsync(null, profile, options);
            _content = content;
            await _web.EnsureCoreWebView2Async(_env);
        }
        catch (Exception ex)
        {
            Fail("The WebView2 runtime could not start.\n\n" +
                 "It ships with Windows 11 and current Windows 10. If this " +
                 "machine is missing it, install the Microsoft Edge WebView2 " +
                 "Runtime and try again.\n\n" + ex.Message);
            return;
        }

        var core = _web.CoreWebView2;

        core.SetVirtualHostNameToFolderMapping(
            VirtualHost, content, CoreWebView2HostResourceAccessKind.Allow);

        // No HTTP cache. Everything on the virtual host is a file on this disk,
        // so caching saves nothing - and the profile persists across launches,
        // which meant an edited script could keep running as its previous
        // self with no sign of it. Run from source that is a debugging trap;
        // after an update it would be a planner half on the old version.
        try
        {
            await core.CallDevToolsProtocolMethodAsync(
                "Network.setCacheDisabled", "{\"cacheDisabled\":true}");
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"could not disable the cache: {ex.Message}");
        }

        // Opening and saving files. Held in a field so it lives as long as the
        // window rather than being collected with its event handler attached.
        _bridge = new HostBridge(core, this);

        // The status bar is a browser affordance that would sit over the map's
        // own readouts. Dev tools stay available: this is a tool for people who
        // may well want to look.
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsSwipeNavigationEnabled = false;

        // target="_blank" on one of the planner's own pages - the symbology
        // sheet - opens a second window inside the app. Sending it to the real
        // browser instead handed it https://planner.assets/..., a hostname that
        // only exists in here, and the browser reported a dead site.
        //
        // Anything genuinely external still leaves, rather than replacing the
        // planner with a page it cannot navigate back from.
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            if (IsAppUri(e.Uri)) ShowSecondWindow(e.Uri);
            else OpenExternally(e.Uri);
        };
        core.NavigationStarting += (_, e) =>
        {
            if (!e.Uri.StartsWith($"https://{VirtualHost}/", StringComparison.OrdinalIgnoreCase)
                && !e.Uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase))
            {
                e.Cancel = true;
                OpenExternally(e.Uri);
            }
        };

        // Without this a failed navigation leaves an empty window and no
        // explanation - the same silent failure the mission loader used to have.
        core.NavigationCompleted += (_, e) =>
        {
            if (e.IsSuccess) return;
            Fail($"The planner failed to load ({e.WebErrorStatus})." +
                 Environment.NewLine + Environment.NewLine +
                 $"Serving from: {content}");
        };

        core.Navigate($"https://{VirtualHost}/index.html");

        // Every launch, after the planner is up so a slow answer never delays
        // it. Not awaited: nothing here depends on the result.
        _ = CheckForUpdate();

        // Asked once, after the planner is on screen rather than in front of a
        // blank window, and never again - "Not now" is remembered as an answer
        // so it does not turn into a prompt on every launch. Dragging a file in
        // never needed a folder, so declining costs nothing.
        if (!MissionFolder.AlreadyAsked())
        {
            // Wrapped because this runs at the tail of an async void event
            // handler, where an exception is swallowed without trace - the
            // prompt would simply never appear and nothing would say why.
            BeginInvoke(() =>
            {
                try
                {
                    var chosen = MissionFolder.Choose(this, firstRun: true);
                    MissionFolder.Save(chosen);
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"mission folder prompt failed: {ex}");
                    MessageBox.Show(this,
                        "Could not ask where your missions are.\n\n" + ex.Message +
                        "\n\nDragging a mission onto the window still works.",
                        Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    MissionFolder.Save(null);   // do not ask again every launch
                }
            });
        }
    }

    // --- updates ---------------------------------------------------------------

    private async Task CheckForUpdate()
    {
        try
        {
            _updateCts = new CancellationTokenSource();
            var r = await Updater.CheckAsync(_updateCts.Token);
            if (r is null || r.Version <= Updater.Current) return;
            _release = r;

            // "Not today" quiets the banner, not the check - so a download that
            // was already staged before the snooze is still offered, because
            // installing it costs no bandwidth and the user already said yes
            // to fetching it.
            var staged = Updater.AlreadyStaged(r.Tag);
            if (staged is null && Updater.SnoozedToday()) return;

            var size = r.AssetSize > 0 ? $" - {r.AssetSize / (1024.0 * 1024.0):0} MB from GitHub" : "";
            if (staged is not null)
            {
                _noticeText.Text = $"MASK {r.Tag} is downloaded and ready to install (you have v{Updater.Current}).";
                _btnInstall.Text = "Install now";
            }
            else
            {
                _noticeText.Text = $"MASK {r.Tag} is available (you have v{Updater.Current}){size}.";
                _btnInstall.Text = Updater.CanSelfInstall && r.AssetUrl is not null
                    ? "Download and install" : "Open release page";
            }
            _notice.Visible = true;
        }
        catch (Exception ex)
        {
            // Never let the update path take the planner down with it.
            Debug.WriteLine($"update check: {ex}");
        }
    }

    private async Task InstallUpdate()
    {
        var r = _release;
        if (r is null) return;

        // Can't replace ourselves here - run from source, in Program Files, or
        // a release with nothing to download. The page is the honest fallback.
        if (!Updater.CanSelfInstall || r.AssetUrl is null)
        {
            OpenExternally(r.PageUrl);
            return;
        }

        try
        {
            var staged = Updater.AlreadyStaged(r.Tag);
            if (staged is null)
            {
                var ok = MessageBox.Show(this,
                    $"Download MASK {r.Tag} and install it?\n\n" +
                    $"From:  github.com/BlackoutBrannon/nuclear-option-mission-planner\n" +
                    $"File:  {r.AssetName} ({r.AssetSize / (1024.0 * 1024.0):0} MB)\n" +
                    $"Into:  {AppContext.BaseDirectory}\n\n" +
                    "When the download has been checked, MASK will ask once more, " +
                    "then close, replace its own files, and reopen. Your plans and " +
                    "settings are not in that folder and are not touched.",
                    "Update MASK", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (ok != DialogResult.Yes) return;

                SetBusy(true);
                var progress = new Progress<(long done, long total)>(p =>
                {
                    if (p.total <= 0) return;
                    _progress.Value = (int)Math.Clamp(p.done * 100 / p.total, 0, 100);
                    _noticeText.Text = $"Downloading MASK {r.Tag}: {p.done / (1024.0 * 1024.0):0} of {p.total / (1024.0 * 1024.0):0} MB";
                });

                var dl = await Updater.DownloadAsync(r, progress, _updateCts?.Token ?? CancellationToken.None);
                _noticeText.Text = $"Unpacking MASK {r.Tag}...";
                staged = await Task.Run(() => Updater.Stage(dl.ZipPath, r.Tag));
                SetBusy(false);

                var verified = dl.ShaVerified
                    ? "The SHA-256 matches the one published with the release."
                    : "This release did not publish a SHA-256, so only the size was checked.";
                var go = MessageBox.Show(this,
                    $"MASK {r.Tag} is downloaded and checked.\n\n" +
                    $"SHA-256:  {dl.Sha256}\n{verified}\n\n" +
                    "Install now? MASK will close and reopen. Anything unsaved in the " +
                    "planner is kept by its autosave.",
                    "Update MASK", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (go != DialogResult.Yes)
                {
                    _noticeText.Text = $"MASK {r.Tag} is downloaded and ready to install.";
                    _btnInstall.Text = "Install now";
                    return;
                }
            }

            Updater.LaunchApply(staged);
            Close();
        }
        catch (OperationCanceledException)
        {
            // Window closing mid-download; nothing to report.
        }
        catch (Exception ex)
        {
            SetBusy(false);
            _noticeText.Text = $"MASK {r.Tag} is available (you have v{Updater.Current}).";
            MessageBox.Show(this,
                "The update could not be installed.\n\n" + ex.Message + "\n\n" +
                "Nothing has been changed. You can try again, or download it from the release page.",
                "Update MASK", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private void SetBusy(bool busy)
    {
        _btnInstall.Enabled = !busy;
        _btnLater.Enabled = !busy;
        _progress.Visible = busy;
        if (!busy) _progress.Value = 0;
    }

    // Packaged, the planner sits in 'app' beside the executable. Run from
    // source, the executable is four levels down in shell/bin/<cfg>/<tfm> and
    // the planner is the folder above all of it - so the same build runs
    // against the working tree without copying 60 MB of tiles first.
    private static string? ContentRoot()
    {
        var packaged = Path.Combine(AppContext.BaseDirectory, "app");
        if (File.Exists(Path.Combine(packaged, "index.html"))) return packaged;

        // Run from source, the planner is somewhere above the build output -
        // but how far up depends on the build. Adding a RuntimeIdentifier to
        // the project inserted a win-x64 folder and moved it from four levels
        // to five, which counting could not survive. So it is searched for
        // rather than counted to.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 8 && dir is not null; i++, dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "index.html");
            if (File.Exists(candidate) &&
                Directory.Exists(Path.Combine(dir.FullName, "src")))
            {
                return dir.FullName;
            }
        }

        return null;
    }

    private bool IsAppUri(string uri) =>
        uri.StartsWith($"https://{VirtualHost}/", StringComparison.OrdinalIgnoreCase);

    // A plain second window on the same content. It shares the environment and
    // repeats the host mapping, so the page it shows can fetch the same files
    // the main window can.
    private async void ShowSecondWindow(string uri)
    {
        if (_env is null || _content is null) return;

        var web = new WebView2 { Dock = DockStyle.Fill };
        var form = new Form
        {
            Text = Text,
            Icon = Icon,
            BackColor = BackColor,
            StartPosition = FormStartPosition.CenterParent,
            ClientSize = new Size(1100, 800),
        };
        form.Controls.Add(web);
        form.Show(this);

        try
        {
            await web.EnsureCoreWebView2Async(_env);
            web.CoreWebView2.SetVirtualHostNameToFolderMapping(
                VirtualHost, _content, CoreWebView2HostResourceAccessKind.Allow);
            web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            // Links out of this window behave like links out of the main one.
            web.CoreWebView2.NewWindowRequested += (_, e) =>
            {
                e.Handled = true;
                if (IsAppUri(e.Uri)) ShowSecondWindow(e.Uri);
                else OpenExternally(e.Uri);
            };
            web.CoreWebView2.Navigate(uri);
        }
        catch (Exception ex)
        {
            form.Close();
            MessageBox.Show(this, "Could not open that page.\n\n" + ex.Message,
                            Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    // The icon is embedded in the executable by ApplicationIcon, so it is read
    // back from there rather than shipped a second time as a loose file that
    // could go missing or drift out of step with the one Explorer shows.
    private static Icon? LoadAppIcon()
    {
        try
        {
            var exe = Environment.ProcessPath;
            return exe is null ? null : Icon.ExtractAssociatedIcon(exe);
        }
        catch
        {
            return null;   // a missing icon is not worth failing to start over
        }
    }

    private static void OpenExternally(string uri)
    {
        try
        {
            Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"could not open {uri}: {ex.Message}");
        }
    }

    private void Fail(string message)
    {
        MessageBox.Show(this, message, APP_NAME,
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
        Close();
    }
}
