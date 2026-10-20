// App de teste: toca um tom senoidal baixinho em loop.
// Uso: ToneApp.exe <frequência Hz> <segundos>
// Compilado com dois nomes (ToneApp.exe e FakeDiscord.exe) para testar a exclusão por nome.

using System;
using System.Globalization;
using System.IO;
using System.Media;
using System.Threading;

class ToneApp
{
    static void Main(string[] args)
    {
        double frequency = args.Length > 0 ? double.Parse(args[0], CultureInfo.InvariantCulture) : 440;
        int seconds = args.Length > 1 ? int.Parse(args[1], CultureInfo.InvariantCulture) : 30;
        const int rate = 48000;
        const int frames = rate; // 1 s: número inteiro de ciclos, loop sem emenda audível
        int dataBytes = frames * 4;

        var stream = new MemoryStream();
        var w = new BinaryWriter(stream);
        w.Write(new[] { 'R', 'I', 'F', 'F' });
        w.Write(36 + dataBytes);
        w.Write(new[] { 'W', 'A', 'V', 'E', 'f', 'm', 't', ' ' });
        w.Write(16);
        w.Write((short)1);
        w.Write((short)2);
        w.Write(rate);
        w.Write(rate * 4);
        w.Write((short)4);
        w.Write((short)16);
        w.Write(new[] { 'd', 'a', 't', 'a' });
        w.Write(dataBytes);
        for (int i = 0; i < frames; i++)
        {
            short sample = (short)(Math.Sin(2 * Math.PI * frequency * i / rate) * 0.05 * short.MaxValue);
            w.Write(sample);
            w.Write(sample);
        }
        w.Flush();
        stream.Position = 0;

        var player = new SoundPlayer(stream);
        player.PlayLooping();
        Thread.Sleep(seconds * 1000);
        player.Stop();
    }
}
