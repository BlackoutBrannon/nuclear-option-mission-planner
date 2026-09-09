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

    public PlannerWindow()
    {
        Text = "Nuclear Option Mission Planner";
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

            var env = await CoreWebView2Environment.CreateAsync(null, profile, options);
            await _web.EnsureCoreWebView2Async(env);
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

        // The status bar is a browser affordance that would sit over the map's
        // own readouts. Dev tools stay available: this is a tool for people who
        // may well want to look.
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsSwipeNavigationEnabled = false;

        // A link to anything outside the app opens in the real browser instead
        // of replacing the planner with a page it cannot navigate back from.
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenExternally(e.Uri);
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
    }

    // Packaged, the planner sits in 'app' beside the executable. Run from
    // source, the executable is four levels down in shell/bin/<cfg>/<tfm> and
    // the planner is the folder above all of it - so the same build runs
    // against the working tree without copying 60 MB of tiles first.
    private static string? ContentRoot()
    {
        var packaged = Path.Combine(AppContext.BaseDirectory, "app");
        if (File.Exists(Path.Combine(packaged, "index.html"))) return packaged;

        var source = Path.GetFullPath(
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));
        if (File.Exists(Path.Combine(source, "index.html"))) return source;

        return null;
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
