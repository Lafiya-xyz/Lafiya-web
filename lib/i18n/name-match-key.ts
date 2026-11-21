/**
 * Issue #927: locale-aware, diacritic-insensitive name handling.
 *
 * Nigerian names are routinely written with tonal marks and diacritics
 * ("Ọlá", "Adébáyọ̀", "Ngozi Ụzọma"). Search, sorting and duplicate detection
 * must treat those spellings as the same name as their unmarked forms.
 *
 * Two primitives live here:
 *   - `nameMatchKey` — the NFC-normalized, diacritic-stripped, case-folded
 *     form stored in `profiles.name_match_key` (Postgres trigger) and used
 *     for duplicate detection. It is deliberately lossy and never displayed.
 *   - `compareNames` — an `Intl.Collator`-backed comparator for UI sorting,
 *     so "Ọlá" sorts next to "Ola" rather than after "Z".
 */

/** Locales whose collation rules cover the names this app stores. */
export const NAME_SORT_LOCALES: readonly string[] = ["ig", "yo", "ha", "en-NG"];

/**
 * NFC-normalized, diacritic-insensitive, case-folded match key.
 *
 * NFC first so precomposed and decomposed spellings agree, then NFD so the
 * combining marks can be dropped, then case folding and whitespace collapse.
 * Returns "" for input that carries no letters or digits.
 */
export function nameMatchKey(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .normalize("NFC")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when two spellings of a name share a match key. */
export function namesMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = nameMatchKey(left);
  return a !== "" && a === nameMatchKey(right);
}

const collators = new Map<string, Intl.Collator>();

function collatorFor(locale: string): Intl.Collator {
  const cached = collators.get(locale);
  if (cached) return cached;
  const collator = new Intl.Collator(locale, {
    usage: "sort",
    sensitivity: "base",
    numeric: true,
    ignorePunctuation: true,
  });
  collators.set(locale, collator);
  return collator;
}

/**
 * Locale-aware name comparator for UI lists. Falls back to the default
 * locale when the requested one is not a valid BCP-47 tag.
 */
export function compareNames(
  left: string,
  right: string,
  locale: string = NAME_SORT_LOCALES[0],
): number {
  let collator: Intl.Collator;
  try {
    collator = collatorFor(Intl.getCanonicalLocales(locale)[0] ?? locale);
  } catch {
    collator = collatorFor(NAME_SORT_LOCALES[0]);
  }
  return collator.compare(left, right);
}

/** Sorts a copy of `items` by `select(item)` using `compareNames`. */
export function sortByLocaleName<T>(
  items: readonly T[],
  select: (item: T) => string,
  locale?: string,
): T[] {
  return [...items].sort((a, b) => compareNames(select(a), select(b), locale));
}
