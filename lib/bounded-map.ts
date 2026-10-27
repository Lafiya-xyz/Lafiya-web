/**
 * A Map with a hard entry cap for module-level caches and counters that live
 * for the whole lifetime of a warm instance. When full, the oldest-inserted
 * entry is evicted (Map preserves insertion order), so memory stays flat no
 * matter how many distinct keys an instance sees. Re-setting an existing key
 * refreshes its position so hot keys are evicted last.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(readonly maxEntries: number) {
    super();
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("BoundedMap maxEntries must be a positive integer");
    }
  }

  override set(key: K, value: V): this {
    if (this.has(key)) this.delete(key);
    super.set(key, value);
    if (this.size > this.maxEntries) {
      const oldest = this.keys().next();
      if (!oldest.done) this.delete(oldest.value);
    }
    return this;
  }
}
