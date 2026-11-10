using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Windows.Data.Pdf;
using Windows.Storage;
using Windows.Storage.Streams;

namespace Rach3
{
    /// <summary>
    /// Port of desktop/LessonDesk.m. The desk behind the "With AI" tab of Create a Lesson:
    /// the conversation with ChatGPT about which piece to learn, and the candidates it showed
    /// (a YouTube video, a MIDI file or a PDF score). rach3 itself fetches every candidate,
    /// so Codex never downloads anything. Kept in %LOCALAPPDATA%\Rach3\Customize\desk.
    /// </summary>
    sealed class LessonDesk
    {
        const long FileLimit = 40L * 1024 * 1024;
        const int PreviewPages = 3;
        static readonly Regex PageName = new Regex(@"^(page|large)-([0-9]{1,4})\.png$");
        static readonly Dictionary<string, string> Types = new Dictionary<string, string>
        {
            [".jpg"] = "image/jpeg", [".png"] = "image/png", [".mid"] = "audio/midi",
        };

        readonly string root;
        readonly List<object> conversation;
        readonly Dictionary<string, object> cards;
        readonly HttpClient http;

        /// <summary>While a candidate is fetched: {stage: download|video|pages, host, received, total}.</summary>
        public Action<Dictionary<string, object>> OnProgress;

        static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        public LessonDesk(string root)
        {
            this.root = root;
            Directory.CreateDirectory(root);
            Dictionary<string, object> saved = null;
            try { saved = Json.Object(Files.Read(Path.Combine(root, "desk.json"))); } catch (Exception) { }
            conversation = Collections.AsList(saved?.TryGetValue("entries", out var entries) == true ? entries : null).Cast<object>().ToList();
            cards = saved?.TryGetValue("cards", out var known) == true && known is Dictionary<string, object> map ? map : new Dictionary<string, object>();
            // A lesson that was being made when rach3 quit is not being made any more.
            foreach (var card in cards.Values.OfType<Dictionary<string, object>>())
                if (card.Text("state") == "making") card["state"] = "shown";
            var handler = new HttpClientHandler { UseCookies = false, UseDefaultCredentials = false, AllowAutoRedirect = true,
                AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate };
            http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(120) };
            http.DefaultRequestHeaders.UserAgent.ParseAdd("rach3");
        }

        public List<object> Entries()
        {
            var list = new List<object>();
            foreach (var entry in conversation.OfType<Dictionary<string, object>>())
            {
                var copy = entry.Copy();
                if (entry.TryGetValue("card", out var card) && card is string id)
                    copy["card"] = cards.TryGetValue(id, out var value) ? value : null;
                list.Add(copy);
            }
            return list;
        }

        void Save()
        {
            try { Files.WriteAtomic(Path.Combine(root, "desk.json"), Json.Write(new Dictionary<string, object> { ["entries"] = conversation, ["cards"] = cards })); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        public void AddEntry(Dictionary<string, object> entry)
        {
            var saved = entry.Copy();
            if (saved.TryGetValue("card", out var card) && card is Dictionary<string, object> full) saved["card"] = full.Text("id");
            saved["time"] = Now();
            conversation.Add(saved);
            Save();
        }

        /// <summary>Forgets the conversation and its candidates.</summary>
        public void Clear()
        {
            foreach (var identifier in cards.Keys) Files.Delete(Path.Combine(root, identifier));
            conversation.Clear(); cards.Clear();
            Save();
        }

        public Dictionary<string, object> Card(string identifier) =>
            identifier != null && cards.TryGetValue(identifier, out var card) ? card as Dictionary<string, object> : null;

        public void Update(Dictionary<string, object> card)
        {
            var identifier = card?.Text("id");
            if (identifier == null) return;
            cards[identifier] = card.Copy();
            Save();
        }

        string FolderOf(string identifier) => Path.Combine(root, identifier);

        /// <summary>The downloaded file of a MIDI or PDF candidate.</summary>
        public string FileOf(string identifier)
        {
            var kind = Card(identifier)?.Text("kind");
            if (kind == "midi") return Path.Combine(FolderOf(identifier), "source.mid");
            if (kind == "pdf") return Path.Combine(FolderOf(identifier), "source.pdf");
            return null;
        }

        /// <summary>Files the page may load, at "_desk/&lt;card&gt;/&lt;name&gt;"; null for anything else.</summary>
        public async Task<Tuple<byte[], string>> ServedFile(string path)
        {
            var parts = path.Split('/');
            if (parts.Length != 3 || parts[0] != "_desk" || Card(parts[1]) == null) return null;
            var name = parts[2];
            var match = PageName.Match(name);
            if (match.Success)
            {
                var png = await Page(int.Parse(match.Groups[2].Value), match.Groups[1].Value == "large", parts[1]);
                return png == null ? null : Tuple.Create(png, "image/png");
            }
            var extension = Path.GetExtension(name).ToLowerInvariant();
            if (name.StartsWith(".", StringComparison.Ordinal) || name.IndexOfAny(new[] { '/', '\\', ':' }) >= 0 || !Types.ContainsKey(extension)) return null;
            var file = Path.Combine(FolderOf(parts[1]), name);
            return File.Exists(file) ? Tuple.Create(File.ReadAllBytes(file), Types[extension]) : null;
        }

        #region Fetching

        void Report(Dictionary<string, object> progress) => OnProgress?.Invoke(progress);

        sealed class Fetched
        {
            public byte[] Data;
            public string Error;
            public int Status;
        }

        /// <summary>Downloads a link; with progress, tells the page how far the download is.</summary>
        async Task<Fetched> Fetch(Uri url, long limit, bool progress)
        {
            if (url == null || url.Scheme != Uri.UriSchemeHttps || url.UserInfo.Length > 0 || url.Host.Length == 0)
                return new Fetched { Error = "Only https links can be opened." };
            var host = url.Host;
            if (progress) Report(new Dictionary<string, object> { ["stage"] = "download", ["host"] = host, ["received"] = 0 });
            try
            {
                using (var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead))
                {
                    var status = (int)response.StatusCode;
                    if (status >= 400) return new Fetched { Error = $"The site answered {status}.", Status = status };
                    var total = response.Content.Headers.ContentLength;
                    if (total > limit) return new Fetched { Error = "The file is too large.", Status = status };
                    using (var stream = await response.Content.ReadAsStreamAsync())
                    using (var buffer = new MemoryStream())
                    {
                        var chunk = new byte[81920];
                        var reported = DateTime.UtcNow;
                        int read;
                        while ((read = await stream.ReadAsync(chunk, 0, chunk.Length)) > 0)
                        {
                            buffer.Write(chunk, 0, read);
                            if (buffer.Length > limit) return new Fetched { Error = "The file is too large.", Status = status };
                            if (progress && (DateTime.UtcNow - reported).TotalSeconds >= 0.5)
                            {
                                reported = DateTime.UtcNow;
                                var state = new Dictionary<string, object> { ["stage"] = "download", ["host"] = host, ["received"] = buffer.Length };
                                if (total > 0) state["total"] = total.Value;
                                Report(state);
                            }
                        }
                        return new Fetched { Data = buffer.ToArray(), Status = status };
                    }
                }
            }
            catch (TaskCanceledException) { return new Fetched { Error = $"{host} did not answer." }; }
            catch (HttpRequestException error) { return new Fetched { Error = (error.InnerException ?? error).Message }; }
            catch (IOException error) { return new Fetched { Error = error.Message }; }
        }

        /// <summary>The 11-character id of a YouTube video link, or null.</summary>
        public static string YouTubeId(string text)
        {
            if (!Uri.TryCreate((text ?? "").Trim(), UriKind.Absolute, out var parts)) return null;
            if ((parts.Scheme != Uri.UriSchemeHttps && parts.Scheme != Uri.UriSchemeHttp) || parts.UserInfo.Length > 0) return null;
            var host = parts.Host.ToLowerInvariant();
            foreach (var prefix in new[] { "www.", "m.", "music." })
                if (host.StartsWith(prefix, StringComparison.Ordinal)) host = host.Substring(prefix.Length);
            var path = parts.AbsolutePath.Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
            string identifier = null;
            if (host == "youtu.be") identifier = path.FirstOrDefault();
            else if (host == "youtube.com" || host == "youtube-nocookie.com")
            {
                if (path.FirstOrDefault() == "watch")
                {
                    foreach (var pair in parts.Query.TrimStart('?').Split('&'))
                    {
                        var equals = pair.IndexOf('=');
                        if (equals > 0 && pair.Substring(0, equals) == "v") identifier = Uri.UnescapeDataString(pair.Substring(equals + 1));
                    }
                }
                else if (path.Length >= 2 && new[] { "shorts", "embed", "live", "v" }.Contains(path[0])) identifier = path[1];
            }
            if (identifier == null || identifier.Length != 11) return null;
            return identifier.All(c => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-') ? identifier : null;
        }

        /// <summary>
        /// Fetches a candidate: a YouTube link or an https link to a MIDI or PDF file. Returns
        /// the card to show, or throws an error message meant for ChatGPT.
        /// </summary>
        public async Task<Dictionary<string, object>> Show(string source, string title, string note)
        {
            var identifier = Guid.NewGuid().ToString("N").Substring(0, 12);
            var folder = FolderOf(identifier);
            var card = new Dictionary<string, object>
            {
                ["id"] = identifier, ["title"] = title ?? "", ["note"] = note ?? "", ["source"] = source ?? "",
                ["state"] = "shown", ["created"] = Now(),
            };
            Directory.CreateDirectory(folder);
            try
            {
                await Fill(card, identifier, folder, source ?? "", title ?? "");
            }
            catch (Exception)
            {
                Files.Delete(folder);
                throw;
            }
            cards[identifier] = card; Save();
            return card;
        }

        static Exception Refuse(string message) => new InvalidOperationException(message);

        async Task Fill(Dictionary<string, object> card, string identifier, string folder, string source, string title)
        {
            var video = YouTubeId(source);
            if (video != null)
            {
                var watch = "https://www.youtube.com/watch?v=" + video;
                card["kind"] = "youtube"; card["link"] = watch;
                Report(new Dictionary<string, object> { ["stage"] = "video" });
                var oembed = new Uri("https://www.youtube.com/oembed?url=" + Uri.EscapeDataString(watch) + "&format=json");
                var answer = await Fetch(oembed, 256 * 1024, false);
                Dictionary<string, object> info = null;
                if (answer.Data != null) { try { info = Json.Object(System.Text.Encoding.UTF8.GetString(answer.Data)); } catch (Exception) { } }
                // YouTube answers 401 for a video that exists but may not play inside other apps.
                // It can still become a lesson; the card opens it on YouTube.
                if (answer.Status == 401) { card["embeddable"] = false; info = new Dictionary<string, object>(); }
                if (info == null)
                    throw Refuse(answer.Status == 404 || answer.Status == 400 ? "There is no YouTube video at this link." :
                        answer.Error != null ? "YouTube could not be reached: " + answer.Error : "YouTube did not describe this video.");
                if (title.Length == 0 && info.Text("title") is string name) card["title"] = name;
                if (info.Text("author_name") is string author) card["author"] = author;
                var thumb = await Fetch(new Uri($"https://i.ytimg.com/vi/{video}/hqdefault.jpg"), 2 * 1024 * 1024, false);
                if (thumb.Data != null)
                {
                    try
                    {
                        File.WriteAllBytes(Path.Combine(folder, "thumb.jpg"), thumb.Data);
                        card["thumb"] = $"_desk/{identifier}/thumb.jpg";
                    }
                    catch (IOException) { }
                }
                return;
            }
            if (!Uri.TryCreate(source.Trim(), UriKind.Absolute, out var url)) throw Refuse("That is not a link.");
            var fetched = await Fetch(url, FileLimit, true);
            if (fetched.Data == null) throw Refuse(fetched.Error ?? "Nothing was downloaded.");
            var data = fetched.Data;
            if (title.Length == 0)
            {
                var last = url.Segments.LastOrDefault() ?? "";
                card["title"] = Path.GetFileNameWithoutExtension(Uri.UnescapeDataString(last.TrimEnd('/')));
            }
            card["size"] = data.LongLength;
            if (data.Length >= 4 && data[0] == 'M' && data[1] == 'T' && data[2] == 'h' && data[3] == 'd')
            {
                card["kind"] = "midi";
                File.WriteAllBytes(Path.Combine(folder, "source.mid"), data);
                card["file"] = $"_desk/{identifier}/source.mid";
            }
            else if (data.Length >= 5 && data[0] == '%' && data[1] == 'P' && data[2] == 'D' && data[3] == 'F' && data[4] == '-')
            {
                card["kind"] = "pdf";
                var file = Path.Combine(folder, "source.pdf");
                File.WriteAllBytes(file, data);
                Report(new Dictionary<string, object> { ["stage"] = "pages" });
                var pages = new List<object>();
                var count = 0;
                try
                {
                    var document = await OpenPdf(file);
                    count = (int)document.PageCount;
                    for (var number = 1; number <= Math.Min(count, PreviewPages); number++)
                    {
                        var png = await Render(document, number, 1000);
                        if (png == null) continue;
                        var name = $"page-{number}.png";
                        File.WriteAllBytes(Path.Combine(folder, name), png);
                        pages.Add($"_desk/{identifier}/{name}");
                    }
                }
                catch (Exception error) when (error is IOException || error is COMException || error is UnauthorizedAccessException || error is ArgumentException)
                {
                    count = 0;
                }
                card["pages"] = pages;
                card["pageCount"] = count;
                if (count == 0) throw Refuse("The PDF could not be opened.");
            }
            else throw Refuse("The link is not a MIDI or PDF file. Link the file itself, not the page about it.");
        }

        #endregion

        #region PDF pages

        static async Task<PdfDocument> OpenPdf(string path)
        {
            var file = await StorageFile.GetFileFromPathAsync(path);
            return await PdfDocument.LoadFromFileAsync(file);
        }

        /// <summary>
        /// One PDF page as a PNG `width` pixels wide, with the empty paper around the music
        /// cut away so the notes fill the picture.
        /// </summary>
        static async Task<byte[]> Render(PdfDocument document, int number, uint width)
        {
            if (number < 1 || number > document.PageCount) return null;
            byte[] rendered;
            using (var page = document.GetPage((uint)(number - 1)))
            using (var output = new InMemoryRandomAccessStream())
            {
                var size = page.Size;
                var ratio = size.Width > 0 ? size.Height / size.Width : 1.414;
                var height = (uint)Math.Max(1, Math.Min(width * 4.0, width * ratio));
                await page.RenderToStreamAsync(output, new PdfPageRenderOptions { DestinationWidth = width, DestinationHeight = height });
                output.Seek(0);
                using (var stream = output.AsStreamForRead())
                using (var copy = new MemoryStream())
                {
                    stream.CopyTo(copy);
                    rendered = copy.ToArray();
                }
            }
            return await Task.Run(() => CropToInk(rendered, (int)width));
        }

        static byte[] CropToInk(byte[] png, int width)
        {
            using (var source = new MemoryStream(png))
            using (var decoded = new Bitmap(source))
            using (var image = new Bitmap(decoded.Width, decoded.Height, PixelFormat.Format32bppArgb))
            {
                using (var graphics = Graphics.FromImage(image))
                {
                    // Transparent parts of a page are paper.
                    graphics.Clear(Color.White);
                    graphics.DrawImage(decoded, 0, 0, decoded.Width, decoded.Height);
                }
                int w = image.Width, h = image.Height;
                var data = image.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                var pixels = new byte[data.Stride * h];
                Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
                var stride = data.Stride;
                image.UnlockBits(data);
                // Find the ink: rows and columns with a pixel that is not near white.
                int top = h, bottom = 0, left = w, right = 0;
                for (var y = 0; y < h; y++)
                {
                    var row = y * stride;
                    for (var x = 0; x < w; x++)
                    {
                        var at = row + x * 4;
                        if (pixels[at] > 235 && pixels[at + 1] > 235 && pixels[at + 2] > 235) continue;
                        if (y < top) top = y;
                        if (y > bottom) bottom = y;
                        if (x < left) left = x;
                        if (x > right) right = x;
                    }
                }
                var area = new Rectangle(0, 0, w, h);
                if (top < bottom && left < right)
                {
                    var margin = (int)(width * 0.02);
                    int x0 = Math.Max(0, left - margin), y0 = Math.Max(0, top - margin);
                    int x1 = Math.Min(w, right + margin + 1), y1 = Math.Min(h, bottom + margin + 1);
                    area = Rectangle.FromLTRB(x0, y0, x1, y1);
                }
                using (var cropped = image.Clone(area, PixelFormat.Format24bppRgb))
                using (var result = new MemoryStream())
                {
                    cropped.Save(result, ImageFormat.Png);
                    return result.ToArray();
                }
            }
        }

        readonly SemaphoreSlim rendering = new SemaphoreSlim(1, 1);

        /// <summary>
        /// Any page of a shown PDF, drawn the first time it is asked for: "page-N" for the
        /// card, "large-N" sharp enough to zoom into.
        /// </summary>
        async Task<byte[]> Page(int number, bool large, string identifier)
        {
            var card = Card(identifier);
            if (card?.Text("kind") != "pdf" || number < 1 || number > card.Number("pageCount")) return null;
            var file = Path.Combine(FolderOf(identifier), $"{(large ? "large" : "page")}-{number}.png");
            await rendering.WaitAsync();
            try
            {
                if (File.Exists(file)) return File.ReadAllBytes(file);
                var source = FileOf(identifier);
                if (source == null || !File.Exists(source)) return null;
                var png = await Render(await OpenPdf(source), number, large ? 2400u : 1000u);
                if (png != null) { try { File.WriteAllBytes(file, png); } catch (IOException) { } }
                return png;
            }
            catch (Exception error) when (error is IOException || error is COMException || error is UnauthorizedAccessException || error is ArgumentException)
            {
                return null;
            }
            finally { rendering.Release(); }
        }

        #endregion

#if PIANO_CAPTURE
        /// <summary>A PDF card made from a local file, the way Show makes one from a download.</summary>
        public async Task<Dictionary<string, object>> SelfTestPdf(string pdf)
        {
            var identifier = Guid.NewGuid().ToString("N").Substring(0, 12);
            var folder = FolderOf(identifier);
            Directory.CreateDirectory(folder);
            var card = new Dictionary<string, object>
            {
                ["id"] = identifier, ["title"] = "Self-test", ["note"] = "", ["source"] = "", ["state"] = "shown", ["created"] = Now(), ["kind"] = "pdf",
            };
            var file = Path.Combine(folder, "source.pdf");
            File.Copy(pdf, file);
            var document = await OpenPdf(file);
            var count = (int)document.PageCount;
            var pages = new List<object>();
            var png = await Render(document, 1, 1000);
            if (png != null)
            {
                File.WriteAllBytes(Path.Combine(folder, "page-1.png"), png);
                pages.Add($"_desk/{identifier}/page-1.png");
            }
            card["pages"] = pages; card["pageCount"] = count;
            cards[identifier] = card; Save();
            using (var image = new Bitmap(new MemoryStream(png ?? new byte[0])))
                return new Dictionary<string, object> { ["id"] = identifier, ["pageCount"] = count, ["width"] = image.Width, ["height"] = image.Height };
        }
#endif
    }
}
