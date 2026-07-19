import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { clearUnread, getSnapshot, subscribe } from "../store";
import { retryMessage, sendText } from "../radio";
import { saveText, stamp } from "../export";
import { t } from "../i18n";

// en resultados de búsqueda la hora sola no basta: pueden ser de otro día
function fecha(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}`;
}

function ts(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function Chat({
  convo,
  setConvo,
}: {
  convo: string;
  setConvo: (c: string) => void;
}) {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  // Buscar recorre TODAS las conversaciones: encontrar un mensaje viejo suele
  // importar más que en qué canal estaba. Cada resultado dice de dónde sale.
  const q = search.trim().toLowerCase();
  const msgs = q
    ? s.messages.filter((m) => m.text.toLowerCase().includes(q))
    : s.messages.filter((m) => m.convo === convo);

  useEffect(() => {
    if (!q) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs.length, q]);

  // Al ver una conversación (o llegar mensaje mientras está abierta), sin leer=0
  useEffect(() => {
    clearUnread(convo);
  }, [convo, msgs.length]);

  const channelConvos = [...s.channels.values()]
    .filter((c) => c.role !== 0)
    .map((c) => ({ key: `ch:${c.index}`, label: `#${c.name}` }));
  if (channelConvos.length === 0) {
    channelConvos.push({ key: "ch:0", label: t("#Principal") });
  }
  const dmKeys = new Set(
    s.messages.filter((m) => m.convo.startsWith("dm:")).map((m) => m.convo),
  );
  if (convo.startsWith("dm:")) dmKeys.add(convo);
  const dmConvos = [...dmKeys].map((key) => {
    const num = Number(key.slice(3));
    return { key, label: `@${s.nodes.get(num)?.shortName ?? num.toString(16)}` };
  });

  const nodeShort = (num: number) =>
    num === s.myNodeNum
      ? t("YO")
      : (s.nodes.get(num)?.shortName ?? num.toString(16).slice(-4));

  const labelOf = (key: string) =>
    [...channelConvos, ...dmConvos].find((c) => c.key === key)?.label ??
    (key.startsWith("dm:")
      ? `@${s.nodes.get(Number(key.slice(3)))?.shortName ?? key.slice(3)}`
      : key);
  const convoLabel = labelOf(convo);

  const onSend = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setError("");
    try {
      await sendText(text, convo);
    } catch (e) {
      setError(t("FALLO TX: {0}", String(e)));
    }
  };

  return (
    <main>
      <div className="panel" style={{ width: 230, flexShrink: 0 }}>
        <div className="panel-title">{t("PANEL // CANALES")}</div>
        <div style={{ padding: "8px 0" }}>
          {channelConvos.map((c) => (
            <div
              key={c.key}
              className={`convo-item ${c.key === convo ? "active" : ""}`}
              onClick={() => setConvo(c.key)}
            >
              <span>{c.label}</span>
              {(s.unread.get(c.key) ?? 0) > 0 && (
                <span className="unread-badge">{s.unread.get(c.key)}</span>
              )}
            </div>
          ))}
        </div>
        <div className="panel-title" style={{ borderTop: "1px solid var(--border)" }}>
          {t("MENSAJES DIRECTOS")}
        </div>
        <div style={{ padding: "8px 0" }}>
          {dmConvos.length === 0 && (
            <div className="convo-item dim" style={{ cursor: "default" }}>
              <span>{t("— ninguno —")}</span>
            </div>
          )}
          {dmConvos.map((c) => (
            <div
              key={c.key}
              className={`convo-item ${c.key === convo ? "active" : ""}`}
              onClick={() => setConvo(c.key)}
            >
              <span>{c.label}</span>
              {(s.unread.get(c.key) ?? 0) > 0 && (
                <span className="unread-badge">{s.unread.get(c.key)}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="panel" style={{ flex: 1, minWidth: 0 }}>
        <div className="panel-title">
          <span>
            PANEL // CHAT · {convoLabel}
            {convo.startsWith("dm:") &&
              (s.nodes.get(Number(convo.slice(3)))?.hasKey ? (
                <span title={t("cifrado extremo a extremo (PKI)")}> 🔒 PKI</span>
              ) : (
                <span
                  className="warn"
                  title={t("sin clave pública: va cifrado sólo con la PSK del canal")}
                >
                  {" "}
                  {t("⚠ SIN PKI")}
                </span>
              ))}
          </span>
          <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("buscar en todo el historial_")}
              style={{ width: 190, fontSize: 11 }}
            />
            <button
              style={{ fontSize: 10, padding: "0 6px" }}
              title={t("Exportar esta conversación a un archivo de texto")}
              disabled={msgs.length === 0}
              onClick={async () => {
                try {
                  const path = await saveText(
                    `meshtastic-${convo.replace(":", "-")}-${stamp()}.txt`,
                    msgs
                      .map(
                        (m) =>
                          `${new Date(m.ts).toISOString()} [${convoLabel}] <${nodeShort(m.from)}> ${m.text}${m.mine ? ` (${m.state})` : ""}`,
                      )
                      .join("\n"),
                  );
                  setError(path ? t("EXPORTADO → {0}", path) : "");
                } catch (e) {
                  setError(t("FALLO EXPORT: {0}", String(e)));
                }
              }}
            >
              {t("⭳ EXPORTAR")}
            </button>
            {t("{0} NODOS EN ESCUCHA", s.nodes.size)}
          </span>
        </div>
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          {msgs.length === 0 && (
            <div className="dim" style={{ fontSize: 11 }}>
              {q
                ? t('SIN RESULTADOS PARA "{0}"_', search)
                : t("──── SIN MENSAJES EN {0} — AWAITING SIGNAL_ ────", convoLabel)}
            </div>
          )}
          {q && msgs.length > 0 && (
            <div className="dim" style={{ fontSize: 11, marginBottom: 4 }}>
              {t("{0} RESULTADOS · CLIC PARA IR A LA CONVERSACIÓN", msgs.length)}
            </div>
          )}
          {msgs.map((m) => (
            <div
              key={`${m.id}-${m.ts}`}
              className={m.mine ? `msg-mine ${m.state === "failed" ? "failed" : ""}` : ""}
              style={q ? { cursor: "pointer" } : undefined}
              onClick={
                q
                  ? () => {
                      setConvo(m.convo);
                      setSearch("");
                    }
                  : undefined
              }
            >
              {q && (
                <>
                  <span className="dim">{fecha(m.ts)}</span>{" "}
                  <span className="warn">{labelOf(m.convo)}</span>{" "}
                </>
              )}
              <span className="dim">[{ts(m.ts)}]</span>{" "}
              <span
                className={m.mine ? "" : "warn"}
                style={m.mine ? { fontWeight: 700 } : undefined}
              >
                &lt;{nodeShort(m.from)}&gt;
              </span>{" "}
              {m.text}{" "}
              {m.mine && m.state === "queued" && (
                <span className="warn">{t("⧗ en cola")}</span>
              )}
              {m.mine && m.state === "sent" && (
                <span className="dim">{t("➤ enviado a radio")}</span>
              )}
              {m.mine && m.state === "delivered" && (
                <span className="dim">{t("✓ entregado")}</span>
              )}
              {m.mine && m.state === "failed" && (
                <>
                  <span className="err">{t("✗ fallo")}</span>{" "}
                  <button
                    style={{ fontSize: 10, padding: "0 6px" }}
                    title={t("Reintentar envío")}
                    onClick={() => retryMessage(m).catch(() => {})}
                  >
                    {t("↻ REINTENTAR")}
                  </button>
                </>
              )}
            </div>
          ))}
          <div ref={endRef} />
        </div>
        {error && <p className="error">{error}</p>}
        <div className="chat-input">
          <span className="prompt">&gt;</span>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSend()}
            placeholder={t("escribe un mensaje_")}
          />
          <span className="cursor">█</span>
          <span className="dim" style={{ fontSize: 11 }}>
            {t(
              "ENTER=TX · {0} B LIBRES",
              Math.max(0, 200 - new TextEncoder().encode(draft).length),
            )}
          </span>
        </div>
      </div>
    </main>
  );
}
