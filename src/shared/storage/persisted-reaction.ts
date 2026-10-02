import { reaction } from "mobx";

/** Coalesce observable reads as well as writes; flush the current value on exit. */
export function createPersistedReaction<T>(read: () => T, write: (value: T) => void): () => void {
  let disposed = false;
  let previous = read();
  const persist = (value: T): void => {
    if (Object.is(value, previous)) return;
    write(value);
    previous = value;
  };
  // Compare against the last persisted value in persist(), including explicit
  // flushes between scheduled reads (for example, a page restored from bfcache).
  const dispose = reaction(read, persist, { delay: 150, equals: () => false });
  const flush = (): void => persist(read());
  if (typeof window !== "undefined") window.addEventListener("pagehide", flush);
  return () => {
    if (disposed) return;
    disposed = true;
    dispose();
    if (typeof window !== "undefined") window.removeEventListener("pagehide", flush);
    flush();
  };
}
