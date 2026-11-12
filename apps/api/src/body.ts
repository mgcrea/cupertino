/**
 * A request body as text, or null once it is larger than `max` bytes.
 *
 * Both public POST routes used to check the declared Content-Length, then call
 * `request.text()`, then compare the string's `length`. Two holes in that. A
 * chunked upload declares no length, so the first check read "0" and passed, and
 * `text()` buffered the whole body before anything measured it: a stranger still
 * decided how much this Worker allocated, up to Cloudflare's own request limit.
 * And `length` counts UTF-16 units, not bytes, so a body of two-byte characters
 * got through at twice the cap.
 *
 * So the declared size is still refused first, before a byte is read, and the
 * body is then read chunk by chunk, counting bytes as they arrive. Past `max`
 * the stream is cancelled, which tells the runtime to stop receiving it, and the
 * caller gets null. At most `max` plus one chunk is ever held.
 */
export const readCapped = async (request: Request, max: number): Promise<string | null> => {
  if (Number(request.headers.get("content-length") ?? "0") > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel("body too large");
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};
