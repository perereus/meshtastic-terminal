import en from "./locales/en";

/** i18n mínimo: la clave ES el texto en español; en.ts mapea es→en.
 *  Añadir idioma = un archivo más y una rama en t(). Sin dependencias. */

export type Lang = "es" | "en";

const LANG_KEY = "lang";

export function getLang(): Lang {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === "es" || saved === "en") return saved;
  return navigator.language.startsWith("es") ? "es" : "en";
}

export function setLang(l: Lang): void {
  localStorage.setItem(LANG_KEY, l);
  // ponytail: recarga en vez de re-render reactivo; cambiar idioma es
  // excepcional y así ningún componente necesita suscribirse
  location.reload();
}

// una sola lectura por carga de página (el cambio de idioma recarga)
const lang = getLang();

/** t("texto en español") · t("hace {0}", x) para interpolar */
export function t(es: string, ...args: (string | number)[]): string {
  let s = lang === "en" ? (en[es] ?? es) : es;
  args.forEach((a, i) => {
    s = s.replace(`{${i}}`, String(a));
  });
  return s;
}
