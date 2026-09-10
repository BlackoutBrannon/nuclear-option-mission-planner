using System.Diagnostics;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace NOMissionPlanner;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new PlannerWindow());
    }
}

internal sealed class PlannerWindow : Form
{
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

    public PlannerWindow()
    {
        Text = "Nuclear Option Mission Planner";

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

        Controls.Add(_web);
        Load += async (_, _) => await StartWebView();
    }

    private async Task StartWebView()
    {
        var content = ContentRoot();
        if (content is null)
        {
            Fail("Could not find the planner's files.\n\n" +
                 "Expected an 'app' folder next to NOMissionPlanner.exe " +
                 "containing index.html.");
            return;
        }

        try
        {
            // Keep the browser profile beside the user's own data rather than
            // next to the executable, which may sit in Program Files.
            var profile = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "NOMissionPlanner", "WebView2");
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
        MessageBox.Show(this, message, "Nuclear Option Mission Planner",
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
        Close();
    }
}
