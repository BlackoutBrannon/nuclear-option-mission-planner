using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http.Headers;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;

namespace Mask;

/// <summary>
/// Finds out whether GitHub has a newer MASK, and - only when asked - fetches
/// it and swaps it in.
///
/// This is the one place the app talks to the network, and it is written to
/// be read by someone deciding whether to trust an executable. On launch it
/// makes a single GET to the GitHub Releases API and sends nothing but that
/// request. Nothing is downloaded, and nothing on disk changes, unless the
/// user clicks a button that says so.
///
/// Replacing a running executable is not something Windows allows, so the
/// install step copies MASK.exe to a temp folder, starts that copy with
/// <c>--apply-update</c>, and exits. The copy waits for the original to close,
/// copies the new files over the old, and relaunches. The single-file publish
/// is what makes this possible: one exe is a complete program.
/// </summary>
internal static class Updater
{
    private const string Owner = "BlackoutBrannon";
    private const string Repo  = "nuclear-option-mission-planner";
    private const string AssetSuffix = "-win-x64.zip";

    // Where downloads and the staged update live. Under LocalApplicationData
    // so it is always writable, and never inside the install folder so a
    // half-finished download cannot be mistaken for part of the app.
    private static string Work => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "MASK", "updates");

    private static readonly HttpClient Http = MakeClient();

    private static HttpClient MakeClient()
    {
        var c = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        // GitHub refuses requests with no User-Agent. Naming the app and
        // version is also the honest thing: it is what shows in their logs.
        c.DefaultRequestHeaders.UserAgent.ParseAdd($"MASK/{Current} (+https://github.com/{Owner}/{Repo})");
        c.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        return c;
    }

    /// <summary>The version baked into this executable, as Major.Minor.Patch.</summary>
    internal static Version Current
    {
        get
        {
            var v = Assembly.GetExecutingAssembly().GetName().Version ?? new Version(0, 0, 0);
            return new Version(v.Major, v.Minor, Math.Max(0, v.Build));
        }
    }

    internal sealed record Release(
        Version Version, string Tag, string PageUrl, string Notes,
        string? AssetName, string? AssetUrl, long AssetSize, string? ShaUrl);

    // --- the check -----------------------------------------------------------

    /// <summary>
    /// The latest release, or null for any reason at all - offline, GitHub
    /// down, rate-limited, a release with no Windows asset. A failed check is
    /// never worth interrupting the user over; it just means no banner today.
    /// </summary>
    internal static async Task<Release?> CheckAsync(CancellationToken ct)
    {
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(8));

            var url = $"https://api.github.com/repos/{Owner}/{Repo}/releases/latest";
            using var res = await Http.GetAsync(url, cts.Token);
            if (!res.IsSuccessStatusCode)
            {
                Debug.WriteLine($"update check: HTTP {(int)res.StatusCode}");
                return null;
            }

            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(cts.Token));
            var root = doc.RootElement;

            var tag = root.GetProperty("tag_name").GetString() ?? "";
            var version = ParseTag(tag);
            if (version is null) return null;

            string? assetName = null, assetUrl = null, shaUrl = null;
            long assetSize = 0;
            if (root.TryGetProperty("assets", out var assets))
            {
                foreach (var a in assets.EnumerateArray())
                {
                    var name = a.GetProperty("name").GetString() ?? "";
                    var dl   = a.GetProperty("browser_download_url").GetString();
                    if (name.EndsWith(AssetSuffix, StringComparison.OrdinalIgnoreCase))
                    {
                        assetName = name; assetUrl = dl;
                        assetSize = a.GetProperty("size").GetInt64();
                    }
                    else if (name.EndsWith(AssetSuffix + ".sha256", StringComparison.OrdinalIgnoreCase))
                    {
                        shaUrl = dl;
                    }
                }
            }

            return new Release(
                version, tag,
                root.GetProperty("html_url").GetString() ?? $"https://github.com/{Owner}/{Repo}/releases",
                root.TryGetProperty("body", out var b) ? b.GetString() ?? "" : "",
                assetName, assetUrl, assetSize, shaUrl);
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"update check failed: {ex.Message}");
            return null;
        }
    }

    // Tags are "v0.2.0". Anything that does not parse as a version is not a
    // release we know how to compare against, and is treated as none.
    private static Version? ParseTag(string tag)
    {
        var t = tag.TrimStart('v', 'V');
        if (!Version.TryParse(t, out var v)) return null;
        return new Version(v.Major, v.Minor, Math.Max(0, v.Build));
    }

    // --- "not today" ---------------------------------------------------------

    private const string SnoozeKey = "updateSnoozedUntil";

    internal static bool SnoozedToday()
    {
        var s = Settings.GetString(SnoozeKey);
        return s is not null
            && DateOnly.TryParseExact(s, "yyyy-MM-dd", out var until)
            && DateOnly.FromDateTime(DateTime.Today) < until;
    }

    /// <summary>Quiet until midnight, local time. The check itself still runs.</summary>
    internal static void SnoozeUntilTomorrow() =>
        Settings.Set(SnoozeKey, DateOnly.FromDateTime(DateTime.Today).AddDays(1).ToString("yyyy-MM-dd"));

    // --- can this install be replaced at all? --------------------------------

    /// <summary>
    /// True only for the packaged layout: MASK.exe with an app folder beside
    /// it. Run from source the executable sits in bin/ and the "install folder"
    /// would be the repository - which must never be overwritten by a download.
    /// </summary>
    internal static bool IsPackaged =>
        File.Exists(Path.Combine(AppContext.BaseDirectory, "app", "index.html"));

    /// <summary>
    /// Whether the install folder can be written without elevation. Under
    /// Program Files it cannot, and offering an install that will fail
    /// halfway is worse than offering the release page.
    /// </summary>
    internal static bool InstallFolderWritable()
    {
        try
        {
            var probe = Path.Combine(AppContext.BaseDirectory, $".mask-write-test-{Environment.ProcessId}");
            File.WriteAllText(probe, "");
            File.Delete(probe);
            return true;
        }
        catch { return false; }
    }

    internal static bool CanSelfInstall => IsPackaged && InstallFolderWritable();

    // --- download and verify -------------------------------------------------

    internal sealed record Downloaded(string ZipPath, string Sha256, bool ShaVerified);

    /// <summary>
    /// Fetch the release zip into the work folder. Length is checked against
    /// what GitHub advertised; SHA-256 is always computed, and enforced when
    /// the release publishes a .sha256 beside the zip.
    /// </summary>
    internal static async Task<Downloaded> DownloadAsync(
        Release r, IProgress<(long done, long total)> progress, CancellationToken ct)
    {
        if (r.AssetUrl is null || r.AssetName is null)
            throw new InvalidOperationException("This release has no Windows download.");

        Directory.CreateDirectory(Work);
        var zip = Path.Combine(Work, r.AssetName);
        var part = zip + ".part";

        using (var res = await Http.GetAsync(r.AssetUrl, HttpCompletionOption.ResponseHeadersRead, ct))
        {
            res.EnsureSuccessStatusCode();
            var total = res.Content.Headers.ContentLength ?? r.AssetSize;

            await using var src = await res.Content.ReadAsStreamAsync(ct);
            await using var dst = new FileStream(part, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16);

            var buf = new byte[1 << 16];
            long done = 0;
            int n;
            while ((n = await src.ReadAsync(buf, ct)) > 0)
            {
                await dst.WriteAsync(buf.AsMemory(0, n), ct);
                done += n;
                progress.Report((done, total));
            }
        }

        var length = new FileInfo(part).Length;
        if (r.AssetSize > 0 && length != r.AssetSize)
        {
            File.Delete(part);
            throw new InvalidDataException(
                $"Download is {length:N0} bytes; GitHub says the file is {r.AssetSize:N0}. Not installing it.");
        }

        var sha = await Sha256Async(part, ct);
        var verified = false;
        if (r.ShaUrl is not null)
        {
            var expected = (await Http.GetStringAsync(r.ShaUrl, ct)).Trim().Split(' ')[0];
            if (!sha.Equals(expected, StringComparison.OrdinalIgnoreCase))
            {
                File.Delete(part);
                throw new InvalidDataException(
                    "The download's SHA-256 does not match the one published with the release. Not installing it.");
            }
            verified = true;
        }

        File.Move(part, zip, overwrite: true);
        return new Downloaded(zip, sha, verified);
    }

    private static async Task<string> Sha256Async(string path, CancellationToken ct)
    {
        await using var fs = File.OpenRead(path);
        var hash = await SHA256.HashDataAsync(fs, ct);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    // --- stage ---------------------------------------------------------------

    /// <summary>
    /// Unpack the zip beside it and return the folder that holds MASK.exe and
    /// app\index.html - the zip may or may not have a top-level directory.
    /// </summary>
    internal static string Stage(string zipPath, string tag)
    {
        var dir = StagingDir(tag);
        if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        Directory.CreateDirectory(dir);
        ZipFile.ExtractToDirectory(zipPath, dir, overwriteFiles: true);

        var root = FindPackageRoot(dir)
            ?? throw new InvalidDataException("The download does not contain MASK.exe and an app folder.");
        return root;
    }

    private static string StagingDir(string tag) => Path.Combine(Work, "staged-" + Safe(tag));

    /// <summary>A staged, ready-to-install copy of this tag, if one is already here.</summary>
    internal static string? AlreadyStaged(string tag)
    {
        var dir = StagingDir(tag);
        return Directory.Exists(dir) ? FindPackageRoot(dir) : null;
    }

    private static string? FindPackageRoot(string dir)
    {
        bool IsRoot(string d) => File.Exists(Path.Combine(d, "MASK.exe"))
                              && File.Exists(Path.Combine(d, "app", "index.html"));
        if (IsRoot(dir)) return dir;
        foreach (var sub in Directory.GetDirectories(dir))
            if (IsRoot(sub)) return sub;
        return null;
    }

    private static string Safe(string s)
    {
        foreach (var c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '_');
        return s;
    }

    // --- apply ---------------------------------------------------------------

    /// <summary>
    /// Hand over to a copy of this executable and return; the caller must exit
    /// promptly so the copy can take the install folder.
    /// </summary>
    internal static void LaunchApply(string stagedRoot)
    {
        var self = Environment.ProcessPath
            ?? throw new InvalidOperationException("Cannot find this executable's own path.");

        var helperDir = Path.Combine(Work, "apply");
        Directory.CreateDirectory(helperDir);
        var helper = Path.Combine(helperDir, "MASK.exe");
        File.Copy(self, helper, overwrite: true);

        var target = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        Process.Start(new ProcessStartInfo(helper)
        {
            ArgumentList = { "--apply-update", stagedRoot, target, Environment.ProcessId.ToString() },
            UseShellExecute = false,
            WorkingDirectory = helperDir,
        });
    }

    /// <summary>
    /// The helper's whole job. Runs in the temp copy: wait for the original to
    /// exit, copy the staged files over the install, clean up, relaunch.
    /// Returns a process exit code.
    /// </summary>
    internal static int RunApply(string[] args)
    {
        // args: --apply-update <stagedRoot> <targetDir> <parentPid>
        if (args.Length < 4) return 2;
        var staged = args[1];
        var target = args[2];
        var parentPid = int.TryParse(args[3], out var p) ? p : -1;

        try
        {
            WaitForExit(parentPid, TimeSpan.FromSeconds(60));

            // app\ first, MASK.exe last: if the copy dies halfway, what is left
            // is an old shell on new content, which still starts. The reverse
            // order can leave a new shell pointed at half an app folder.
            var files = Directory.GetFiles(staged, "*", SearchOption.AllDirectories)
                .OrderBy(f => Path.GetFileName(f).Equals("MASK.exe", StringComparison.OrdinalIgnoreCase) ? 1 : 0)
                .ToList();

            foreach (var src in files)
            {
                var rel = Path.GetRelativePath(staged, src);
                var dst = Path.Combine(target, rel);
                Directory.CreateDirectory(Path.GetDirectoryName(dst)!);
                CopyWithRetry(src, dst);
            }

            // Only after every file landed. A failure above leaves the staged
            // copy in place, and the error names it.
            TryDelete(staged);
            foreach (var zip in Directory.GetFiles(Path.GetDirectoryName(staged)!, "*.zip"))
                TryDelete(zip);

            Process.Start(new ProcessStartInfo(Path.Combine(target, "MASK.exe"))
            {
                UseShellExecute = true,
                WorkingDirectory = target,
            });
            return 0;
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "MASK could not finish installing the update.\n\n" + ex.Message + "\n\n" +
                "Nothing outside the MASK folder was touched. The new version is unpacked at:\n" +
                staged + "\n\n" +
                "You can copy its contents over " + target + " by hand, or delete it and " +
                "keep using the version you have.",
                "MASK update", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static void WaitForExit(int pid, TimeSpan limit)
    {
        if (pid <= 0) return;
        try
        {
            using var proc = Process.GetProcessById(pid);
            if (!proc.WaitForExit((int)limit.TotalMilliseconds))
                throw new TimeoutException("The running MASK did not close within a minute.");
        }
        catch (ArgumentException)
        {
            // Already gone - exactly what we were waiting for.
        }
    }

    // Antivirus and indexers hold freshly-written files open for a moment;
    // a handful of short retries covers that without masking a real lock.
    private static void CopyWithRetry(string src, string dst)
    {
        for (var attempt = 1; ; attempt++)
        {
            try { File.Copy(src, dst, overwrite: true); return; }
            catch (IOException) when (attempt < 10) { Thread.Sleep(500); }
            catch (UnauthorizedAccessException) when (attempt < 10) { Thread.Sleep(500); }
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
            else if (File.Exists(path)) File.Delete(path);
        }
        catch { /* leftover temp files are untidy, not a failure */ }
    }
}
