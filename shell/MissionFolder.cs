using System.Text;
using System.Text.Json;

namespace NOMissionPlanner;

/// <summary>
/// Where this machine keeps Nuclear Option missions, and how the app remembers
/// which one you meant.
///
/// Asking on first run with an empty text box would be the easy thing to build
/// and the wrong thing to use: nobody knows off the top of their head that
/// subscribed missions live under a Steam workshop content id, and the path
/// moves with the Steam library. So the candidates are found first and offered
/// by name, with browsing left as the fallback rather than the only option.
/// </summary>
internal static class MissionFolder
{
    // Nuclear Option's Steam app id. Workshop content sits under
    // <library>/steamapps/workshop/content/<id>.
    private const string WorkshopId = "2168680";

    private static string SettingsPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "NOMissionPlanner", "settings.json");

    internal sealed record Candidate(string Label, string Path, string Note);

    /// <summary>Every known mission location that actually exists here.</summary>
    internal static List<Candidate> Discover()
    {
        var found = new List<Candidate>();
        var localLow = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "AppData", "LocalLow");

        var current = Path.Combine(localLow, "Shockfront", "NuclearOption",
                                   "TempMissions", "CurrentMission");
        if (Directory.Exists(current))
            found.Add(new Candidate("Current mission", current,
                "Whatever is loaded in the game right now"));

        foreach (var lib in SteamLibraries())
        {
            var workshop = Path.Combine(lib, "steamapps", "workshop", "content", WorkshopId);
            if (Directory.Exists(workshop))
                found.Add(new Candidate("Workshop missions", workshop,
                    "Missions you have subscribed to on Steam"));
        }

        var scanner = Path.Combine(localLow, "DefaultCompany",
                                   "Nuclear Option Mission Scanner");
        if (Directory.Exists(scanner))
            found.Add(new Candidate("Mission Scanner output", scanner,
                "Files written by the scanner mod"));

        return found;
    }

    /// <summary>
    /// Steam library roots. Steam can be installed anywhere and can hold games
    /// on several drives, so the registered libraries are read rather than the
    /// default path assumed.
    /// </summary>
    private static IEnumerable<string> SteamLibraries()
    {
        var roots = new List<string>();
        foreach (var baseDir in new[]
                 {
                     Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                     Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                 })
        {
            var steam = Path.Combine(baseDir, "Steam");
            if (Directory.Exists(steam)) roots.Add(steam);
        }

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var steam in roots)
        {
            if (seen.Add(steam)) yield return steam;

            // libraryfolders.vdf is Valve's own key-value text. Only the "path"
            // values are needed, so it is scanned rather than parsed.
            var vdf = Path.Combine(steam, "steamapps", "libraryfolders.vdf");
            if (!File.Exists(vdf)) continue;

            foreach (var line in File.ReadLines(vdf))
            {
                var i = line.IndexOf("\"path\"", StringComparison.OrdinalIgnoreCase);
                if (i < 0) continue;
                var q1 = line.IndexOf('"', i + 6);
                var q2 = q1 < 0 ? -1 : line.IndexOf('"', q1 + 1);
                if (q1 < 0 || q2 < 0) continue;

                var path = line.Substring(q1 + 1, q2 - q1 - 1).Replace(@"\\", @"\");
                if (Directory.Exists(path) && seen.Add(path)) yield return path;
            }
        }
    }

    // --- the remembered choice ---------------------------------------------

    internal static string? Saved()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return null;
            using var doc = JsonDocument.Parse(File.ReadAllText(SettingsPath));
            if (doc.RootElement.TryGetProperty("missionFolder", out var v) &&
                v.ValueKind == JsonValueKind.String)
            {
                var path = v.GetString();
                // A folder that has since been deleted is worse than none: the
                // dialog would open somewhere arbitrary with no explanation.
                return Directory.Exists(path) ? path : null;
            }
        }
        catch { /* unreadable settings are the same as none */ }
        return null;
    }

    internal static void Save(string? folder, bool asked = true)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
            var json = JsonSerializer.Serialize(
                new { missionFolder = folder, asked },
                new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(SettingsPath, json, new UTF8Encoding(false));
        }
        catch { /* not being able to remember is not worth an error */ }
    }

    internal static bool AlreadyAsked()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return false;
            using var doc = JsonDocument.Parse(File.ReadAllText(SettingsPath));
            return doc.RootElement.TryGetProperty("asked", out var v) &&
                   v.ValueKind == JsonValueKind.True;
        }
        catch { return false; }
    }

    /// <summary>
    /// Offer the folders that were found. Returns the chosen path, or null if
    /// the user would rather not say - which is a legitimate answer, since
    /// dragging a file onto the window never needed a folder in the first place.
    /// </summary>
    internal static string? Choose(IWin32Window? owner, bool firstRun)
    {
        var found = Discover();

        using var form = new Form
        {
            Text = firstRun ? "Where are your missions?" : "Mission folder",
            FormBorderStyle = FormBorderStyle.FixedDialog,
            StartPosition = owner is null
                ? FormStartPosition.CenterScreen : FormStartPosition.CenterParent,
            MinimizeBox = false,
            MaximizeBox = false,
            ClientSize = new Size(520, 150 + found.Count * 46),
            Font = SystemFonts.MessageBoxFont,
        };

        var intro = new Label
        {
            Text = firstRun
                ? "So the Open dialog starts in the right place. You can change "
                  + "this later, and you can always drag a mission onto the window instead."
                : "Where the Open dialog should start.",
            AutoSize = false,
            Bounds = new Rectangle(16, 12, 488, 40),
        };
        form.Controls.Add(intro);

        var buttons = new List<RadioButton>();
        var y = 58;
        foreach (var c in found)
        {
            var radio = new RadioButton
            {
                Text = $"{c.Label}\r\n{c.Note}",
                Tag = c.Path,
                Bounds = new Rectangle(20, y, 480, 40),
                Checked = buttons.Count == 0,
            };
            buttons.Add(radio);
            form.Controls.Add(radio);
            y += 46;
        }

        if (found.Count == 0)
        {
            form.Controls.Add(new Label
            {
                Text = "No Nuclear Option mission folders were found on this machine.",
                Bounds = new Rectangle(20, y, 480, 34),
            });
            y += 40;
        }

        // Set only by Browse. Kept separate from the radio list because one of
        // those is always checked, so a browsed path has to be able to beat it
        // rather than fall back to it.
        string? browsed = null;

        var browse = new Button { Text = "Browse...", Bounds = new Rectangle(16, y + 8, 90, 28) };
        var ok = new Button { Text = "Use this", Bounds = new Rectangle(316, y + 8, 90, 28),
                              DialogResult = DialogResult.OK };
        var skip = new Button { Text = firstRun ? "Not now" : "Cancel",
                                Bounds = new Rectangle(414, y + 8, 90, 28),
                                DialogResult = DialogResult.Cancel };

        browse.Click += (_, _) =>
        {
            using var dlg = new FolderBrowserDialog { Description = "Folder holding mission .json files" };
            if (dlg.ShowDialog(form) != DialogResult.OK) return;
            browsed = dlg.SelectedPath;
            form.DialogResult = DialogResult.OK;
            form.Close();
        };

        form.Controls.AddRange(new Control[] { browse, ok, skip });
        form.AcceptButton = ok;
        form.CancelButton = skip;
        form.ClientSize = new Size(520, y + 48);

        var result = owner is null ? form.ShowDialog() : form.ShowDialog(owner);
        if (result != DialogResult.OK) return null;

        // Browsing is an explicit act and outranks whichever radio happened to
        // be selected when it was clicked.
        if (browsed is not null) return browsed;
        return buttons.FirstOrDefault(b => b.Checked)?.Tag as string;
    }
}
