using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

namespace Rach3
{
    /// <summary>
    /// Codex's way to OpenAI on Windows. Windows gives a program in the Codex box no HTTPS
    /// (schannel refuses restricted sign-ins), so Codex sends plain HTTP to this relay on
    /// 127.0.0.1, and rach3, outside the box, carries each request to one fixed address over
    /// HTTPS. The relay also adds the ChatGPT sign-in itself, so Codex never holds it, and it
    /// answers only requests that carry its secret path.
    /// </summary>
    sealed class CodexRelay : IDisposable
    {
        static readonly HashSet<string> Dropped = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Host", "Connection", "Keep-Alive", "Proxy-Connection", "Proxy-Authorization", "Transfer-Encoding", "Content-Length",
            "TE", "Trailer", "Upgrade", "Expect", "Authorization",
        };

        readonly TcpListener listener;
        readonly string upstream, secret;
        readonly Func<string> token;
        readonly HttpClient client;

        /// <summary>What Codex is given as its provider's address.</summary>
        public string BaseUrl { get; }

        public CodexRelay(string upstream, Func<string> token)
        {
            this.upstream = upstream.TrimEnd('/'); this.token = token;
            var bytes = new byte[16];
            using (var random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
            secret = string.Concat(bytes.Select(value => value.ToString("x2")));
            client = new HttpClient(new HttpClientHandler { UseCookies = false, AllowAutoRedirect = false }) { Timeout = System.Threading.Timeout.InfiniteTimeSpan };
            client.DefaultRequestHeaders.ExpectContinue = false;
            listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            BaseUrl = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port + "/" + secret;
            Task.Run(Accept);
        }

        async Task Accept()
        {
            while (true)
            {
                TcpClient connection;
                try { connection = await listener.AcceptTcpClientAsync(); }
                catch (Exception error) when (error is ObjectDisposedException || error is SocketException || error is InvalidOperationException) { return; }
                _ = Task.Run(() => Serve(connection));
            }
        }

        async Task Serve(TcpClient connection)
        {
            using (connection)
            using (var stream = connection.GetStream())
            {
                try
                {
                    var head = await ReadHead(stream);
                    if (head == null) return;
                    var lines = head.Split(new[] { "\r\n" }, StringSplitOptions.None);
                    var request = lines[0].Split(' ');
                    var prefix = "/" + secret + "/";
                    if (request.Length < 3 || !request[1].StartsWith(prefix, StringComparison.Ordinal)) { await Answer(stream, "404 Not Found"); return; }
                    var headers = lines.Skip(1).Where(line => line.Contains(':'))
                        .Select(line => new KeyValuePair<string, string>(line.Substring(0, line.IndexOf(':')).Trim(), line.Substring(line.IndexOf(':') + 1).Trim())).ToList();
                    string Header(string name) => headers.FirstOrDefault(pair => string.Equals(pair.Key, name, StringComparison.OrdinalIgnoreCase)).Value;
                    byte[] body;
                    if (string.Equals(Header("Transfer-Encoding"), "chunked", StringComparison.OrdinalIgnoreCase)) body = await ReadChunked(stream);
                    else body = await ReadExactly(stream, long.TryParse(Header("Content-Length"), out var length) ? length : 0);

                    var message = new HttpRequestMessage(new HttpMethod(request[0]), upstream + request[1].Substring(prefix.Length - 1));
                    if (body.Length > 0 || request[0] == "POST") message.Content = new ByteArrayContent(body);
                    foreach (var pair in headers.Where(pair => !Dropped.Contains(pair.Key)))
                        if (!message.Headers.TryAddWithoutValidation(pair.Key, pair.Value)) message.Content?.Headers.TryAddWithoutValidation(pair.Key, pair.Value);
                    message.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token());

                    using (var response = await client.SendAsync(message, HttpCompletionOption.ResponseHeadersRead))
                    {
                        var reply = new StringBuilder("HTTP/1.1 " + (int)response.StatusCode + " " + response.ReasonPhrase + "\r\n");
                        foreach (var pair in response.Headers.Concat(response.Content.Headers).Where(pair => !Dropped.Contains(pair.Key)))
                            foreach (var value in pair.Value) reply.Append(pair.Key).Append(": ").Append(value).Append("\r\n");
                        reply.Append("Connection: close\r\n\r\n");
                        var bytes = Encoding.UTF8.GetBytes(reply.ToString());
                        await stream.WriteAsync(bytes, 0, bytes.Length);
                        // Streamed as it comes, so Codex sees the answer word by word.
                        using (var content = await response.Content.ReadAsStreamAsync())
                        {
                            var buffer = new byte[16384];
                            int read;
                            while ((read = await content.ReadAsync(buffer, 0, buffer.Length)) > 0) await stream.WriteAsync(buffer, 0, read);
                        }
                    }
                }
                catch (Exception error) when (error is IOException || error is HttpRequestException || error is SocketException ||
                                              error is ObjectDisposedException || error is TaskCanceledException || error is FormatException)
                {
                    try { await Answer(stream, "502 Bad Gateway"); } catch (Exception) { }
                }
            }
        }

        static async Task Answer(Stream stream, string status)
        {
            var bytes = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            await stream.WriteAsync(bytes, 0, bytes.Length);
        }

        static async Task<string> ReadHead(Stream stream)
        {
            var head = new List<byte>();
            var one = new byte[1];
            while (head.Count < 65536)
            {
                if (await stream.ReadAsync(one, 0, 1) == 0) return null;
                head.Add(one[0]);
                var count = head.Count;
                if (count >= 4 && head[count - 4] == '\r' && head[count - 3] == '\n' && head[count - 2] == '\r' && head[count - 1] == '\n')
                    return Encoding.UTF8.GetString(head.ToArray(), 0, count - 4);
            }
            return null;
        }

        static async Task<byte[]> ReadExactly(Stream stream, long length)
        {
            if (length < 0 || length > 256L * 1024 * 1024) throw new IOException("request too large");
            var body = new byte[length];
            var done = 0;
            while (done < length)
            {
                var read = await stream.ReadAsync(body, done, (int)Math.Min(length - done, 65536));
                if (read == 0) throw new IOException("request ended early");
                done += read;
            }
            return body;
        }

        static async Task<byte[]> ReadChunked(Stream stream)
        {
            var body = new MemoryStream();
            while (true)
            {
                var line = await ReadLine(stream);
                var size = Convert.ToInt64(line.Split(';')[0].Trim(), 16);
                if (size == 0) { while ((await ReadLine(stream)).Length > 0) { } return body.ToArray(); }
                var chunk = await ReadExactly(stream, size);
                body.Write(chunk, 0, chunk.Length);
                await ReadLine(stream);
            }
        }

        static async Task<string> ReadLine(Stream stream)
        {
            var line = new StringBuilder();
            var one = new byte[1];
            while (true)
            {
                if (await stream.ReadAsync(one, 0, 1) == 0) throw new IOException("request ended early");
                if (one[0] == '\n') return line.ToString().TrimEnd('\r');
                line.Append((char)one[0]);
                if (line.Length > 4096) throw new IOException("line too long");
            }
        }

        public void Dispose()
        {
            try { listener.Stop(); } catch (SocketException) { }
            client.Dispose();
        }
    }
}
