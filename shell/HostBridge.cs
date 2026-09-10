using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Mask;

/// <summary>
/// The things a browser will not do: read a file the user picks, and write one
/// where the user says.
///
/// The planner talks to this over web messages rather than a host object.
/// Messages are plain JSON both ways, so the page needs no interop shim and the
/// same source still runs in a browser - it simply never sees a host and keeps
/// using downloads.
///
/// Every request carries an id and gets exactly one reply with that id, so the
/// page can await a dialog like any other promise.
/// </summary>
internal sealed class HostBridge
{
    private readonly CoreWebView2 _core;
    private readonly Form _owner;

    // Dialogs reopen where the last one of the same kind left off. Missions,
    // plans and exports live in different places and remembering one folder for
    // all of them would send you back to the wrong one every time.
    private readonly Dictionary<string, string> _lastFolder = new();

    public HostBridge(CoreWebView2 core, Form owner)
    {
        _core = core;
        _owner = owner;
        _core.WebMessageReceived += OnMessage;
    }

    private void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        int id = 0;
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            id = root.GetProperty("id").GetInt32();
            var action = root.GetProperty("action").GetString() ?? "";
            var payload = root.TryGetProperty("payload", out var p) ? p : default;

            var result = Handle(action, payload);
            Reply(id, true, result, null);
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"host action failed: {ex}");
            Reply(id, false, null, ex.Message);
        }
    }

    private object? Handle(string action, JsonElement payload) => action switch
    {
        "openFile" => OpenFile(payload),
        "saveFile" => SaveFile(payload),
        "openTemp" => OpenTemp(payload),
        "missionFolder" => PickMissionFolder(),
        _ => throw new InvalidOperationException($"unknown action '{action}'"),
    };

    // Returns { name, path, text } or null when the dialog is cancelled.
    private object? OpenFile(JsonElement p)
    {
        var kind = Str(p, "kind", "file");
        using var dlg = new OpenFileDialog
        {
            Title = Str(p, "title", "Open"),
            Filter = Str(p, "filter", "All files (*.*)|*.*"),
            InitialDirectory = StartFolder(kind, Str(p, "startIn", "")),
            CheckFileExists = true,
        };

        if (dlg.ShowDialog(_owner) != DialogResult.OK) return null;
        Remember(kind, dlg.FileName);

        return new
        {
            name = Path.GetFileName(dlg.FileName),
            path = dlg.FileName,
            text = File.ReadAllText(dlg.FileName),
        };
    }

    // Writes either `text` or `base64`, and returns { name, path } or null.
    private object? SaveFile(JsonElement p)
    {
        var kind = Str(p, "kind", "file");
        var suggested = Str(p, "suggested", "untitled");

        using var dlg = new SaveFileDialog
        {
            Title = Str(p, "title", "Save"),
            Filter = Str(p, "filter", "All files (*.*)|*.*"),
            FileName = suggested,
            InitialDirectory = StartFolder(kind, Str(p, "startIn", "")),
            OverwritePrompt = true,
            AddExtension = true,
        };

        if (dlg.ShowDialog(_owner) != DialogResult.OK) return null;
        Remember(kind, dlg.FileName);

        if (p.TryGetProperty("base64", out var b64) && b64.ValueKind == JsonValueKind.String)
        {
            File.WriteAllBytes(dlg.FileName, Convert.FromBase64String(b64.GetString()!));
        }
        else
        {
            // UTF-8 with no BOM: these are read back by the planner, by a
            // future plugin, and by whoever opens them in a text editor.
            File.WriteAllText(dlg.FileName, Str(p, "text", ""), new UTF8Encoding(false));
        }

        return new { name = Path.GetFileName(dlg.FileName), path = dlg.FileName };
    }

    // For the briefing sheet, which wants a browser to print from. A blob URL
    // cannot be handed to another application, so the page's HTML is written to
    // a real file first and that is what gets opened.
    private object OpenTemp(JsonElement p)
    {
        var dir = Path.Combine(Path.GetTempPath(), "MASK");
        Directory.CreateDirectory(dir);

        var name = Safe(Str(p, "name", "briefing")) + ".html";
        var file = Path.Combine(dir, name);
        File.WriteAllText(file, Str(p, "text", ""), new UTF8Encoding(false));

        Process.Start(new ProcessStartInfo(file) { UseShellExecute = true });
        return new { path = file };
    }

    // Returns { path, label } for whatever the mission folder now is, or null
    // if the user declined to change it.
    private object? PickMissionFolder()
    {
        var chosen = MissionFolder.Choose(_owner, firstRun: false);
        if (chosen is null) return null;
        MissionFolder.Save(chosen);
        _lastFolder.Remove("mission");     // the new choice should win at once
        return new { path = chosen, label = FolderLabel(chosen) };
    }

    private string StartFolder(string kind, string preferred)
    {
        if (_lastFolder.TryGetValue(kind, out var last) && Directory.Exists(last)) return last;
        if (preferred.Length > 0 && Directory.Exists(preferred)) return preferred;

        // Where this machine keeps missions, if it has been established. Only a
        // fallback: once you have opened one from somewhere, that is where you
        // are working and the dialog should go back there.
        if (kind == "mission")
        {
            var configured = MissionFolder.Saved();
            if (configured is not null) return configured;
        }

        return Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
    }

    private void Remember(string kind, string file)
    {
        var dir = Path.GetDirectoryName(file);
        if (!string.IsNullOrEmpty(dir)) _lastFolder[kind] = dir;
    }

    // The last path segment, for showing in the page. A trailing separator
    // would otherwise make GetFileName return an empty string.
    internal static string FolderLabel(string path)
    {
        var trimmed = path.TrimEnd(Path.DirectorySeparatorChar,
                                   Path.AltDirectorySeparatorChar);
        var name = Path.GetFileName(trimmed);
        return name.Length > 0 ? name : trimmed;
    }

    private static string Safe(string name)
    {
        foreach (var c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
        return name.Length == 0 ? "briefing" : name;
    }

    private static string Str(JsonElement p, string key, string fallback) =>
        p.ValueKind == JsonValueKind.Object &&
        p.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() ?? fallback
            : fallback;

    private void Reply(int id, bool ok, object? result, string? error)
    {
        _core.PostWebMessageAsJson(JsonSerializer.Serialize(
            new { id, ok, result, error }));
    }
}
