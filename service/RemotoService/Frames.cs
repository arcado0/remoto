using System.Buffers.Binary;
using System.Text.Json;

namespace Remoto.Service;

/// <summary>
/// Messaggi sulla named pipe: [lunghezza u32 LE][tipo u8][dati]. Tipo 1 = JSON UTF-8, tipo 2 = binario
/// (segue sempre un JSON che lo descrive, scritti insieme sotto lo stesso lock).
/// </summary>
internal sealed class Frames
{
    public const byte Json = 1;
    public const byte Binary = 2;
    private const int MaxFrame = 64 * 1024 * 1024;

    private readonly Stream stream;
    private readonly object writeGate = new();

    public Frames(Stream stream)
    {
        this.stream = stream;
    }

    /// <summary>Legge un messaggio; null a fine flusso.</summary>
    public (byte Type, byte[] Data)? Read()
    {
        var header = new byte[5];
        if (!ReadExact(header)) return null;
        int length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length < 0 || length > MaxFrame) throw new InvalidDataException("messaggio troppo grande");
        var data = new byte[length];
        if (!ReadExact(data)) return null;
        return (header[4], data);
    }

    private bool ReadExact(byte[] buffer)
    {
        int read = 0;
        while (read < buffer.Length)
        {
            int n = stream.Read(buffer, read, buffer.Length - read);
            if (n <= 0) return false;
            read += n;
        }
        return true;
    }

    private void WriteFrame(byte type, ReadOnlySpan<byte> data)
    {
        Span<byte> header = stackalloc byte[5];
        BinaryPrimitives.WriteInt32LittleEndian(header, data.Length);
        header[4] = type;
        stream.Write(header);
        stream.Write(data);
    }

    public void SendJson(Action<Utf8JsonWriter> build, ReadOnlySpan<byte> binary = default, bool withBinary = false)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            build(w);
            w.WriteEndObject();
        }
        lock (writeGate)
        {
            WriteFrame(Json, ms.ToArray());
            if (withBinary) WriteFrame(Binary, binary);
            stream.Flush();
        }
    }
}
