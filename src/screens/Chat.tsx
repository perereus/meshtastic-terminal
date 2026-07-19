import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { clearUnread, getSnapshot, subscribe } from "../store";
import { retryMessage, sendText } from "../radio";
import { saveText, stamp } from "../export";

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
  const endRef = useRef<HTMLDivElement>(null);

  const msgs = s.messages.filter((m) => m.convo === convo);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs.length]);

  // Al ver una conversación (o llegar mensaje mientras está abierta), sin leer=0
  useEffect(() => {
    clearUnread(convo);
  }, [convo, msgs.length]);

  const channelConvos = [...s.channels.values()]
    .filter((c) => c.role !== 0)
    .map((c) => ({ key: `ch:${c.index}`, label: `#${c.name}` }));
  if (channelConvos.length === 0) {
    channelConvos.push({ key: "ch:0", label: "#Principal" });
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
      ? "YO"
      : (s.nodes.get(num)?.shortName ?? num.toString(16).slice(-4));

  const convoLabel =
    [...channelConvos, ...dmConvos].find((c) => c.key === convo)?.label ?? convo;

  const onSend = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setError("");
    try {
      await sendText(text, convo);
    } catch (e) {
      setError(`FALLO TX: ${e}`);
    }
  };

  return (
    <main>
      <div className="panel" style={{ width: 230, flexShrink: 0 }}>
        <div className="panel-title">PANEL // CANALES</div>
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
          MENSAJES DIRECTOS
        </div>
        <div style={{ padding: "8px 0" }}>
          {dmConvos.length === 0 && (
            <div className="convo-item dim" style={{ cursor: "default" }}>
              <span>— ninguno —</span>
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
                <span title="cifrado extremo a extremo (PKI)"> 🔒 PKI</span>
              ) : (
                <span
                  className="warn"
                  title="sin clave pública: va cifrado sólo con la PSK del canal"
                >
                  {" "}
                  ⚠ SIN PKI
                </span>
              ))}
          </span>
          <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button
              style={{ fontSize: 10, padding: "0 6px" }}
              title="Exportar esta conversación a un archivo de texto"
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
                  setError(path ? `EXPORTADO → ${path}` : "");
                } catch (e) {
                  setError(`FALLO EXPORT: ${e}`);
                }
              }}
            >
              ⭳ EXPORTAR
            </button>
            {s.nodes.size} NODOS EN ESCUCHA
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
              ──── SIN MENSAJES EN {convoLabel} — AWAITING SIGNAL_ ────
            </div>
          )}
          {msgs.map((m) => (
            <div
              key={`${m.id}-${m.ts}`}
              className={m.mine ? `msg-mine ${m.state === "failed" ? "failed" : ""}` : ""}
            >
              <span className="dim">[{ts(m.ts)}]</span>{" "}
              <span
                className={m.mine ? "" : "warn"}
                style={m.mine ? { fontWeight: 700 } : undefined}
              >
                &lt;{nodeShort(m.from)}&gt;
              </span>{" "}
              {m.text}{" "}
              {m.mine && m.state === "queued" && (
                <span className="warn">⧗ en cola</span>
              )}
              {m.mine && m.state === "sent" && (
                <span className="dim">➤ enviado a radio</span>
              )}
              {m.mine && m.state === "delivered" && (
                <span className="dim">✓ entregado</span>
              )}
              {m.mine && m.state === "failed" && (
                <>
                  <span className="err">✗ fallo</span>{" "}
                  <button
                    style={{ fontSize: 10, padding: "0 6px" }}
                    title="Reintentar envío"
                    onClick={() => retryMessage(m).catch(() => {})}
                  >
                    ↻ REINTENTAR
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
            placeholder="escribe un mensaje_"
          />
          <span className="cursor">█</span>
          <span className="dim" style={{ fontSize: 11 }}>
            ENTER=TX · {Math.max(0, 200 - new TextEncoder().encode(draft).length)} B
            LIBRES
          </span>
        </div>
      </div>
    </main>
  );
}
