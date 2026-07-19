import en from "./locales/en";

/** Minimal i18n: the key IS the Spanish text; en.ts maps es→en.
 *  Adding a language = one more file and one branch in t(). No dependencies. */

export type Lang = "es" | "en";

const LANG_KEY = "lang";

export function getLang(): Lang {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === "es" || saved === "en") return saved;
  return navigator.language.startsWith("es") ? "es" : "en";
}

export function setLang(l: Lang): void {
  localStorage.setItem(LANG_KEY, l);
  // ponytail: reload instead of a reactive re-render; changing language is
  // exceptional, and this way no component needs to subscribe
  location.reload();
}

// a single read per page load (changing the language reloads)
const lang = getLang();

/** t("texto en español") · t("hace {0}", x) to interpolate */
export function t(es: string, ...args: (string | number)[]): string {
  let s = lang === "en" ? (en[es] ?? es) : es;
  args.forEach((a, i) => {
    s = s.replace(`{${i}}`, String(a));
  });
  return s;
}
