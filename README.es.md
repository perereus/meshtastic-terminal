# Meshtastic Terminal

*[English version](README.md)*

Cliente de escritorio para redes [Meshtastic](https://meshtastic.org), con
estética de terminal fosforescente. Windows, construido con Tauri 2, React 19 y
TypeScript.

Se conecta a un nodo por **serie (USB)**, **BLE** o **TCP**, y guarda en SQLite
local todo lo que oye: mensajes, telemetría, traceroutes, vecinos y escuchas.
Ese historial local es la diferencia de fondo con las apps oficiales, que
muestran el estado actual de la malla y poco más: aquí la malla tiene memoria,
y sobre esa memoria se construye casi todo lo que sigue.

---

## Lo que no vas a encontrar en otros clientes

### Previsión de autonomía de batería

En vez de avisar cuando la batería ya está al 20 %, ajusta una **regresión
lineal por mínimos cuadrados** sobre las últimas 6 horas de descarga y dice
cuándo se agota: *"SE AGOTA EN ~35 h"*. Con un día de margen todavía puedes
hacer algo.

Detalles que hacen que la cifra signifique algo:

- **Ventana corta a propósito.** Un nodo solar sube de día y baja de noche;
  ajustar sobre varios días daría pendiente ~0 y una previsión inútil. Con 6 h
  se predice el tramo actual, que es lo accionable.
- **Calcula el R² y se calla si es malo.** Si la serie no sigue una recta,
  muestra *"BATERÍA IRREGULAR · sin previsión fiable"* en lugar de un número
  inventado. Una previsión mal ajustada es peor que ninguna.
- **Descarta los valores > 100 %**, que en Meshtastic significan alimentación
  externa y falsearían la pendiente.

### Alertas predictivas, no solo de umbral

Las alertas clásicas (batería baja, nodo sin señal) están, pero se suma una que
dispara sobre la **previsión**: avisa cuando a un nodo favorito le quedan menos
de N horas de autonomía. Solo vigila los nodos marcados con ★ —con ~100 nodos
en la malla, avisar de todos sería ruido— y aplica un antirrepetición de 6 h por
nodo y motivo.

### Grafo de la malla

Reconstruye la topología combinando dos fuentes: los paquetes **NeighborInfo**
(enlace directo real, línea continua) y los tramos deducidos de los
**traceroutes** guardados (línea discontinua). Cuando un par aparece por ambas
vías gana NeighborInfo, que mide el enlace y no una ruta.

El dibujo usa un layout dirigido por fuerzas **Fruchterman-Reingold** con
repulsión k²/d y atracción d²/k, temperatura que se enfría y escalado final
para encajar en el lienzo. El grosor y la opacidad de cada enlace salen del
SNR. Pulsando un nodo se aíslan sus enlaces y se listan sus vecinos ordenados
por calidad.

### Mapa de actividad temporal

Una rejilla de nodos × horas donde cada celda se ilumina según cuánto se oyó
ese nodo esa hora. Enseña patrones que de otro modo son invisibles: el nodo que
solo aparece de noche, el repetidor que calló el martes, el que va a rachas.

Se apoya en una tabla de escuchas propia (contador por nodo y hora) porque la
telemetría no sirve de prueba de vida: en una malla real la envían unos pocos
nodos. Al registrar solo con la radio ya configurada, el volcado inicial de la
NodeDB no se confunde con actividad real.

### Detección de cambios de topología

Cuando un nodo cambia de distancia —de directo a dos saltos, por ejemplo— se
registra el cambio, se anota en el log y, si es favorito, se notifica. Es la
señal temprana de que un repetidor ha caído o de que alguien ha movido una
antena. Solo se guardan los cambios, no el valor de cada paquete, así que la
tabla queda minúscula.

### Historial de traceroutes

El traceroute no es un resultado de usar y tirar: cada ejecución se guarda con
su ruta, sus SNR por tramo y su fecha, y el detalle del nodo muestra la serie
completa. Sirve para ver cómo cambia la ruta a un nodo a lo largo de los días.

### Otros detalles poco habituales

- **Configuración de canales completa**: rol, PSK con generador AES-256,
  uplink/downlink MQTT, silencio y precisión de posición por canal, con los
  mismos escalones que la app oficial. Importa y exporta URLs
  `meshtastic.org/e/#…`.
- **Avisos de las restricciones del firmware** donde suelen morder: NeighborInfo
  exige un intervalo mínimo de 4 h y su emisión por LoRa no funciona en canales
  con nombre y clave por defecto. La interfaz lo dice en vez de dejar que el
  cambio se rechace en silencio.
- **Backup completo a JSON** de la configuración del nodo, canales con PSK
  incluidos, y restauración desde archivo.
- **Bandeja del sistema**: cerrar la ventana no cierra la app, que sigue
  registrando lo que oye la malla.
- **Bilingüe (ES/EN), autodetectado** según el idioma del sistema, hasta el log
  de diagnóstico: las líneas del log se guardan sin traducir (clave + argumentos)
  y se pintan en el idioma actual, así que el panel DEBUG y el pie se retraducen
  en vivo al cambiar de idioma, como el resto de la interfaz. Un self-check
  recorre las llamadas de traducción del código —incluidas las del log— y falla
  si alguna cadena no está en el diccionario, porque una clave sin traducir cae
  al español en silencio.
- **Reloj de 12/24 h**, siguiendo el locale del sistema o forzado a uno u otro.
- **Cinco temas de color** sobrios; el color se propaga a las gráficas, al grafo
  de malla e incluso a las teselas del mapa, no solo a los marcadores.
- **Modo de alto contraste** sobre cualquiera de los temas: fondo negro puro,
  color principal a saturación plena, bordes y texto atenuado más marcados, y
  fuera el velo CRT —las scanlines apagan un 16 % de las filas y la viñeta
  oscurece los bordes—, que es de donde sale la mayor parte de la ganancia. Un
  self-check comprueba que los cinco temas llegan a AAA (7:1) sin virar de tono.
- **Idioma, tema y hora se aplican en caliente** — sin recargar, así que
  cambiarlos nunca corta la conexión con la radio.
- **Barra de título propia** con minimizar, maximizar, pantalla completa y cerrar.
- **Purga automática opcional** al arrancar, con retención configurable.

---

## Pantallas

- **CHAT** — canales y mensajes directos, estado de envío (en cola / enviado /
  entregado / fallo) con reintento, separadores de día entre mensajes, búsqueda
  sobre todo el historial que salta a la conversación del resultado, y limpieza
  por conversación (con confirmación en dos pasos) junto al exportar a texto.
- **NODOS** — lista ordenable y filtrable, detalle con traceroute e historial,
  previsión de batería, distancia a tu nodo junto a cada posición GPS, petición
  de posición, favoritos, ignorados, y reboot y apagado remotos por canal admin.
- **MAPA** — nodos y waypoints sobre OpenStreetMap. El firmware reduce la
  precisión de las posiciones, así que los nodos que comparten coordenada se
  agrupan en un marcador con su lista.
- **MALLA** — resumen de la red (activos en 1 h y 24 h, reparto de saltos,
  favoritos callados, batería baja) más las vistas de grafo y de actividad.
- **TELEMETRÍA** — gráficas con rangos de 6 h a 30 días, **comparación de varios
  nodos en la misma gráfica** (alineando series que no comparten instantes de
  muestreo) y exportación a CSV.
- **CONFIG** — usuario, LoRa, dispositivo, canales, módulos, posición fija,
  backup y mantenimiento de la base.

Atajos: `Ctrl+1…7` para las pestañas, `Ctrl+F` para buscar.

## Desarrollo

```bash
npm install
npm run tauri dev     # app con recarga en caliente
npm test              # self-checks (canales, grafo, alertas, batería, i18n)
npm run build         # frontend + comprobación de tipos
```

Hace falta el [entorno de Rust para Tauri](https://tauri.app/start/prerequisites/).

La lógica que se puede probar sin hardware vive en módulos puros
(`mesh.ts`, `alerts.ts`, `battery.ts`, `channelUrl.ts`) con self-checks que
corren con el runner nativo de Node, sin frameworks.

## Compilar el instalador

```bash
npm run tauri build
```

Deja dos paquetes en `src-tauri/target/release/bundle/`:

- `nsis/Meshtastic Terminal_<versión>_x64-setup.exe` — instalador normal
- `msi/Meshtastic Terminal_<versión>_x64_en-US.msi` — para despliegue

## Dónde vive la base de datos

En la carpeta de datos de la app (`%APPDATA%/com.pere.meshtastic-client`). El
identificador de la app decide esa ruta: cambiarlo deja el historial anterior
huérfano. La app instalada y la de desarrollo comparten esa misma base.

## Licencia

MIT — ver [LICENSE](LICENSE).

La fuente JetBrains Mono va empaquetada bajo la OFL; ver
`src/assets/fonts/OFL.txt`.
