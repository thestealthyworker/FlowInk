// Constant-time secret comparison.
//
// `a !== b` on a secret leaks two things to anyone who can time the
// endpoint: the length of the expected value, and how many leading
// characters of a guess were correct. Digesting both sides first makes
// the comparison fixed-width (32 bytes) regardless of input length, and
// the XOR accumulator makes it take the same time whether byte 0 or byte
// 31 differs.

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

/** Constant-time equality for secrets. Leaks neither length nor prefix. */
export async function secretEquals(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) {
    diff |= da[i] ^ db[i];
  }
  return diff === 0;
}
