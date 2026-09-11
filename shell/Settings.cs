using System.Text;
using System.Text.Json;

namespace Mask;

/// <summary>
/// The app's one settings file, read and written a key at a time.
///
/// It started as a single object serialised whole by the mission-folder
/// prompt. That was fine while there was one setting; the moment a second one
/// arrived, saving either would silently erase the other. Read-modify-write
/// per key is the smallest thing that cannot do that.
///
/// Lives under LocalApplicationData, beside the WebView2 profile, rather than
/// next to the executable - which may be in Program Files and read-only.
/// </summary>
internal static class Settings
{
    internal static string Path => System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "MASK", "settings.json");

    internal static string? GetString(string key)
    {
        var e = Get(key);
        return e is { ValueKind: JsonValueKind.String } v ? v.GetString() : null;
    }

    internal static bool GetBool(string key) =>
        Get(key) is { ValueKind: JsonValueKind.True };

    /// <summary>Set one key, leaving every other key exactly as it was.</summary>
    internal static void Set(string key, object? value)
    {
        try
        {
            var all = ReadAll();
            all[key] = JsonSerializer.SerializeToElement(value);

            System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
            var json = JsonSerializer.Serialize(all, new JsonSerializerOptions { WriteIndented = true });
            System.IO.File.WriteAllText(Path, json, new UTF8Encoding(false));
        }
        catch
        {
            // Not being able to remember something is never worth an error
            // dialog. The caller's feature degrades to "asks again".
        }
    }

    private static JsonElement? Get(string key) =>
        ReadAll().TryGetValue(key, out var e) ? e : null;

    private static Dictionary<string, JsonElement> ReadAll()
    {
        try
        {
            if (!System.IO.File.Exists(Path)) return new();
            using var doc = JsonDocument.Parse(System.IO.File.ReadAllText(Path));
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return new();

            var d = new Dictionary<string, JsonElement>();
            foreach (var p in doc.RootElement.EnumerateObject())
                d[p.Name] = p.Value.Clone();     // Clone: outlives the document
            return d;
        }
        catch
        {
            return new();   // unreadable settings are the same as none
        }
    }
}
