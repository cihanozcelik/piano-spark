#if PIANO_CAPTURE
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading.Tasks;

namespace Rach3
{
    /// <summary>Development checks on a real Windows machine. Never compiled into releases.</summary>
    sealed partial class CustomizeService
    {
        /// <summary>A sign-in that only the stand-in for OpenAI accepts (StandIn below).</summary>
        public void SelfTestSignIn()
        {
            session = new Dictionary<string, object>
            {
                ["access_token"] = "rach3-self-test", ["refresh_token"] = "rach3-self-test",
                ["expires_at"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600,
            };
            PublishAuth();
        }

        /// <summary>
        /// What the box lets through, tried by a command prompt in the same box as Codex:
        /// the person's files, rach3's own data and the Desktop stay closed; Codex's program and
        /// the scratch copy stay open, and the web only through rach3's relay. Each entry is "pass" or why not.
        /// </summary>
        public Dictionary<string, object> SelfTestBox()
        {
            var secret = "rach3-box-secret-" + Guid.NewGuid().ToString("N");
            var personal = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "rach3-box-probe.txt");
            var ours = Path.Combine(root, "rach3-box-probe.txt");
            var desktop = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "rach3-box-probe.txt");
            var scratch = Path.Combine(Workspace, "rach3-box-probe.txt");
            File.WriteAllText(personal, secret); File.WriteAllText(ours, secret);
            if (File.Exists(desktop)) File.Delete(desktop);
            Tuple<int, string> Run(string command)
            {
                using (var group = new ProcessGroup(belowNormal: false))
                using (var process = CodexBox.Start(Path.Combine(Environment.SystemDirectory, "cmd.exe"), "/d /s /c \"" + command + "\"",
                                                    Workspace, CodexEnvironment(), group.Add))
                {
                    process.Input.Dispose();
                    var error = Task.Run(() => process.Error.ReadToEnd());
                    var output = Task.Run(() => process.Output.ReadToEnd());
                    // The group ends everything the command started, which closes the pipes.
                    var finished = process.WaitForExit(60000);
                    if (!finished) group.Terminate();
                    Task.WaitAll(new Task[] { output, error }, 10000);
                    var text = ((output.IsCompleted ? output.Result : "") + (error.IsCompleted ? error.Result : "")).Trim();
                    return Tuple.Create(finished ? process.ExitCode : -1, (finished ? "" : "timed out: ") + text);
                }
            }
            string Closed(Tuple<int, string> run) => run.Item1 != 0 && !run.Item2.Contains(secret) ? "pass" : run.Item1 + " " + run.Item2;
            var report = new Dictionary<string, object>();
            try
            {
                OpenBox();
                report["readPersonal"] = Closed(Run("type \"" + personal + "\""));
                report["listPersonal"] = Closed(Run("dir /b \"" + Path.GetDirectoryName(personal) + "\""));
                report["readRach3Data"] = Closed(Run("type \"" + ours + "\""));
                var write = Run("echo box> \"" + desktop + "\"");
                report["writeDesktop"] = !File.Exists(desktop) ? "pass" : write.Item1 + " " + write.Item2;
                var made = Run("echo box> \"" + scratch + "\" && type \"" + scratch + "\"");
                report["writeScratch"] = made.Item1 == 0 && File.Exists(scratch) ? "pass" : made.Item1 + " " + made.Item2;
                var program = Run("dir /b \"" + Path.Combine(codexRoot, "bin") + "\"");
                report["readCodex"] = program.Item1 == 0 && program.Item2.Contains("codex.exe") ? "pass" : program.Item1 + " " + program.Item2;
                // Codex reaches the web only through rach3's relay: here the relay carries its
                // request to example.com, which answers with 405. On its own it gets no HTTPS.
                using (var test = new CodexRelay("https://example.com/v1", () => "probe"))
                {
                    const string probe = "model_providers.probe.";
                    var relayed = Run("set ACCESS_TOKEN=probe&& \"" + CodexBinary + "\" exec --skip-git-repo-check -c model_provider=probe -c " +
                        probe + "name=probe -c " + probe + "base_url=" + test.BaseUrl + " -c " + probe + "env_key=ACCESS_TOKEN -c " +
                        probe + "wire_api=responses -c " + probe + "requires_openai_auth=false -c " + probe + "supports_websockets=false -c " +
                        probe + "request_max_retries=0 -c " + probe + "stream_max_retries=0 hi");
                    report["relay"] = relayed.Item2.Contains("405") ? "pass" : relayed.Item1 + " " + relayed.Item2.Substring(Math.Max(0, relayed.Item2.Length - 600));
                }
                var direct = Run("curl.exe -s -o NUL -w %{http_code} https://example.com");
                report["noDirectHttps"] = direct.Item2.Trim() != "200" ? "pass" : "reached example.com directly";
            }
            catch (Exception error) { report["error"] = error.ToString(); }
            finally
            {
                foreach (var file in new[] { personal, ours, desktop, scratch }) try { File.Delete(file); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                Files.Delete(Workspace);
            }
            return report;
        }

        /// <summary>A desk card made from a local PDF, as rach3.show would make it, for the page checks.</summary>
        public async Task<Dictionary<string, object>> SelfTestCards(string pdf)
        {
            var report = new Dictionary<string, object>();
            try { await desk.Show("http://example.com/not-https.mid", "", ""); report["refusesHttp"] = false; }
            catch (Exception) { report["refusesHttp"] = true; }
            report["youtubeId"] = LessonDesk.YouTubeId("https://youtu.be/dQw4w9WgXcQ?t=3") == "dQw4w9WgXcQ" &&
                LessonDesk.YouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x") == "dQw4w9WgXcQ" &&
                LessonDesk.YouTubeId("https://www.youtube.com/shorts/dQw4w9WgXcQ") == "dQw4w9WgXcQ" &&
                LessonDesk.YouTubeId("https://example.com/watch?v=dQw4w9WgXcQ") == null;
            if (pdf != null) report["pdfCard"] = await desk.SelfTestPdf(pdf);
            return report;
        }

        /// <summary>
        /// A stand-in for OpenAI's Responses API, for a whole change made offline: to a new
        /// message it answers by running each command in turn with the shell tool Codex offers,
        /// then says "done". It keeps the Authorization header of every request it saw.
        /// </summary>
        public sealed class StandIn : IDisposable
        {
            readonly TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
            readonly string[] commands;
            public readonly List<string> Authorizations = new List<string>();
            public readonly List<string> Outputs = new List<string>();
            public string Url { get; }

            public StandIn(params string[] commands)
            {
                this.commands = commands;
                listener.Start();
                Url = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port + "/v1";
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

            static async Task<string> ReadLine(Stream stream)
            {
                var line = new List<byte>();
                var one = new byte[1];
                while (await stream.ReadAsync(one, 0, 1) == 1)
                {
                    if (one[0] == '\n') break;
                    if (one[0] != '\r') line.Add(one[0]);
                }
                return Encoding.ASCII.GetString(line.ToArray());
            }

            async Task Serve(TcpClient connection)
            {
                using (connection)
                using (var stream = connection.GetStream())
                {
                    try
                    {
                        var request = await ReadLine(stream);
                        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                        for (var line = await ReadLine(stream); line.Length > 0; line = await ReadLine(stream))
                            if (line.Contains(':')) headers[line.Substring(0, line.IndexOf(':')).Trim()] = line.Substring(line.IndexOf(':') + 1).Trim();
                        var length = headers.TryGetValue("Content-Length", out var given) ? int.Parse(given) : 0;
                        var body = new byte[length];
                        for (var read = 0; read < length;)
                        {
                            var count = await stream.ReadAsync(body, read, length - read);
                            if (count == 0) break;
                            read += count;
                        }
                        byte[] answer;
                        if (!request.StartsWith("POST ", StringComparison.Ordinal))
                            answer = Encoding.ASCII.GetBytes("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        else
                        {
                            lock (Authorizations) Authorizations.Add(headers.TryGetValue("Authorization", out var authorization) ? authorization : "");
                            var events = Encoding.UTF8.GetBytes(Respond(Json.Object(Encoding.UTF8.GetString(body)) ?? new Dictionary<string, object>()));
                            answer = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: " + events.Length + "\r\nConnection: close\r\n\r\n")
                                .Concat(events).ToArray();
                        }
                        await stream.WriteAsync(answer, 0, answer.Length);
                    }
                    catch (Exception error) when (error is IOException || error is FormatException || error is ArgumentException || error is InvalidOperationException) { }
                }
            }

            string Respond(Dictionary<string, object> request)
            {
                var items = Collections.AsList(request.TryGetValue("input", out var input) ? input : null).OfType<Dictionary<string, object>>().ToList();
                var last = items.FindLastIndex(item => item.Text("role") == "user");
                var outputs = items.Skip(Math.Max(0, last)).Where(item => item.Text("type") == "function_call_output" || item.Text("type") == "custom_tool_call_output").ToList();
                lock (Outputs) foreach (var output in outputs) Outputs.Add(Json.Write(output.TryGetValue("output", out var text) ? text : null));
                var tools = Collections.AsList(request.TryGetValue("tools", out var offered) ? offered : null).OfType<Dictionary<string, object>>()
                    .Where(tool => tool.Text("name") != null).GroupBy(tool => tool.Text("name")).ToDictionary(group => group.Key, group => group.First().Text("type"));
                var identifier = "resp_" + items.Count;
                Dictionary<string, object> item;
                if (outputs.Count >= commands.Length)
                    item = new Dictionary<string, object>
                    {
                        ["type"] = "message", ["role"] = "assistant", ["id"] = "msg_" + items.Count,
                        ["content"] = new List<object> { new Dictionary<string, object> { ["type"] = "output_text", ["text"] = "done" } },
                    };
                else
                {
                    var command = commands[outputs.Count];
                    var call = "call_" + items.Count;
                    if (tools.TryGetValue("exec", out var kind) && kind == "custom")
                        item = new Dictionary<string, object>
                        {
                            ["type"] = "custom_tool_call", ["id"] = "ctc_" + items.Count, ["call_id"] = call, ["name"] = "exec",
                            ["input"] = "const r = await tools.exec_command({cmd: " + Json.Write(command) + ", yield_time_ms: 15000}); text(r);",
                        };
                    else if (tools.ContainsKey("exec_command"))
                        item = new Dictionary<string, object>
                        {
                            ["type"] = "function_call", ["id"] = "fc_" + items.Count, ["call_id"] = call, ["name"] = "exec_command",
                            ["arguments"] = Json.Write(new Dictionary<string, object> { ["cmd"] = command, ["yield_time_ms"] = 10000 }),
                        };
                    else
                        item = new Dictionary<string, object>
                        {
                            ["type"] = "function_call", ["id"] = "fc_" + items.Count, ["call_id"] = call, ["name"] = "shell",
                            ["arguments"] = Json.Write(new Dictionary<string, object> { ["command"] = new List<object> { "cmd.exe", "/d", "/c", command } }),
                        };
                }
                var usage = new Dictionary<string, object>
                {
                    ["input_tokens"] = 10, ["input_tokens_details"] = null, ["output_tokens"] = 5, ["output_tokens_details"] = null, ["total_tokens"] = 15,
                };
                var events = new[]
                {
                    new Dictionary<string, object> { ["type"] = "response.created", ["response"] = new Dictionary<string, object> { ["id"] = identifier } },
                    new Dictionary<string, object> { ["type"] = "response.output_item.done", ["item"] = item },
                    new Dictionary<string, object> { ["type"] = "response.completed", ["response"] = new Dictionary<string, object> { ["id"] = identifier, ["usage"] = usage } },
                };
                return string.Concat(events.Select(e => "event: " + e["type"] + "\ndata: " + Json.Write(e) + "\n\n"));
            }

            public void Dispose() { try { listener.Stop(); } catch (SocketException) { } }
        }
    }
}
#endif
