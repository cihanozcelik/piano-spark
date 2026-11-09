using System;
using System.Linq;
using System.Numerics;
using System.Security.Cryptography;

namespace PianoSpark
{
    /// <summary>
    /// Ed25519 signature verification (RFC 8032 section 5.1.7), for the same release
    /// signing key the Mac updater trusts. .NET Framework has no Ed25519; this is the
    /// RFC's reference algorithm. It verifies one small update feed, so speed is irrelevant.
    /// </summary>
    static class Ed25519
    {
        static readonly BigInteger P = BigInteger.Pow(2, 255) - 19;
        static readonly BigInteger Q = BigInteger.Pow(2, 252) + BigInteger.Parse("27742317777372353535851937790883648493");
        static readonly BigInteger D = Mod(-121665 * Inverse(121666));
        static readonly BigInteger SqrtMinusOne = BigInteger.ModPow(2, (P - 1) / 4, P);
        static readonly BigInteger[] G = Base();

        static BigInteger Mod(BigInteger value) { var result = value % P; return result.Sign < 0 ? result + P : result; }
        static BigInteger Inverse(BigInteger value) => BigInteger.ModPow(Mod(value), P - 2, P);
        static BigInteger Little(byte[] bytes) => new BigInteger(bytes.Concat(new byte[] { 0 }).ToArray());

        static BigInteger[] Base()
        {
            var y = Mod(4 * Inverse(5));
            var x = RecoverX(y, 0).Value;
            return new[] { x, y, BigInteger.One, Mod(x * y) };
        }

        static BigInteger[] Add(BigInteger[] p, BigInteger[] q)
        {
            var a = Mod((p[1] - p[0]) * (q[1] - q[0]));
            var b = Mod((p[1] + p[0]) * (q[1] + q[0]));
            var c = Mod(2 * p[3] * q[3] * D);
            var d = Mod(2 * p[2] * q[2]);
            BigInteger e = b - a, f = d - c, g = d + c, h = b + a;
            return new[] { Mod(e * f), Mod(g * h), Mod(f * g), Mod(e * h) };
        }

        static BigInteger[] Multiply(BigInteger scalar, BigInteger[] point)
        {
            var result = new[] { BigInteger.Zero, BigInteger.One, BigInteger.One, BigInteger.Zero };
            while (scalar.Sign > 0)
            {
                if (!scalar.IsEven) result = Add(result, point);
                point = Add(point, point);
                scalar >>= 1;
            }
            return result;
        }

        static bool Equal(BigInteger[] p, BigInteger[] q) =>
            Mod(p[0] * q[2] - q[0] * p[2]).IsZero && Mod(p[1] * q[2] - q[1] * p[2]).IsZero;

        static BigInteger? RecoverX(BigInteger y, int sign)
        {
            if (y >= P) return null;
            var x2 = Mod((y * y - 1) * Inverse(D * y * y + 1));
            if (x2.IsZero) return sign == 0 ? BigInteger.Zero : (BigInteger?)null;
            var x = BigInteger.ModPow(x2, (P + 3) / 8, P);
            if (!Mod(x * x - x2).IsZero) x = Mod(x * SqrtMinusOne);
            if (!Mod(x * x - x2).IsZero) return null;
            if ((int)(x & 1) != sign) x = P - x;
            return x;
        }

        static BigInteger[] Decompress(byte[] bytes)
        {
            if (bytes.Length != 32) return null;
            var copy = (byte[])bytes.Clone();
            var sign = copy[31] >> 7;
            copy[31] &= 0x7F;
            var y = Little(copy);
            var x = RecoverX(y, sign);
            return x.HasValue ? new[] { x.Value, y, BigInteger.One, Mod(x.Value * y) } : null;
        }

        public static bool Verify(byte[] publicKey, byte[] message, byte[] signature)
        {
            if (publicKey == null || signature == null || publicKey.Length != 32 || signature.Length != 64) return false;
            var a = Decompress(publicKey);
            var r = Decompress(signature.Take(32).ToArray());
            if (a == null || r == null) return false;
            var s = Little(signature.Skip(32).ToArray());
            if (s >= Q) return false;
            byte[] digest;
            using (var sha = SHA512.Create()) digest = sha.ComputeHash(signature.Take(32).Concat(publicKey).Concat(message).ToArray());
            var h = Little(digest) % Q;
            return Equal(Multiply(s, G), Add(r, Multiply(h, a)));
        }

        static byte[] Hex(string text) =>
            Enumerable.Range(0, text.Length / 2).Select(i => Convert.ToByte(text.Substring(i * 2, 2), 16)).ToArray();

        /// <summary>RFC 8032 test vectors 1 and 2, valid and tampered.</summary>
        public static bool SelfTest()
        {
            var vectors = new[]
            {
                ("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
                 "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
                ("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
                 "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
            };
            foreach (var (key, message, signature) in vectors)
            {
                if (!Verify(Hex(key), Hex(message), Hex(signature))) return false;
                if (Verify(Hex(key), Hex(message).Concat(new byte[] { 1 }).ToArray(), Hex(signature))) return false;
            }
            return true;
        }
    }
}
